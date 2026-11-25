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

function extractCompactOptions(approval) {
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
    nowMs = Date.now(),
  } = {},
) {
  const ctx = buildDynamicVoiceContext(hub, { activeHostId, activeSessionId })
  const approvalCap = normalizePositiveInt(maxApprovals, DEFAULT_MAX_APPROVALS, 1, MAX_ALLOWED_APPROVALS)
  const taskCap = normalizePositiveInt(maxTasks, DEFAULT_MAX_TASKS, 1, MAX_ALLOWED_TASKS)

  const hostsOnline = ctx.hosts.filter(h => h.online).length
  const hostsTotal = ctx.hosts.length
  const runningCount = ctx.tasks.filter(t => t.status === 'running').length
  const pendingCount = ctx.pendingApprovals.length

  const approvals = ctx.pendingApprovals.slice(0, approvalCap).map(a => ({
    slot: a.slot,
    hostId: compactLine(a.hostId, 32),
    hostName: compactLine(a.hostName, 20),
    code: compactLine(a.code, 32),
    agentId: compactLine(a.agentId, 48),
    session: compactLine(a.sessionTitle || a.hostName, 26),
    kind: a.kind === 'question' ? 'question' : 'approval',
    tool: compactLine(a.toolName || (a.kind === 'question' ? 'question' : 'tool'), 20),
    risk: a.riskLevel || 'L1',
    title: compactLine(a.title || a.promptTitle || a.toolName || 'Pending approval', 44),
    cmd: extractQuestionPrompt(a),
    options: extractCompactOptions(a),
  }))

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
            ? 'Multiple approvals pending; specify slot or code'
            : 'Approval not found or already resolved',
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
          error: 'Target item is a command approval, not a multiple-choice question',
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
            message: isLocked
              ? 'L2 PIN locked; confirm on phone screen'
              : 'L2 policy requires phone screen confirmation',
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
            message: `L2 HIGH RISK! Say or enter PIN ${challenge.pin}`,
            speechHint: `高危操作预警，请念出确认码 ${formatPinForSpeech(challenge.pin)} 放行，或双击拒绝。`,
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
            message: verdict.status === 'locked' ? 'L2 PIN locked' : 'Invalid or expired PIN',
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
            ? `Denied #${approval.slot}`
            : type === 'answer'
              ? `Answered #${approval.slot} (opt ${cmdPayload.optionIndex})`
              : `Approved #${approval.slot}`
          : outcome?.error || 'Failed to queue command',
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
      return { status: 404, json: { ok: false, error: 'No running task found to stop' } }
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
        message: outcome?.ok ? `Stopped ${compactLine(task.title, 20)}` : outcome?.error || 'Failed to stop task',
      },
    }
  }

  if (type === 'prompt') {
    const promptText = String(body?.text || body?.prompt || '').trim()
    if (!promptText) {
      return { status: 400, json: { ok: false, error: 'Prompt text is required' } }
    }
    const targetHost = String(body?.hostId || '').trim()
    const targetAgent = String(body?.agentId || '').trim()
    const task =
      ctx.tasks.find(t => targetAgent && t.agentId === targetAgent && (!targetHost || t.hostId === targetHost)) ||
      ctx.tasks.find(t => !targetHost || t.hostId === targetHost)
    if (!task) {
      return { status: 404, json: { ok: false, error: 'No active session found for prompt' } }
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
        message: outcome?.ok ? `Sent to ${compactLine(task.title, 20)}` : outcome?.error || 'Failed to send prompt',
      },
    }
  }

  return {
    status: 400,
    json: {
      ok: false,
      error: `Unsupported device action type: ${type || '(empty)'}`,
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
        error: 'Missing voice audio (audio/pcm or audio/wav) or JSON text',
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
        reply: compactLine(turn.error || 'Voice turn failed', 100),
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
      reply: compactLine(cleanReply || turn.spokenReply || 'OK', 110),
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
      json: { ok: false, error: 'Missing text or valid briefing slot' },
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
      json: { ok: false, error: tts.error || 'TTS synthesis failed' },
    }
  }
  if (tts.useBrowserSpeech || !Buffer.isBuffer(tts.pcmBuffer)) {
    return {
      status: 501,
      json: {
        ok: false,
        error: 'Cloud BYOK TTS provider required for raw PCM hardware output (current profile uses browser native speech)',
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
