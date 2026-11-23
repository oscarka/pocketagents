#!/usr/bin/env node
// Claude Code official PermissionRequest hook bridge for mobile 1-tap & Swipe Triage approvals.
// Reads Claude Code hook JSON from stdin, publishes an atomic request file under
// ~/.claude/.dsh-remote-approvals/, waits for mobile decision, and emits Claude Code's
// official hookSpecificOutput JSON to stdout. Zero external dependencies.

import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactText } from './redact.js'

const UNSAFE_BASH_WILDCARD_FIRST_TOKENS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'csh', 'tcsh', 'ksh',
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua',
  'awk', 'sed', 'env', 'sudo', 'su', 'doas', 'cd', 'eval', 'exec',
  'xargs', 'find', 'curl', 'wget', 'ssh', 'scp', 'rsync',
  'chmod', 'chown', 'rm', 'dd', 'mkfs', 'nc', 'ncat', 'socat',
])

const UNSAFE_BASH_WILDCARD_PREFIXES = new Set([
  'git push', 'git reset', 'git clean', 'npm publish', 'docker run', 'docker exec',
])

function isSafeBashWildcardCandidate(command = '', ruleHint = '') {
  const cmd = String(command || '').trim()
  const hint = String(ruleHint || '').trim()
  if (!cmd || !hint || hint === 'Bash') return false
  // Refuse wildcarding compound/chained/redirection/subshell commands
  if (/[;&|`$<>()\r\n]/.test(cmd) || /[;&|`$<>()\r\n]/.test(hint)) return false
  const tokens = hint.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const firstBin = basename(tokens[0])
  if (UNSAFE_BASH_WILDCARD_FIRST_TOKENS.has(firstBin)) return false
  if (tokens.length >= 2 && UNSAFE_BASH_WILDCARD_PREFIXES.has(`${firstBin} ${tokens[1]}`)) {
    return false
  }
  return true
}

function ensurePrivateDir(dirPath) {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dirPath, 0o700)
  } catch {
    // ignore on platforms/filesystems without POSIX chmod
  }
}

export const CLAUDE_APPROVAL_DIR_NAME = '.dsh-remote-approvals'
export const CLAUDE_HOOK_MARKER = 'claude-permission-hook.js'
export const CLAUDE_WATCHER_HEARTBEAT_FILE = '.watcher-alive.json'
export const DEFAULT_HOOK_TIMEOUT_MS = 240_000
export const DEFAULT_WATCHER_TTL_MS = 30_000

export function getClaudeApprovalDir(claudeHome = join(homedir(), '.claude')) {
  return join(claudeHome || join(homedir(), '.claude'), CLAUDE_APPROVAL_DIR_NAME)
}

function isPidAliveSafe(pid) {
  const num = Number(pid)
  if (!Number.isInteger(num) || num <= 0) return false
  try {
    process.kill(num, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

export function touchClaudeWatcherHeartbeat({
  claudeHome = process.env.CLAUDE_HOME || join(homedir(), '.claude'),
  pid = process.pid,
  now = Date.now(),
} = {}) {
  if (!claudeHome || !existsSync(claudeHome)) return false
  try {
    const dir = getClaudeApprovalDir(claudeHome)
    ensurePrivateDir(dir)
    const targetPath = join(dir, CLAUDE_WATCHER_HEARTBEAT_FILE)
    const tmpPath = `${targetPath}.tmp-${pid}-${randomBytes(6).toString('hex')}`
    writeFileSync(tmpPath, JSON.stringify({ pid, updatedAt: now }) + '\n', { mode: 0o600 })
    renameSync(tmpPath, targetPath)
    return true
  } catch {
    return false
  }
}

export function isPocketAgentsWatcherActive({
  claudeHome = process.env.CLAUDE_HOME || join(homedir(), '.claude'),
  dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  now = Date.now(),
  maxHeartbeatAgeMs = DEFAULT_WATCHER_TTL_MS,
  isAliveImpl = isPidAliveSafe,
} = {}) {
  // 1. Check ClaudeAdapter watcher heartbeat written by `npx pocketagents`, `daemon.mjs`, or DSH plugin
  try {
    const hbPath = join(getClaudeApprovalDir(claudeHome), CLAUDE_WATCHER_HEARTBEAT_FILE)
    if (existsSync(hbPath)) {
      const hb = JSON.parse(readFileSync(hbPath, 'utf8'))
      const pid = Number(hb?.pid)
      const updatedAt = Number(hb?.updatedAt || 0)
      if (pid > 0 && isAliveImpl(pid) && updatedAt > 0 && now - updatedAt <= maxHeartbeatAgeMs) {
        return true
      }
    }
  } catch {
    // ignore corrupt or racing heartbeat file
  }

  // 2. Fallback to ~/.dsh/daemon.lock (written by `daemon.mjs` and DSH Desktop/Web plugin)
  try {
    const lockPath = join(dshHome || join(homedir(), '.dsh'), 'daemon.lock')
    if (existsSync(lockPath)) {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
      const pid = Number(lock?.pid)
      if (pid > 0 && isAliveImpl(pid)) {
        return true
      }
    }
  } catch {
    // ignore missing or corrupt lockfile
  }

  return false
}

export function generateClaudeApprovalCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  let suffix = ''
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[bytes[i] % alphabet.length]
  }
  return `CLD-${suffix}`
}

function summarizeBashPrefix(command = '') {
  const first = String(command || '').trim().split(/\s+/).slice(0, 2).join(' ')
  return first.slice(0, 32)
}

export function buildClaudeApprovalDescriptor(hookInput = {}, { code = generateClaudeApprovalCode(), now = Date.now(), pid = process.pid } = {}) {
  const rawSessionId = String(hookInput.session_id || hookInput.sessionId || `term-${pid}`).trim()
  const cwd = String(hookInput.cwd || '').trim()
  const project = cwd ? basename(cwd) : 'claude'
  const toolName = String(hookInput.tool_name || hookInput.toolName || 'Tool').trim()
  const toolInput = hookInput.tool_input && typeof hookInput.tool_input === 'object' ? hookInput.tool_input : {}
  const suggestions = Array.isArray(hookInput.permission_suggestions) ? hookInput.permission_suggestions : []

  let commandLine = ''
  let reason = ''
  let kind = 'command'
  let questions = undefined
  let promptTitle = ''
  let ruleHint = toolName

  let safeToolInput = {}
  if (toolName === 'Bash') {
    commandLine = redactText(String(toolInput.command || '').trim())
    reason = redactText(
      String(toolInput.description || '').trim() || `Claude Code requests Bash: ${commandLine.slice(0, 120)}`,
    )
    const prefix = summarizeBashPrefix(String(toolInput.command || '').trim())
    if (prefix) ruleHint = prefix
    safeToolInput = { command: commandLine.slice(0, 500) }
  } else if (toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions) && toolInput.questions.length > 0) {
    kind = 'question'
    promptTitle = 'Claude Code 需要你做出选择'
    questions = toolInput.questions.map((q, idx) => ({
      id: String(q.id || `q_${idx + 1}`),
      header: String(q.header || ''),
      question: String(q.question || q.prompt || '请选择一项'),
      multiSelect: Boolean(q.multiSelect || q.multi_select),
      options: (Array.isArray(q.options) ? q.options : []).map(o => ({
        label: String(o.label || o),
        description: String(o.description || ''),
      })),
    }))
    reason = questions[0]?.question || promptTitle
    // Keep questions structure for updatedInput answers pass-through
    safeToolInput = { questions: toolInput.questions }
  } else if (toolName === 'ExitPlanMode') {
    commandLine = 'ExitPlanMode (Approve implementation plan)'
    reason = redactText(
      String(toolInput.plan || toolInput.summary || 'Claude Code is ready to start executing the plan').slice(0, 300),
    )
    ruleHint = 'ExitPlanMode'
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const target = String(toolInput.file_path || toolInput.path || toolInput.notebook_path || '').trim()
    const shortTarget = target ? target.split('/').slice(-2).join('/') : toolName
    commandLine = `${toolName}: ${shortTarget}`
    reason = `Claude Code wants to modify ${shortTarget}`
    ruleHint = toolName
    // Never persist full file bodies (`content`, `new_string`, `old_string`) into disk approval descriptors
    safeToolInput = target ? { file_path: target } : {}
  } else {
    const compactArgs = redactText(JSON.stringify(toolInput).slice(0, 140))
    commandLine = `${toolName}${compactArgs && compactArgs !== '{}' ? ` ${compactArgs}` : ''}`
    reason = `Claude Code requests permission for ${toolName}`
  }

  const allowWildcard =
    toolName !== 'Bash' || isSafeBashWildcardCandidate(String(toolInput.command || ''), ruleHint)

  const options =
    kind === 'question'
      ? undefined
      : allowWildcard
        ? [
            { index: 1, label: '1. 本次允许执行' },
            { index: 2, label: `2. 本对话内始终允许 '${ruleHint}'` },
          ]
        : [{ index: 1, label: '1. 本次允许执行' }]

  return {
    code,
    agentId: `claude:${rawSessionId}`,
    rawSessionId,
    harness: 'claude',
    project,
    cwd,
    title: promptTitle || (toolName === 'Bash' ? `Bash: ${commandLine.slice(0, 48)}` : `${toolName} (${project})`),
    kind,
    toolName,
    toolInput: safeToolInput,
    command: commandLine,
    commandLine,
    reason,
    ...(promptTitle ? { promptTitle } : {}),
    ...(questions ? { questions } : {}),
    ...(options ? { options } : {}),
    ruleHint,
    allowWildcard,
    permissionSuggestions: suggestions,
    createdAt: now,
    pid,
  }
}

export function buildClaudeHookDecisionOutput(descriptor = {}, decision = {}) {
  const allow = decision.allow !== false
  if (!allow) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: String(decision.message || 'Denied from mobile remote control.'),
        },
      },
    }
  }

  const outDecision = { behavior: 'allow' }

  // Pass structured answers back for AskUserQuestion
  if (
    descriptor.toolName === 'AskUserQuestion' &&
    decision.answers &&
    typeof decision.answers === 'object'
  ) {
    outDecision.updatedInput = {
      ...(descriptor.toolInput && typeof descriptor.toolInput === 'object' ? descriptor.toolInput : {}),
      answers: decision.answers,
    }
  }

  // Option 2 ("Always allow in this session") -> attach updatedPermissions
  if (Number(decision.optionIndex) === 2) {
    if (Array.isArray(descriptor.permissionSuggestions) && descriptor.permissionSuggestions.length > 0) {
      outDecision.updatedPermissions = descriptor.permissionSuggestions
    } else if (descriptor.toolName) {
      if (descriptor.toolName === 'Bash') {
        const safeWildcard =
          descriptor.allowWildcard !== false &&
          isSafeBashWildcardCandidate(descriptor.commandLine || descriptor.command || '', descriptor.ruleHint || '')
        if (safeWildcard) {
          outDecision.updatedPermissions = [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: `${descriptor.ruleHint}:*` }],
              behavior: 'allow',
              destination: 'session',
            },
          ]
        }
      } else {
        outDecision.updatedPermissions = [
          {
            type: 'addRules',
            rules: [{ toolName: descriptor.toolName }],
            behavior: 'allow',
            destination: 'session',
          },
        ]
      }
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: outDecision,
    },
  }
}

export function buildClaudeHookCommand(hookScriptPath = fileURLToPath(import.meta.url)) {
  const escapedScript = String(hookScriptPath).replace(/'/g, "'\\''")
  return `node '${escapedScript}'`
}

export function isClaudePermissionHookInstalled({ claudeHome = join(homedir(), '.claude') } = {}) {
  const settingsPath = join(claudeHome, 'settings.json')
  if (!existsSync(settingsPath)) return false
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const list = raw?.hooks?.PermissionRequest
    if (!Array.isArray(list)) return false
    return list.some(
      entry =>
        Array.isArray(entry?.hooks) &&
        entry.hooks.some(h => typeof h?.command === 'string' && h.command.includes(CLAUDE_HOOK_MARKER)),
    )
  } catch {
    return false
  }
}

export function installClaudePermissionHook({
  claudeHome = join(homedir(), '.claude'),
  hookScriptPath = fileURLToPath(import.meta.url),
} = {}) {
  mkdirSync(claudeHome, { recursive: true })
  const settingsPath = join(claudeHome, 'settings.json')
  let settings = {}
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed
      }
    } catch {
      return { ok: false, error: `Cannot parse existing ${settingsPath} (invalid JSON)` }
    }
  }

  const command = buildClaudeHookCommand(hookScriptPath)
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? { ...settings.hooks } : {}
  const existing = Array.isArray(hooks.PermissionRequest) ? [...hooks.PermissionRequest] : []

  // Replace any prior installation of our hook cleanly without touching unrelated user hooks
  const filtered = existing.filter(
    entry =>
      !(
        Array.isArray(entry?.hooks) &&
        entry.hooks.some(h => typeof h?.command === 'string' && h.command.includes(CLAUDE_HOOK_MARKER))
      ),
  )

  filtered.push({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command,
        timeout: 250,
      },
    ],
  })

  hooks.PermissionRequest = filtered
  settings.hooks = hooks

  const tmpPath = `${settingsPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmpPath, settingsPath)
  ensurePrivateDir(getClaudeApprovalDir(claudeHome))

  return { ok: true, settingsPath, command }
}

export function uninstallClaudePermissionHook({ claudeHome = join(homedir(), '.claude') } = {}) {
  const settingsPath = join(claudeHome, 'settings.json')
  if (!existsSync(settingsPath)) return { ok: true, removed: false, settingsPath }
  let settings
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  } catch {
    return { ok: false, error: `Cannot parse existing ${settingsPath}` }
  }
  const list = settings?.hooks?.PermissionRequest
  if (!Array.isArray(list)) return { ok: true, removed: false, settingsPath }

  const next = list.filter(
    entry =>
      !(
        Array.isArray(entry?.hooks) &&
        entry.hooks.some(h => typeof h?.command === 'string' && h.command.includes(CLAUDE_HOOK_MARKER))
      ),
  )
  if (next.length === list.length) {
    return { ok: true, removed: false, settingsPath }
  }
  if (next.length === 0) {
    delete settings.hooks.PermissionRequest
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }
  } else {
    settings.hooks.PermissionRequest = next
  }

  const tmpPath = `${settingsPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmpPath, settingsPath)
  return { ok: true, removed: true, settingsPath }
}

function safeUnlink(p) {
  try {
    unlinkSync(p)
  } catch {
    // ignore missing files
  }
}

export async function runClaudePermissionHookProcess({
  rawStdin = '',
  claudeHome = process.env.CLAUDE_HOME || join(homedir(), '.claude'),
  dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
  timeoutMs = Number(process.env.DSH_CLAUDE_HOOK_TIMEOUT_MS) || DEFAULT_HOOK_TIMEOUT_MS,
  pollIntervalMs = 180,
  requireWatcher = false,
  skipIfSettingsHookInstalled = false,
  isAliveImpl = isPidAliveSafe,
} = {}) {
  const trimmed = String(rawStdin || '').trim()
  if (!trimmed) return null
  let hookInput
  try {
    hookInput = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!hookInput || typeof hookInput !== 'object') return null

  // When invoked via Claude Code plugin hooks.json, yield immediately if ~/.claude/settings.json
  // already registered this hook to avoid duplicate approval cards for the same PermissionRequest.
  if (skipIfSettingsHookInstalled && isClaudePermissionHookInstalled({ claudeHome })) {
    return null
  }

  // Never block Claude Code's terminal prompt if no live PocketAgents daemon/CLI watcher is running.
  if (requireWatcher && !isPocketAgentsWatcherActive({ claudeHome, dshHome, isAliveImpl })) {
    return null
  }

  const dir = getClaudeApprovalDir(claudeHome)
  ensurePrivateDir(dir)

  const descriptor = buildClaudeApprovalDescriptor(hookInput)
  const reqPath = join(dir, `req-${descriptor.code}.json`)
  const resPath = join(dir, `res-${descriptor.code}.json`)
  const reqTmp = `${reqPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  writeFileSync(reqTmp, JSON.stringify(descriptor, null, 2), { mode: 0o600 })
  renameSync(reqTmp, reqPath)

  const cleanup = () => {
    safeUnlink(reqPath)
    safeUnlink(resPath)
  }

  const readDecisionIfReady = () => {
    if (!existsSync(resPath)) return null
    try {
      const parsed = JSON.parse(readFileSync(resPath, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    } catch {
      // response still being renamed/written
    }
    return null
  }

  return await new Promise(resolve => {
    let settled = false
    let watcher = null
    let pollTimer = null
    let timeoutTimer = null

    const finish = decision => {
      if (settled) return
      settled = true
      if (watcher) {
        try {
          watcher.close()
        } catch {}
      }
      if (pollTimer) clearInterval(pollTimer)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      cleanup()
      resolve(decision ? buildClaudeHookDecisionOutput(descriptor, decision) : null)
    }

    const checkNow = () => {
      const dec = readDecisionIfReady()
      if (dec) finish(dec)
    }

    process.once('SIGINT', () => finish(null))
    process.once('SIGTERM', () => finish(null))

    try {
      watcher = watch(dir, () => checkNow())
      watcher.on('error', () => {})
    } catch {
      // fallback to polling below
    }

    pollTimer = setInterval(checkNow, pollIntervalMs)
    pollTimer.unref?.()
    timeoutTimer = setTimeout(() => finish(null), Math.max(1000, timeoutMs))
    timeoutTimer.unref?.()
    checkNow()
  })
}

async function readStdinAll(maxBytes = 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buf.length
    if (total > maxBytes) {
      return ''
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const args = new Set(process.argv.slice(2))
  const fromPlugin = args.has('--from-plugin')
  const forceWait = process.env.DSH_CLAUDE_HOOK_FORCE === '1'
  const requireWatcher = fromPlugin || args.has('--require-watcher') || !forceWait
  readStdinAll()
    .then(raw =>
      runClaudePermissionHookProcess({
        rawStdin: raw,
        requireWatcher,
        skipIfSettingsHookInstalled: fromPlugin,
      }),
    )
    .then(output => {
      if (output) {
        process.stdout.write(JSON.stringify(output) + '\n')
      }
      process.exit(0)
    })
    .catch(() => {
      process.exit(0)
    })
}
