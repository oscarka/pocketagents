import { createHash } from 'node:crypto'
import {
  buildDynamicVoiceContext,
  computeDenyOptionIndex,
  encodePcm16ToWav,
  formatApprovalBriefingSpeech,
  formatPinForSpeech,
  sanitizeTextForVoiceBriefing,
} from './voice-copilot.js'

const DEFAULT_MAX_APPROVALS = 5
const DEFAULT_MAX_TASKS = 5
const MAX_ALLOWED_APPROVALS = 8
const MAX_ALLOWED_TASKS = 8

const ZH_CHAR_RE = /[\u4e00-\u9fff]/
const LATIN_WORD_RE = /[A-Za-z]{2,}/

// Per-approval async small-model localization cache (LRU, 10m TTL, 30s error backoff)
const SUMMARY_CACHE_MAX = 120
const SUMMARY_CACHE_TTL_MS = 10 * 60_000
const SUMMARY_ERROR_BACKOFF_MS = 30_000
const summaryCache = new Map()
const summaryInflight = new Map()

export function resetDeviceSummaryCache() {
  summaryCache.clear()
  summaryInflight.clear()
}

function compactLine(value, maxChars = 48) {
  const clean = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return ''
  const chars = [...clean]
  if (chars.length <= maxChars) return clean
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`
}

function hasChinese(text = '') {
  return ZH_CHAR_RE.test(String(text || ''))
}

function localizeToolNameZh(rawTool = '', kind = 'approval') {
  const t = String(rawTool || '').trim()
  const lower = t.toLowerCase()
  if (kind === 'question' || lower === 'ask_question' || lower === 'ask_user_question' || lower === 'question') {
    return '请你选择'
  }
  if (lower === 'bash' || lower === 'run_command' || lower === 'shell' || lower === 'terminal' || lower === 'exec') {
    return '终端命令'
  }
  if (lower === 'edit' || lower === 'edit_file' || lower === 'replace_file_content' || lower === 'multi_replace_file_content') {
    return '修改代码'
  }
  if (lower === 'write' || lower === 'write_file' || lower === 'write_to_file') {
    return '写入文件'
  }
  if (lower === 'read' || lower === 'read_file' || lower === 'view_file') {
    return '读取文件'
  }
  if (lower.startsWith('browser') || lower.includes('upload')) {
    return '浏览器操作'
  }
  if (lower.startsWith('mcp_') || lower.startsWith('mcp:')) {
    return '插件工具'
  }
  if (!t) return '工具审批'
  return compactLine(t, 12)
}

function localizeOptionRuleZh(rawOpt = '') {
  const s = String(rawOpt || '').trim()
  if (!s || hasChinese(s)) return compactLine(s, 18)
  const lower = s.toLowerCase()
  if (/^(yes,?\s*)?(allow|approve)\s*(this\s*time|once)?$/.test(lower)) return '本次允许'
  if (/^always\s*allow|^allow\s*always/.test(lower)) return '总是允许'
  if (/^allow\s*(in\s*this\s*)?(chat|session|workspace)/.test(lower)) return '本会话允许'
  if (/^(no|deny|reject|decline)\b/.test(lower)) return '拒绝'
  if (/^cancel\b/.test(lower)) return '取消'
  if (/^skip\b/.test(lower)) return '跳过'
  return ''
}

function inferDeterministicCommandTitleZh({ cmd = '', title = '', tool = '', risk = 'L1' } = {}) {
  const blob = `${cmd} ${title}`.trim()
  const lower = blob.toLowerCase()
  if (risk === 'L2') {
    if (/\bgit\s+push\b.*(--force|-f\b)/.test(lower) && /\brm\s+-[a-z]*r/.test(lower)) {
      return '高危：删文件并强推代码'
    }
    if (/\bgit\s+push\b.*(--force|-f\b)/.test(lower)) return '高危：强制推送 Git 仓库'
    if (/\brm\s+-[a-z]*r|\brm\s+-rf/.test(lower)) return '高危：递归强制删除文件'
    if (/\bdrop\s+(table|database|schema)|\btruncate\b|\bdelete\s+from\b/.test(lower)) return '高危：删除/清空数据库'
    if (/\bsudo\b/.test(lower)) return '高危：管理员权限命令'
    if (/\bdeploy\b|\bterraform\b|\bkubectl\s+delete/.test(lower)) return '高危：生产环境变更'
    return '高危操作，请核对原文'
  }
  if (/\b(npm|pnpm|yarn)\s+test\b|\bnode\s+--test\b|\bpytest\b|\bvitest\b|\bjest\b|\bcargo\s+test\b|\bgo\s+test\b/.test(lower)) {
    return '运行自动化测试'
  }
  if (/\b(npm|pnpm|yarn)\s+run\s+build\b|\bvite\s+build\b|\btsc\b|\bidf\.py\s+build\b|\bcargo\s+build\b/.test(lower)) {
    return '执行项目构建'
  }
  if (/\b(npm|pnpm|yarn)\s+(install|add|i)\b|\bpip\s+install\b/.test(lower)) {
    return '安装项目依赖'
  }
  if (/\bgit\s+commit\b/.test(lower)) return '提交代码变更'
  if (/\bgit\s+push\b/.test(lower)) return '推送代码到远程'
  if (/\bgit\s+(status|diff|log|branch)\b/.test(lower)) return '查看 Git 状态'
  if (/\bdocker\s+/.test(lower)) return '执行容器命令'
  if (/\bcurl\b|\bwget\b/.test(lower)) return '发起网络请求'
  if (/upload/i.test(blob) && /browser/i.test(tool)) return '浏览器上传文件'
  if (tool.toLowerCase() === 'edit' || tool.toLowerCase() === 'edit_file') return '修改项目代码文件'
  if (tool.toLowerCase() === 'write' || tool.toLowerCase() === 'write_file') return '写入项目文件'
  return ''
}

function extractRawOptions(approval) {
  if (approval.kind === 'question' && Array.isArray(approval.questions) && approval.questions.length > 0) {
    const q0 = approval.questions[0]
    const rawOpts = Array.isArray(q0?.options) ? q0.options : []
    return rawOpts
      .slice(0, 4)
      .map((opt, idx) => {
        const label = typeof opt === 'string' ? opt : opt?.label || opt?.title || `Option ${idx + 1}`
        return compactLine(label, 28)
      })
      .filter(Boolean)
  }
  if (Array.isArray(approval.options) && approval.options.length > 0) {
    return approval.options
      .slice(0, 4)
      .map((opt, idx) => {
        const label = typeof opt === 'string' ? opt : opt?.label || opt?.title || `Option ${idx + 1}`
        return compactLine(label, 28)
      })
      .filter(Boolean)
  }
  return []
}

function extractQuestionPrompt(approval) {
  if (approval.kind === 'question' && Array.isArray(approval.questions) && approval.questions.length > 0) {
    const q0 = approval.questions[0]
    if (q0?.question) return compactLine(q0.question, 72)
  }
  return compactLine(approval.command || approval.promptTitle || approval.title || '', 72)
}

function normalizePositiveInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function pruneSummaryCache(nowMs) {
  for (const [k, entry] of summaryCache.entries()) {
    if (nowMs > entry.expiresAt) summaryCache.delete(k)
  }
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    const oldestKey = summaryCache.keys().next().value
    if (!oldestKey) break
    summaryCache.delete(oldestKey)
  }
}

/**
 * 3-Tier Practical Localization for an approval item:
 *   Tier 1 (0ms, $0): Already Chinese -> pass through untouched
 *   Tier 2 (0ms, $0): Deterministic rule map for common tools/commands/buttons
 *   Tier 3 (async, cached): BYOK small-model Chinese summary/options for complex English items
 * Always keeps raw `cmd` verbatim so dangerous commands are never masked.
 */
function localizeApprovalForDevice(approval, { lang = 'zh', voiceCopilot = null, nowMs = Date.now() } = {}) {
  const rawTitle = compactLine(approval.title || approval.promptTitle || approval.toolName || 'Pending approval', 44)
  const rawCmd = extractQuestionPrompt(approval)
  const rawOptions = extractRawOptions(approval)
  const rawTool = compactLine(approval.toolName || (approval.kind === 'question' ? 'question' : 'tool'), 20)
  const risk = approval.riskLevel || 'L1'
  const kind = approval.kind === 'question' ? 'question' : 'approval'

  if (lang === 'en') {
    return {
      tool: rawTool,
      title: rawTitle,
      cmd: rawCmd,
      options: rawOptions,
      zhSource: 'en',
    }
  }

  const toolZh = localizeToolNameZh(rawTool, kind)

  // Tier 1: Already Chinese -> 0ms pass-through, NEVER waste an LLM call
  const titleAlreadyZh = hasChinese(rawTitle)
  const optsAlreadyZh = rawOptions.length === 0 || rawOptions.every(o => hasChinese(o))
  if (titleAlreadyZh && optsAlreadyZh) {
    return {
      tool: toolZh,
      title: rawTitle,
      cmd: rawCmd,
      options: rawOptions,
      zhSource: 'native_zh',
    }
  }

  // Tier 2: Deterministic local rules (0ms, $0)
  const ruleTitle = titleAlreadyZh
    ? rawTitle
    : inferDeterministicCommandTitleZh({ cmd: rawCmd, title: rawTitle, tool: rawTool, risk })
  const ruleOptions = rawOptions.map(o => localizeOptionRuleZh(o) || o)
  const allOptionsLocalized = rawOptions.length === 0 || ruleOptions.every(o => hasChinese(o))

  const needsLlmTitle = !titleAlreadyZh && !ruleTitle && LATIN_WORD_RE.test(rawTitle)
  const needsLlmOptions = kind === 'question' && !allOptionsLocalized

  if (!needsLlmTitle && !needsLlmOptions) {
    return {
      tool: toolZh,
      title: compactLine(ruleTitle || rawTitle, 32),
      cmd: rawCmd,
      options: ruleOptions,
      zhSource: 'rule',
    }
  }

  // Tier 3: Async cached BYOK small-model translation (non-blocking!)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([rawTitle, rawCmd, rawOptions]))
    .digest('hex')
    .slice(0, 12)
  const cacheKey = `${approval.hostId}:${approval.code}:${fingerprint}`

  pruneSummaryCache(nowMs)
  const cached = summaryCache.get(cacheKey)
  if (cached && cached.ok) {
    // Safety invariant: L2 commands MUST retain explicit high-risk marker and verbatim cmd
    let finalTitle = cached.title || ruleTitle || rawTitle
    if (risk === 'L2' && !/高危|危险|强推|删|清空/.test(finalTitle)) {
      finalTitle = `高危：${finalTitle}`
    }
    return {
      tool: toolZh,
      title: compactLine(finalTitle, 32),
      cmd: rawCmd,
      options:
        cached.options && cached.options.length === rawOptions.length
          ? cached.options
          : ruleOptions,
      zhSource: 'llm_cache',
    }
  }

  // Trigger ONE deduplicated background small-model call if BYOK brain is available and not backed off
  const backedOff = Boolean(cached && !cached.ok && nowMs < cached.expiresAt)
  if (
    !backedOff &&
    !summaryInflight.has(cacheKey) &&
    voiceCopilot &&
    typeof voiceCopilot.summarizeDeviceApprovalZh === 'function' &&
    typeof voiceCopilot.resolveDeviceBrainStage === 'function' &&
    voiceCopilot.resolveDeviceBrainStage()
  ) {
    const promise = voiceCopilot
      .summarizeDeviceApprovalZh({
        title: rawTitle,
        cmd: rawCmd,
        tool: rawTool,
        kind,
        risk,
        options: kind === 'question' ? rawOptions : [],
      })
      .then(res => {
        const doneAt = Math.max(nowMs, voiceCopilot?.now?.() || Date.now())
        if (res?.ok) {
          summaryCache.set(cacheKey, {
            ok: true,
            title: res.title || '',
            options: Array.isArray(res.options) && res.options.length === rawOptions.length ? res.options : null,
            expiresAt: doneAt + SUMMARY_CACHE_TTL_MS,
          })
        } else {
          summaryCache.set(cacheKey, {
            ok: false,
            expiresAt: doneAt + SUMMARY_ERROR_BACKOFF_MS,
          })
        }
      })
      .catch(() => {
        const errAt = Math.max(nowMs, voiceCopilot?.now?.() || Date.now())
        summaryCache.set(cacheKey, {
          ok: false,
          expiresAt: errAt + SUMMARY_ERROR_BACKOFF_MS,
        })
      })
      .finally(() => {
        summaryInflight.delete(cacheKey)
      })
    summaryInflight.set(cacheKey, promise)
  }

  return {
    tool: toolZh,
    title: compactLine(ruleTitle || rawTitle, 36),
    cmd: rawCmd,
    options: ruleOptions,
    zhSource: 'pending_llm',
  }
}

/**
 * Wait for any active background Tier-3 localization promises (used in deterministic tests).
 */
export async function flushDeviceSummaryTasks() {
  if (summaryInflight.size === 0) return
  await Promise.allSettled([...summaryInflight.values()])
}

/**
 * Build a tiny (< 3 KB), deterministic, MCU-safe digest of current hosts, tasks,
 * and pending approvals. Reusable across FoloToy AI Passport, ESP32-S3 badges,
 * Apple Watch / Shortcuts, Stream Deck, and E-ink dashboards.
 */
export function buildDeviceDigest(
  hub,
  {
    maxApprovals = DEFAULT_MAX_APPROVALS,
    maxTasks = DEFAULT_MAX_TASKS,
    since = '',
    activeHostId = '',
    activeSessionId = '',
    lang = 'zh',
    voiceCopilot = null,
    nowMs = Date.now(),
  } = {},
) {
  const ctx = buildDynamicVoiceContext(hub, { activeHostId, activeSessionId })
  const approvalCap = normalizePositiveInt(maxApprovals, DEFAULT_MAX_APPROVALS, 1, MAX_ALLOWED_APPROVALS)
  const taskCap = normalizePositiveInt(maxTasks, DEFAULT_MAX_TASKS, 1, MAX_ALLOWED_TASKS)
  const effectiveLang = String(lang || 'zh').toLowerCase() === 'en' ? 'en' : 'zh'

  const hostsOnline = ctx.hosts.filter(h => h.online).length
  const hostsTotal = ctx.hosts.length
  const runningCount = ctx.tasks.filter(t => t.status === 'running').length
  const pendingCount = ctx.pendingApprovals.length

  const approvals = ctx.pendingApprovals.slice(0, approvalCap).map(a => {
    const loc = localizeApprovalForDevice(a, { lang: effectiveLang, voiceCopilot, nowMs })
    return {
      slot: a.slot,
      hostId: compactLine(a.hostId, 32),
      hostName: compactLine(a.hostName, 20),
      code: compactLine(a.code, 32),
      agentId: compactLine(a.agentId, 48),
      session: compactLine(a.sessionTitle || a.hostName, 26),
      kind: a.kind === 'question' ? 'question' : 'approval',
      tool: loc.tool,
      risk: a.riskLevel || 'L1',
      title: loc.title,
      cmd: loc.cmd,
      options: loc.options,
    }
  })

  const tasks = ctx.tasks.slice(0, taskCap).map(t => ({
    hostId: compactLine(t.hostId, 32),
    hostName: compactLine(t.hostName, 18),
    agentId: compactLine(t.agentId, 48),
    harness: compactLine(t.harness, 14),
    title: compactLine(t.title || t.projectName || t.agentId, 28),
    status: compactLine(t.status || 'idle', 12),
    pending: Boolean(t.hasPendingApproval),
  }))

  const corePayload = {
    summary: {
      hostsOnline,
      hostsTotal,
      running: runningCount,
      pending: pendingCount,
    },
    approvals,
    tasks,
  }

  const rev = createHash('sha256')
    .update(JSON.stringify(corePayload))
    .digest('hex')
    .slice(0, 10)

  const cleanSince = String(since || '').trim()
  if (cleanSince && cleanSince === rev) {
    return {
      ok: true,
      unchanged: true,
      rev,
      ts: nowMs,
    }
  }

  return {
    ok: true,
    unchanged: false,
    rev,
    ts: nowMs,
    ...corePayload,
  }
}

function findTargetApproval(ctx, { slot = 0, code = '', hostId = '' } = {}) {
  const cleanCode = String(code || '').trim().toUpperCase()
  const cleanHost = String(hostId || '').trim()
  const slotNum = Number(slot) || 0

  if (cleanCode) {
    const exact = ctx.pendingApprovals.find(
      a => a.code.toUpperCase() === cleanCode && (!cleanHost || a.hostId === cleanHost),
    )
    if (exact) return exact
  }
  if (slotNum >= 1) {
    const bySlot = ctx.pendingApprovals.find(a => a.slot === slotNum)
    if (bySlot) return bySlot
  }
  if (!cleanCode && slotNum === 0 && ctx.pendingApprovals.length === 1) {
    return ctx.pendingApprovals[0]
  }
  return null
}

/**
 * Execute an ultra-compact edge-device action (button tap, multi-choice pick,
 * stop, or quick prompt), enforcing the exact same L2 high-risk PIN safety guard
 * used by PocketAgents Voice Copilot.
 */
export function executeDeviceAction(
  hub,
  voiceCopilot,
  body = {},
  { deviceSessionId = 'device-default' } = {},
) {
  const type = String(body?.type || '').trim().toLowerCase()
  const ctx = buildDynamicVoiceContext(hub, {
    activeHostId: String(body?.hostId || ''),
    activeSessionId: String(body?.agentId || ''),
  })

  if (type === 'approve' || type === 'deny' || type === 'reject' || type === 'answer') {
    const approval = findTargetApproval(ctx, {
      slot: body?.slot,
      code: body?.code,
      hostId: body?.hostId,
    })
    if (!approval) {
      return {
        status: 404,
        json: {
          ok: false,
          error: ctx.pendingApprovals.length > 1
            ? '有多条待审批，请指定序号或单号'
            : '审批不存在或已处理',
          pending: ctx.pendingApprovals.length,
        },
      }
    }

    const isDeny = type === 'deny' || type === 'reject'
    if (type === 'answer' && approval.kind !== 'question') {
      return {
        status: 400,
        json: {
          ok: false,
          error: '当前是命令确认而非多选题',
          slot: approval.slot,
          code: approval.code,
        },
      }
    }

    // L2 High-Risk Safety Guard: bare single-button approve is blocked; requires 3-digit PIN verification
    if (!isDeny && approval.riskLevel === 'L2') {
      const l2Policy = voiceCopilot?.vault?.state?.prefs?.l2Policy || 'pin_3digit'
      const isLocked = Boolean(voiceCopilot?.pinStore?.isApprovalLocked?.(approval.hostId, approval.code))
      if (l2Policy === 'screen_only' || isLocked) {
        return {
          status: 403,
          json: {
            ok: false,
            blockedByPolicy: isLocked ? 'pin_locked' : 'screen_only',
            risk: 'L2',
            slot: approval.slot,
            code: approval.code,
            message: isLocked ? '确认码已锁定，请用手机处理' : '高危策略要求在手机确认',
          },
        }
      }

      const suppliedPin = String(body?.confirmPin ?? body?.pin ?? '').trim()
      if (!suppliedPin) {
        const challenge = voiceCopilot.pinStore.issue(deviceSessionId, {
          hostId: approval.hostId,
          code: approval.code,
          agentId: approval.agentId,
          summary: approval.title || approval.command,
          reason: approval.riskReason,
        })
        return {
          status: 409,
          json: {
            ok: false,
            requiresPin: true,
            risk: 'L2',
            riskReason: approval.riskReason,
            slot: approval.slot,
            code: approval.code,
            confirmPin: challenge.pin,
            expiresAt: challenge.expiresAt,
            message: `高危锁定：长按OK报码 ${challenge.pin}`,
            speechHint: `高危操作预警，请念出确认码 ${formatPinForSpeech(challenge.pin)} 放行，或长按下键拒绝。`,
          },
        }
      }

      const verdict = voiceCopilot.pinStore.verify(deviceSessionId, suppliedPin)
      if (
        verdict.status !== 'matched' ||
        verdict.challenge?.code !== approval.code ||
        verdict.challenge?.hostId !== approval.hostId
      ) {
        return {
          status: 403,
          json: {
            ok: false,
            requiresPin: true,
            pinStatus: verdict.status,
            risk: 'L2',
            slot: approval.slot,
            code: approval.code,
            message: verdict.status === 'locked' ? '高危码已锁定' : '确认码错误或已过期',
          },
        }
      }
    }

    let cmdPayload
    if (isDeny) {
      const denyIdx = computeDenyOptionIndex(approval)
      cmdPayload = {
        type: 'deny',
        code: approval.code,
        agentId: approval.agentId,
        optionIndex: Number(body?.optionIndex) || denyIdx,
      }
    } else if (type === 'answer') {
      const rawChoice =
        body?.optionIndex !== undefined
          ? Number(body.optionIndex)
          : body?.choiceIndex !== undefined
            ? Number(body.choiceIndex) + 1
            : 1
      const q0 = Array.isArray(approval.questions) ? approval.questions[0] : null
      const qOpts = Array.isArray(q0?.options) ? q0.options : []
      const clampedIdx = Math.max(1, Math.min(Math.max(1, qOpts.length || 4), Math.round(rawChoice) || 1))
      const chosenOpt = qOpts[clampedIdx - 1]
      const chosenLabel = typeof chosenOpt === 'string' ? chosenOpt : chosenOpt?.label || `Option ${clampedIdx}`
      cmdPayload = {
        type: 'approve',
        code: approval.code,
        agentId: approval.agentId,
        optionIndex: clampedIdx,
        ...(q0
          ? {
              answers: [
                {
                  questionId: q0.id || 'q0',
                  question: q0.question || approval.title,
                  selected: [chosenLabel],
                  selectedIndices: [clampedIdx - 1],
                },
              ],
            }
          : {}),
      }
    } else {
      cmdPayload = {
        type: 'approve',
        code: approval.code,
        agentId: approval.agentId,
        optionIndex: Number(body?.optionIndex) || (body?.always ? 2 : 1),
      }
    }

    const outcome = hub.queueCommand(approval.hostId, cmdPayload)
    return {
      status: outcome?.ok ? 200 : outcome?.statusCode || 500,
      json: {
        ok: Boolean(outcome?.ok),
        type: isDeny ? 'deny' : type,
        slot: approval.slot,
        code: approval.code,
        hostId: approval.hostId,
        agentId: approval.agentId,
        actionId: outcome?.command?.id || '',
        message: outcome?.ok
          ? isDeny
            ? `已拒绝 #${approval.slot}`
            : type === 'answer'
              ? `已提交选项 ${cmdPayload.optionIndex}`
              : `已放行 #${approval.slot}`
          : outcome?.error || '指令下发失败',
      },
    }
  }

  if (type === 'stop') {
    const targetHost = String(body?.hostId || '').trim()
    const targetAgent = String(body?.agentId || '').trim()
    const task =
      ctx.tasks.find(t => targetAgent && t.agentId === targetAgent && (!targetHost || t.hostId === targetHost)) ||
      ctx.tasks.find(t => t.status === 'running' && (!targetHost || t.hostId === targetHost))
    if (!task) {
      return { status: 404, json: { ok: false, error: '当前无运行中任务可停止' } }
    }
    const outcome = hub.queueCommand(task.hostId, { type: 'stop', agentId: task.agentId })
    return {
      status: outcome?.ok ? 200 : outcome?.statusCode || 500,
      json: {
        ok: Boolean(outcome?.ok),
        type: 'stop',
        hostId: task.hostId,
        agentId: task.agentId,
        actionId: outcome?.command?.id || '',
        message: outcome?.ok ? `已停止 ${compactLine(task.title, 16)}` : outcome?.error || '停止失败',
      },
    }
  }

  if (type === 'prompt') {
    const promptText = String(body?.text || body?.prompt || '').trim()
    if (!promptText) {
      return { status: 400, json: { ok: false, error: '指令内容不能为空' } }
    }
    const targetHost = String(body?.hostId || '').trim()
    const targetAgent = String(body?.agentId || '').trim()
    const task =
      ctx.tasks.find(t => targetAgent && t.agentId === targetAgent && (!targetHost || t.hostId === targetHost)) ||
      ctx.tasks.find(t => !targetHost || t.hostId === targetHost)
    if (!task) {
      return { status: 404, json: { ok: false, error: '未找到可用会话' } }
    }
    const outcome = hub.queueCommand(task.hostId, { type: 'prompt', agentId: task.agentId, text: promptText })
    return {
      status: outcome?.ok ? 200 : outcome?.statusCode || 500,
      json: {
        ok: Boolean(outcome?.ok),
        type: 'prompt',
        hostId: task.hostId,
        agentId: task.agentId,
        actionId: outcome?.command?.id || '',
        message: outcome?.ok ? `已发给 ${compactLine(task.title, 16)}` : outcome?.error || '发送失败',
      },
    }
  }

  return {
    status: 400,
    json: {
      ok: false,
      error: `不支持的设备指令类型: ${type || '(empty)'}`,
    },
  }
}

/**
 * Unified Push-To-Talk / Quick-Text voice endpoint for resource-constrained hardware.
 * Accepts either:
 *   1. Raw binary audio/pcm (16kHz 16-bit mono) or audio/wav -> STT -> Brain Turn
 *   2. Compact JSON { text, profileId, activeHostId, activeSessionId } -> Brain Turn
 */
export async function handleDeviceVoiceTurn(
  hub,
  voiceCopilot,
  {
    rawBuffer = null,
    contentType = '',
    body = {},
    query = null,
    deviceSessionId = 'device-default',
  } = {},
) {
  const ct = String(contentType || '').toLowerCase()
  const profileId = String(body?.profileId || query?.get?.('profileId') || '').trim()
  const activeHostId = String(body?.activeHostId || query?.get?.('hostId') || '').trim()
  const activeSessionId = String(body?.activeSessionId || query?.get?.('agentId') || '').trim()

  let transcript = String(body?.text || '').trim()
  let sttMeta = null

  if (!transcript && Buffer.isBuffer(rawBuffer) && rawBuffer.length > 0) {
    const rateMatch = /rate=(\d+)/i.exec(ct)
    const sampleRate = Math.max(8000, Math.min(48000, Number(query?.get?.('rate') || rateMatch?.[1] || 16000)))
    const isWav = ct.includes('wav') || (rawBuffer.length >= 4 && rawBuffer.subarray(0, 4).toString('ascii') === 'RIFF')
    const wavBuf = isWav ? rawBuffer : encodePcm16ToWav(rawBuffer, sampleRate, 1)
    const stt = await voiceCopilot.runStt({
      audioBase64: wavBuf.toString('base64'),
      mimeType: 'audio/wav',
      profileId,
      language: String(query?.get?.('lang') || 'zh-CN'),
    })
    sttMeta = { provider: stt.provider, latencyMs: stt.latencyMs }
    if (!stt.ok || !String(stt.text || '').trim()) {
      return {
        status: stt.ok ? 200 : 502,
        json: {
          ok: false,
          transcript: '',
          reply: stt.error ? compactLine(stt.error, 80) : '未听清语音，请按住重试',
          executed: false,
          stt: sttMeta,
        },
      }
    }
    transcript = String(stt.text).trim()
  }

  if (!transcript) {
    return {
      status: 400,
      json: {
        ok: false,
        error: '缺少语音数据或文本内容',
      },
    }
  }

  const turn = await voiceCopilot.runBrainTurn({
    text: transcript,
    voiceSessionId: deviceSessionId,
    activeHostId,
    activeSessionId,
    profileId,
  })

  if (!turn.ok) {
    return {
      status: 502,
      json: {
        ok: false,
        transcript: compactLine(transcript, 80),
        reply: compactLine(turn.error || '语音处理失败', 100),
        executed: false,
        ...(sttMeta ? { stt: sttMeta } : {}),
      },
    }
  }

  const cleanReply = sanitizeTextForVoiceBriefing(turn.spokenReply || '', 110)
  return {
    status: 200,
    json: {
      ok: true,
      transcript: compactLine(transcript, 80),
      reply: compactLine(cleanReply || turn.spokenReply || '已处理', 110),
      executed: Boolean(turn.execution?.executed),
      actionType: String(turn.action?.type || 'none'),
      requiresPin: Boolean(turn.execution?.requiresPin),
      pin: turn.pinChallenge?.pin || '',
      pending: Number(turn.contextSummary?.pendingApprovals || 0),
      ttsText: compactLine(cleanReply || turn.spokenReply || '', 96),
      ...(sttMeta ? { stt: sttMeta } : {}),
    },
  }
}

/**
 * Synthesize compact 16kHz 16-bit mono PCM audio stream directly consumable by
 * ESP32-C3 / ES8311 I2S (zero MP3 decoder or large WAV buffer needed on-device).
 */
export async function handleDeviceTtsPcm(
  hub,
  voiceCopilot,
  {
    text = '',
    briefingSlot = 0,
    sampleRate = 16000,
    profileId = '',
  } = {},
) {
  let cleanText = String(text || '').trim()
  if (!cleanText && Number(briefingSlot) >= 1) {
    const ctx = buildDynamicVoiceContext(hub)
    const app = ctx.pendingApprovals.find(a => a.slot === Number(briefingSlot))
    if (app) {
      cleanText = formatApprovalBriefingSpeech(app, { totalCount: ctx.pendingApprovals.length })
    }
  }
  cleanText = sanitizeTextForVoiceBriefing(cleanText, 110)
  if (!cleanText) {
    return {
      status: 400,
      json: { ok: false, error: '缺少播报文本或审批序号' },
    }
  }

  const targetRate = Math.max(8000, Math.min(24000, Math.round(Number(sampleRate) || 16000)))
  const tts = await voiceCopilot.runTts({
    text: cleanText,
    profileId,
    outputFormat: 'pcm16',
    sampleRate: targetRate,
  })

  if (!tts.ok) {
    return {
      status: 502,
      json: { ok: false, error: tts.error || 'TTS 合成失败' },
    }
  }
  if (tts.useBrowserSpeech || !Buffer.isBuffer(tts.pcmBuffer)) {
    return {
      status: 501,
      json: {
        ok: false,
        error: '硬件 PCM 播报需先在控制台配置云端 BYOK TTS 密钥',
        text: cleanText,
      },
    }
  }

  return {
    status: 200,
    headers: {
      'content-type': `audio/pcm; rate=${targetRate}; bits=16; channels=1`,
      'content-length': String(tts.pcmBuffer.length),
      'cache-control': 'no-store',
      'x-audio-sample-rate': String(targetRate),
      'x-audio-channels': '1',
      'x-audio-bits': '16',
    },
    buffer: tts.pcmBuffer,
  }
}
