import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const AGY_INSTALL_URL_UNIX = 'https://antigravity.google/cli/install.sh'
export const AGY_INSTALL_URL_WIN = 'https://antigravity.google/cli/install.ps1'

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function withCliEnv(extra = {}) {
  const home = homedir()
  const basePath = process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  const extraPaths = [
    join(home, '.local', 'bin'),
    join(home, '.gemini', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
  const sep = process.platform === 'win32' ? ';' : ':'
  const mergedPath = [...new Set([...extraPaths, ...basePath.split(sep).filter(Boolean)])].join(sep)
  const env = {
    ...process.env,
    PATH: mergedPath,
    ...extra,
  }
  if (!env.LANG || !/utf-?8/i.test(env.LANG)) env.LANG = 'en_US.UTF-8'
  if (!env.LC_CTYPE || !/utf-?8/i.test(env.LC_CTYPE)) env.LC_CTYPE = 'UTF-8'
  return env
}

/**
 * Locate the official Google Antigravity CLI (`agy`) binary across all standard install locations.
 */
export async function findOfficialAgyCliPath({
  home = homedir(),
  platform = process.platform,
  execImpl = execFileAsync,
  accessImpl = access,
} = {}) {
  const candidates = []
  if (process.env.ANTIGRAVITY_AGENTAPI_EXE) {
    candidates.push(process.env.ANTIGRAVITY_AGENTAPI_EXE)
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    candidates.push(
      join(localAppData, 'agy', 'bin', 'agy.exe'),
      join(home, '.local', 'bin', 'agy.exe'),
      join(home, '.gemini', 'bin', 'agy.exe'),
    )
  } else {
    candidates.push(
      join(home, '.gemini', 'bin', 'agy'),
      join(home, '.local', 'bin', 'agy'),
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
    )
  }
  for (const cand of candidates) {
    if (!cand) continue
    try {
      await accessImpl(cand)
      return cand
    } catch {
      // try next candidate
    }
  }
  if (typeof execImpl === 'function') {
    try {
      const lookupCmd = platform === 'win32' ? 'where' : 'which'
      const { stdout } = await execImpl(lookupCmd, ['agy'], { timeout: 2500, env: withCliEnv() })
      const firstLine = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
      if (firstLine) {
        await accessImpl(firstLine)
        return firstLine
      }
    } catch {
      // not on PATH
    }
  }
  return ''
}

export async function detectAntigravityDesktopApp({
  home = homedir(),
  platform = process.platform,
  accessImpl = access,
} = {}) {
  const candidates = platform === 'darwin'
    ? [
      '/Applications/Antigravity.app',
      '/Applications/Antigravity IDE.app',
      join(home, 'Applications', 'Antigravity.app'),
      join(home, 'Applications', 'Antigravity IDE.app'),
    ]
    : platform === 'win32'
      ? [
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'Antigravity', 'Antigravity.exe'),
      ]
      : [
        '/usr/bin/antigravity',
        join(home, '.local', 'share', 'applications', 'antigravity.desktop'),
      ]

  for (const appPath of candidates) {
    try {
      await accessImpl(appPath)
      return { installed: true, appPath }
    } catch {
      // try next
    }
  }
  return { installed: false, appPath: '' }
}

function summarizeAcpToolCall(toolCall = {}) {
  const title = String(toolCall.title || toolCall.name || toolCall.kind || '工具执行').trim()
  const rawInput = toolCall.rawInput || toolCall.input || toolCall.arguments || null
  let commandLine = ''
  if (rawInput && typeof rawInput === 'object') {
    commandLine = String(
      rawInput.CommandLine
      || rawInput.commandLine
      || rawInput.command
      || rawInput.Path
      || rawInput.path
      || rawInput.filePath
      || '',
    ).trim()
    if (!commandLine) {
      try {
        commandLine = JSON.stringify(rawInput).slice(0, 500)
      } catch {
        commandLine = ''
      }
    }
  } else if (typeof rawInput === 'string') {
    commandLine = rawInput.trim().slice(0, 500)
  }
  return {
    toolName: String(toolCall.kind || toolCall.name || 'tool').trim() || 'tool',
    promptTitle: title || 'Allow action?',
    commandLine: commandLine || title,
  }
}

function extractAcpTextFromContent(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(extractAcpTextFromContent).filter(Boolean).join('')
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (content.content) return extractAcpTextFromContent(content.content)
  }
  return ''
}

/**
 * Persistent official Agent Client Protocol (`agy acp --stdio --app-data-dir=antigravity`) bridge.
 *
 * Provides full remote control over Antigravity 2.0 sessions even when the desktop GUI is closed,
 * screen-locked, or no legacy `--csrf_token` Connect-RPC hub is running:
 * - Lists & resumes existing `Antigravity.app` sessions (`session/list`, `session/resume`)
 * - Creates new conversations (`session/new`)
 * - Switches models & reasoning levels (`session/set_model`, `session/set_config_option`)
 * - Streams prompt turns with native text + image content blocks (`session/prompt`)
 * - Cancels running turns (`session/cancel`)
 * - Bridges `session/request_permission` JSON-RPC callbacks to mobile approval cards
 */
export class AntigravityAcpClient {
  constructor({
    cliPath = '',
    appDataDir = 'antigravity',
    spawnImpl = spawn,
    execImpl = execFileAsync,
    home = homedir(),
    logger = console,
    onStateChange = null,
    modelSlugResolver = null,
  } = {}) {
    this.cliPath = String(cliPath || '').trim()
    this.appDataDir = String(appDataDir || 'antigravity').trim()
    this.spawnImpl = spawnImpl
    this.execImpl = execImpl
    this.home = home
    this.logger = logger
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : null
    this.modelSlugResolver = typeof modelSlugResolver === 'function' ? modelSlugResolver : (m => String(m || '').trim())

    this.proc = null
    this.stdoutBuffer = ''
    this.nextRpcId = 1
    this.pendingRpc = new Map()
    this.initialized = false
    this.initPromise = null
    this.lastError = ''
    this.authenticated = null // true | false | null
    this.lastAuthCheckAt = 0

    // Loaded/resumed ACP session metadata keyed by raw conversationId
    this.loadedSessions = new Set()
    // Active turns launched via ACP: convId -> { status, startedAt, updatedAt, text, thinking, tools, modelId, cwd }
    this.activeTurns = new Map()
    // Pending Agent->Client `session/request_permission` callbacks keyed by approval code (AGY-ACP-...)
    this.pendingPermissions = new Map()
    // Cached live model catalog returned by `session/resume` or `session/new`
    this.liveModelCatalog = null
  }

  async resolveCliPath() {
    if (this.cliPath) {
      try {
        await access(this.cliPath)
        return this.cliPath
      } catch {
        this.cliPath = ''
      }
    }
    const found = await findOfficialAgyCliPath({
      home: this.home,
      execImpl: this.execImpl,
    })
    if (found) this.cliPath = found
    return this.cliPath
  }

  isAlive() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null)
  }

  async ensureStarted() {
    if (this.isAlive() && this.initialized) return true
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      const bin = await this.resolveCliPath()
      if (!bin) {
        this.lastError = '未找到官方 agy CLI'
        return false
      }
      this.cleanupProcess('restart')
      const args = ['acp', '--stdio', `--app-data-dir=${this.appDataDir}`]
      const child = this.spawnImpl(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: withCliEnv(),
      })
      this.proc = child
      this.stdoutBuffer = ''
      this.initialized = false
      this.loadedSessions.clear()

      child.stdout?.setEncoding?.('utf8')
      child.stdout?.on('data', chunk => this._handleStdoutChunk(String(chunk || '')))
      child.stderr?.setEncoding?.('utf8')
      child.stderr?.on('data', chunk => {
        const txt = String(chunk || '').trim()
        if (txt && /not logged in|please sign in|unauthorized/i.test(txt)) {
          this.authenticated = false
        }
      })
      child.on('error', err => {
        this.lastError = err?.message || 'ACP 启动失败'
        this.cleanupProcess('error')
      })
      child.on('exit', () => {
        this.cleanupProcess('exit')
      })

      try {
        const initRes = await this._sendRequest(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
              elicitation: { form: {}, url: {} },
            },
            clientInfo: {
              name: 'PocketAgents',
              version: '0.9.34',
            },
          },
          12_000,
        )
        if (!initRes || typeof initRes !== 'object') {
          this.lastError = 'ACP initialize 无响应'
          this.cleanupProcess('init-failed')
          return false
        }
        this.initialized = true
        this.lastError = ''
        return true
      } catch (err) {
        this.lastError = err?.message || 'ACP 握手失败'
        this.cleanupProcess('init-error')
        return false
      }
    })()

    try {
      return await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  cleanupProcess(reason = 'closed') {
    const oldProc = this.proc
    this.proc = null
    this.initialized = false
    this.loadedSessions.clear()
    this.stdoutBuffer = ''
    for (const [, waiter] of this.pendingRpc.entries()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`ACP process ${reason}`))
    }
    this.pendingRpc.clear()
    this.pendingPermissions.clear()
    for (const [, turn] of this.activeTurns.entries()) {
      turn.status = 'idle'
    }
    this.activeTurns.clear()
    if (oldProc && !oldProc.killed && oldProc.exitCode === null) {
      try {
        oldProc.kill('SIGTERM')
      } catch {
        // ignore kill error
      }
    }
  }

  shutdown() {
    this.cleanupProcess('shutdown')
  }

  _sendRaw(payload) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) {
      throw new Error('ACP stdin is not writable')
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  _sendRequest(method, params = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      if (!this.isAlive()) {
        reject(new Error('ACP server not running'))
        return
      }
      const id = this.nextRpcId
      this.nextRpcId += 1
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id)
        reject(new Error(`ACP request ${method} timed out`))
      }, timeoutMs)
      timer.unref?.()
      this.pendingRpc.set(id, { resolve, reject, timer, method })
      try {
        this._sendRaw({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pendingRpc.delete(id)
        reject(err)
      }
    })
  }

  _sendNotification(method, params = {}) {
    if (!this.isAlive()) return
    try {
      this._sendRaw({ jsonrpc: '2.0', method, params })
    } catch {
      // ignore
    }
  }

  _handleStdoutChunk(chunk) {
    this.stdoutBuffer += chunk
    let idx
    while ((idx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      this._handleMessage(msg)
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return

    // 1. JSON-RPC response to our outgoing request
    if (msg.id !== undefined && !msg.method) {
      const waiter = this.pendingRpc.get(msg.id)
      if (!waiter) return
      this.pendingRpc.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) {
        const errMsg = String(msg.error?.message || msg.error?.data || 'ACP RPC error')
        if (/sign in|not logged in|auth|unauthenticated/i.test(errMsg)) {
          this.authenticated = false
        }
        waiter.reject(new Error(errMsg))
      } else {
        waiter.resolve(msg.result)
      }
      return
    }

    // 2. Agent -> Client JSON-RPC Request (expects a response with matching `id`)
    if (msg.id !== undefined && msg.method) {
      this._handleIncomingRequest(msg)
      return
    }

    // 3. Agent -> Client Notification (e.g., `session/update`)
    if (msg.method === 'session/update') {
      this._handleSessionUpdate(msg.params || {})
    }
  }

  _handleIncomingRequest(msg) {
    const { id, method, params = {} } = msg
    if (method === 'session/request_permission') {
      const sessionId = String(params.sessionId || '').trim()
      const rawOptions = Array.isArray(params.options) ? params.options : []
      const toolInfo = summarizeAcpToolCall(params.toolCall || {})
      const short = (sessionId || randomBytes(3).toString('hex')).slice(0, 6).toUpperCase()
      const code = `AGY-ACP-${short}-${id}`
      const now = Date.now()
      const options = rawOptions.length > 0
        ? rawOptions.map((opt, idx) => ({
          index: idx + 1,
          optionId: String(opt?.optionId || opt?.id || `opt_${idx + 1}`),
          kind: String(opt?.kind || '').trim(),
          label: String(opt?.name || opt?.label || opt?.optionId || `选项 ${idx + 1}`).trim(),
        }))
        : [
          { index: 1, optionId: 'allow_once', kind: 'allow_once', label: 'Yes, allow this time' },
          { index: 2, optionId: 'allow_always', kind: 'allow_always', label: 'Yes, and always allow' },
          { index: 3, optionId: 'reject_once', kind: 'reject_once', label: 'No, reject' },
        ]

      const approval = {
        code,
        rpcRequestId: id,
        harness: 'antigravity-ide',
        agentId: sessionId ? `agy-ide:${sessionId}` : '',
        rawSessionId: sessionId,
        toolName: toolInfo.toolName,
        promptTitle: toolInfo.promptTitle,
        subtitle: 'Antigravity ACP permission request',
        commandLine: toolInfo.commandLine,
        reason: `${toolInfo.promptTitle}${toolInfo.commandLine && toolInfo.commandLine !== toolInfo.promptTitle ? `: ${toolInfo.commandLine}` : ''}`.slice(0, 1800),
        options: options.map(({ index, label }) => ({ index, label })),
        rawOptions: options,
        createdAt: now,
        expiresAt: now + 10 * 60_000,
      }
      this.pendingPermissions.set(code.toUpperCase(), approval)
      const turn = this.activeTurns.get(sessionId)
      if (turn) {
        turn.status = 'approval'
        turn.updatedAt = now
        turn.runningSummary = `⏳ 等待确认: ${toolInfo.promptTitle}`.slice(0, 180)
      }
      this.onStateChange?.('permission', approval)
      return
    }

    // Politely decline unsupported reverse client requests (e.g. fs/terminal) so ACP never hangs
    try {
      this._sendRaw({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Client method not implemented by headless PocketAgents ACP bridge: ${method}`,
        },
      })
    } catch {
      // ignore
    }
  }

  _handleSessionUpdate(params = {}) {
    const sessionId = String(params.sessionId || '').trim()
    const update = params.update || {}
    if (!sessionId) return
    const turn = this.activeTurns.get(sessionId)
    if (!turn) return
    const now = Date.now()
    turn.updatedAt = now
    const kind = String(update.sessionUpdate || update.type || '').trim()
    if (kind === 'agent_message_chunk') {
      const chunk = extractAcpTextFromContent(update.content)
      if (chunk) {
        turn.text = `${turn.text || ''}${chunk}`.slice(-24_000)
        turn.runningSummary = turn.text.replace(/\s+/g, ' ').trim().slice(-160)
      }
    } else if (kind === 'agent_thought_chunk') {
      const chunk = extractAcpTextFromContent(update.content)
      if (chunk) {
        turn.thinking = `${turn.thinking || ''}${chunk}`.slice(-8000)
        if (!turn.text) {
          turn.runningSummary = `💭 正在思考: ${turn.thinking.replace(/\s+/g, ' ').trim().slice(-120)}`
        }
      }
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const title = String(update.title || update.name || update.kind || '').trim()
      if (title) {
        turn.runningSummary = `🔧 正在执行: ${title}`.slice(0, 180)
      }
    }
  }

  _captureModelsFromSessionResult(result) {
    const available = Array.isArray(result?.models?.availableModels)
      ? result.models.availableModels
      : []
    if (available.length === 0) return
    const models = []
    const seen = new Set()
    for (const item of available) {
      const rawId = String(item?.modelId || item?.id || '').trim()
      const label = String(item?.name || item?.label || rawId).trim()
      if (!rawId || seen.has(rawId)) continue
      seen.add(rawId)
      models.push({ value: rawId, label })
    }
    if (models.length > 0) {
      const cur = String(result?.models?.currentModelId || '').trim()
      const def = (cur && models.find(m => m.value === cur)) || models[0]
      this.liveModelCatalog = {
        defaultModel: def.value,
        defaultLabel: def.label,
        models,
        source: 'agy-acp',
      }
    }
  }

  async checkAuthAndSessions({ cwd = '', force = false } = {}) {
    const now = Date.now()
    if (!force && this.authenticated !== null && now - this.lastAuthCheckAt < 60_000) {
      return { ok: this.authenticated, authenticated: this.authenticated }
    }
    const started = await this.ensureStarted()
    if (!started) {
      return { ok: false, authenticated: false, error: this.lastError || 'ACP 启动失败' }
    }
    try {
      const res = await this._sendRequest('session/list', cwd ? { cwd } : {}, 10_000)
      this.authenticated = true
      this.lastAuthCheckAt = now
      const sessions = Array.isArray(res?.sessions) ? res.sessions : []
      return { ok: true, authenticated: true, sessionCount: sessions.length }
    } catch (err) {
      const errMsg = err?.message || 'ACP 会话检查失败'
      const needsLogin = /sign in|not logged in|auth|unauthenticated|oauth/i.test(errMsg)
      if (needsLogin) this.authenticated = false
      this.lastAuthCheckAt = now
      return { ok: false, authenticated: false, needsLogin, error: errMsg }
    }
  }

  async _buildPromptBlocks(text = '', imagePaths = []) {
    const blocks = []
    const cleanText = String(text || '').trim()
    if (cleanText) {
      blocks.push({ type: 'text', text: cleanText })
    }
    if (Array.isArray(imagePaths) && imagePaths.length > 0) {
      for (const imgPath of imagePaths.slice(0, 6)) {
        try {
          const st = await stat(imgPath)
          if (!st.isFile() || st.size > 12 * 1024 * 1024) continue
          const ext = extname(imgPath).toLowerCase()
          const mimeType = IMAGE_MIME_BY_EXT[ext]
          if (!mimeType) continue
          const data = (await readFile(imgPath)).toString('base64')
          blocks.push({ type: 'image', mimeType, data })
        } catch {
          // ignore unreadable attachment
        }
      }
    }
    return blocks
  }

  async _applySessionModel(sessionId, requestedModel = '') {
    const cleanModel = String(requestedModel || '').trim()
    if (!cleanModel) return
    const modelSlug = this.modelSlugResolver(cleanModel) || cleanModel
    try {
      await this._sendRequest('session/set_model', { sessionId, modelId: modelSlug }, 8000)
    } catch {
      // Fallback: try split `model` + `thought_level` config options if `session/set_model` rejected
      const effortMatch = modelSlug.match(/^(.+?)-(xhigh|high|medium|low)$/i)
      if (effortMatch) {
        try {
          await this._sendRequest(
            'session/set_config_option',
            { sessionId, configId: 'model', value: effortMatch[1] },
            6000,
          )
          await this._sendRequest(
            'session/set_config_option',
            { sessionId, configId: 'thought_level', value: effortMatch[2].toLowerCase() },
            6000,
          )
        } catch {
          // ignore best-effort effort config
        }
      }
    }
  }

  async sendPrompt({
    sessionId,
    text = '',
    cwd = '',
    model = '',
    imagePaths = [],
  } = {}) {
    const rawId = String(sessionId || '').replace(/^agy-ide:/, '').trim()
    if (!rawId) return { ok: false, error: '无效的 Antigravity 会话 ID' }
    const promptBlocks = await this._buildPromptBlocks(text, imagePaths)
    if (promptBlocks.length === 0) return { ok: false, error: '发送内容不能为空' }

    const started = await this.ensureStarted()
    if (!started) {
      return { ok: false, error: this.lastError || 'agy ACP 服务未能启动' }
    }

    const effectiveCwd = String(cwd || this.home || process.cwd()).trim()
    if (!this.loadedSessions.has(rawId)) {
      try {
        const res = await this._sendRequest(
          'session/resume',
          { sessionId: rawId, cwd: effectiveCwd, mcpServers: [] },
          15_000,
        )
        this.authenticated = true
        this.loadedSessions.add(rawId)
        this._captureModelsFromSessionResult(res)
      } catch (err) {
        const msg = err?.message || '恢复会话失败'
        if (/sign in|not logged in|auth|unauthenticated/i.test(msg)) {
          this.authenticated = false
          return { ok: false, needsLogin: true, error: 'agy CLI 尚未登录，请先在电脑完成一次 Google 登录' }
        }
        return { ok: false, error: msg }
      }
    }

    if (model) {
      await this._applySessionModel(rawId, model)
    }

    const now = Date.now()
    this.activeTurns.set(rawId, {
      sessionId: rawId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      text: '',
      thinking: '',
      runningSummary: '💭 正在通过官方 agy ACP 执行...',
      cwd: effectiveCwd,
      model,
    })

    // Dispatch `session/prompt` asynchronously (a full agent turn can run for minutes)
    this._sendRequest('session/prompt', { sessionId: rawId, prompt: promptBlocks }, 30 * 60_000)
      .then(() => {
        const cur = this.activeTurns.get(rawId)
        if (cur) {
          cur.status = 'done'
          cur.updatedAt = Date.now()
        }
        setTimeout(() => {
          const latest = this.activeTurns.get(rawId)
          if (latest && latest.status === 'done') this.activeTurns.delete(rawId)
        }, 4000).unref?.()
        this.onStateChange?.('turn_done', { sessionId: rawId })
      })
      .catch(err => {
        const cur = this.activeTurns.get(rawId)
        if (cur) {
          cur.status = 'error'
          cur.error = err?.message || '执行中断'
          cur.updatedAt = Date.now()
        }
        setTimeout(() => {
          const latest = this.activeTurns.get(rawId)
          if (latest && latest.status === 'error') this.activeTurns.delete(rawId)
        }, 6000).unref?.()
        this.onStateChange?.('turn_error', { sessionId: rawId, error: err?.message })
      })

    return {
      ok: true,
      agentId: `agy-ide:${rawId}`,
      method: 'agy-acp',
      message: '📨 已通过官方 agy ACP 通道精准投递指令',
    }
  }

  async createSession({
    title = '',
    prompt = '',
    cwd = '',
    model = '',
    imagePaths = [],
  } = {}) {
    const started = await this.ensureStarted()
    if (!started) {
      return { ok: false, error: this.lastError || 'agy ACP 服务未能启动' }
    }
    const effectiveCwd = String(cwd || this.home || process.cwd()).trim()
    let newSessionId = ''
    try {
      const res = await this._sendRequest(
        'session/new',
        { cwd: effectiveCwd, mcpServers: [] },
        15_000,
      )
      this.authenticated = true
      newSessionId = String(res?.sessionId || '').trim()
      if (!newSessionId) {
        return { ok: false, error: 'ACP 未返回新会话 ID' }
      }
      this.loadedSessions.add(newSessionId)
      this._captureModelsFromSessionResult(res)
    } catch (err) {
      const msg = err?.message || '创建新会话失败'
      if (/sign in|not logged in|auth|unauthenticated/i.test(msg)) {
        this.authenticated = false
        return { ok: false, needsLogin: true, error: 'agy CLI 尚未登录，请先在电脑完成一次 Google 登录' }
      }
      return { ok: false, error: msg }
    }

    if (model) {
      await this._applySessionModel(newSessionId, model)
    }

    const cleanPrompt = String(prompt || '').trim()
    if (cleanPrompt || (Array.isArray(imagePaths) && imagePaths.length > 0)) {
      const sendRes = await this.sendPrompt({
        sessionId: newSessionId,
        text: cleanPrompt,
        cwd: effectiveCwd,
        model: '',
        imagePaths,
      })
      if (!sendRes.ok) {
        return sendRes
      }
    }

    const effectiveTitle = String(title || '').trim() || (cleanPrompt ? cleanPrompt.slice(0, 36) : 'Antigravity 新对话')
    return {
      ok: true,
      agentId: `agy-ide:${newSessionId}`,
      title: effectiveTitle,
      method: 'agy-acp',
      message: `⚡ 已通过官方 agy ACP 创建新对话「${effectiveTitle}」`,
    }
  }

  isSessionRunning(sessionId) {
    const rawId = String(sessionId || '').replace(/^agy-ide:/, '').trim()
    const turn = this.activeTurns.get(rawId)
    return Boolean(turn && (turn.status === 'running' || turn.status === 'approval'))
  }

  async cancelSession(sessionId) {
    const rawId = String(sessionId || '').replace(/^agy-ide:/, '').trim()
    if (!rawId || !this.isAlive()) return { ok: false, error: '当前没有运行中的 ACP 会话' }
    this._sendNotification('session/cancel', { sessionId: rawId })
    const turn = this.activeTurns.get(rawId)
    if (turn) {
      turn.status = 'done'
      turn.updatedAt = Date.now()
    }
    // Reject any pending permission tied to this session
    for (const [code, perm] of this.pendingPermissions.entries()) {
      if (perm.rawSessionId === rawId) {
        this.pendingPermissions.delete(code)
        try {
          this._sendRaw({
            jsonrpc: '2.0',
            id: perm.rpcRequestId,
            result: { outcome: { outcome: 'cancelled' } },
          })
        } catch {
          // ignore
        }
      }
    }
    return {
      ok: true,
      method: 'agy-acp',
      message: '⏹️ 已通过官方 agy ACP 停止当前任务',
    }
  }

  hasPendingPermission(code = '', sessionId = '') {
    const upper = String(code || '').trim().toUpperCase()
    if (upper && this.pendingPermissions.has(upper)) return true
    const rawId = String(sessionId || '').replace(/^agy-ide:/, '').trim()
    if (rawId) {
      for (const perm of this.pendingPermissions.values()) {
        if (perm.rawSessionId === rawId) return true
      }
    }
    return false
  }

  resolvePermission({ code = '', sessionId = '', allow = true, optionIndex = 1 } = {}) {
    const upper = String(code || '').trim().toUpperCase()
    let perm = upper ? this.pendingPermissions.get(upper) : null
    if (!perm && sessionId) {
      const rawId = String(sessionId).replace(/^agy-ide:/, '').trim()
      for (const item of this.pendingPermissions.values()) {
        if (item.rawSessionId === rawId) {
          perm = item
          break
        }
      }
    }
    if (!perm) return { ok: false, error: '未找到对应的 ACP 待审批请求' }
    this.pendingPermissions.delete(perm.code.toUpperCase())

    const rawOptions = Array.isArray(perm.rawOptions) ? perm.rawOptions : []
    let chosen = null
    if (!allow) {
      chosen = rawOptions.find(o => /reject|deny/i.test(o.kind || o.optionId)) || null
    } else {
      const idx = Math.max(0, Number(optionIndex || 1) - 1)
      chosen = rawOptions[idx]
        || rawOptions.find(o => /allow_once|allow/i.test(o.kind || o.optionId))
        || rawOptions[0]
        || null
    }

    const outcome = chosen
      ? { outcome: 'selected', optionId: chosen.optionId }
      : { outcome: 'cancelled' }

    try {
      this._sendRaw({
        jsonrpc: '2.0',
        id: perm.rpcRequestId,
        result: { outcome },
      })
    } catch (err) {
      return { ok: false, error: err?.message || '回传 ACP 审批结果失败' }
    }

    const turn = this.activeTurns.get(perm.rawSessionId)
    if (turn) {
      turn.status = allow ? 'running' : 'idle'
      turn.updatedAt = Date.now()
      turn.runningSummary = allow ? '🟢 已批准，正在继续执行...' : '🔴 已拒绝该操作'
    }
    return {
      ok: true,
      engine: 'agy-acp',
      code: perm.code,
      message: allow
        ? `✅ [Antigravity ACP] 已远程批准执行 (选项 ${optionIndex})`
        : '🔴 [Antigravity ACP] 已远程拒绝执行',
    }
  }

  getActiveOverlays() {
    const runningByRawId = new Map()
    for (const [rawId, turn] of this.activeTurns.entries()) {
      if (turn.status === 'running' || turn.status === 'approval') {
        runningByRawId.set(rawId, { ...turn })
      }
    }
    const approvals = [...this.pendingPermissions.values()].map(p => {
      const { rpcRequestId: _id, rawOptions: _opts, ...pub } = p
      return pub
    })
    return { runningByRawId, approvals }
  }
}

/**
 * Compute live Antigravity integration status for this host so the mobile UI can clearly distinguish
 * full Connect-RPC / ACP mode vs desktop-only fallback mode (and offer 1-tap `agy` CLI installation).
 */
export async function detectAntigravityHostStatus({
  hasLiveRpc = false,
  hasAntigravitySessions = false,
  acpClient = null,
  installing = false,
  installError = '',
  home = homedir(),
  platform = process.platform,
  execImpl = execFileAsync,
  accessImpl = access,
} = {}) {
  const [desktopInfo, cliPath] = await Promise.all([
    detectAntigravityDesktopApp({ home, platform, accessImpl }),
    findOfficialAgyCliPath({ home, platform, execImpl, accessImpl }),
  ])
  const hasCli = Boolean(cliPath)
  const hasDesktopApp = Boolean(desktopInfo.installed || hasAntigravitySessions)
  let cliVersion = ''
  if (hasCli && typeof execImpl === 'function') {
    try {
      const { stdout } = await execImpl(cliPath, ['--version'], { timeout: 3000, env: withCliEnv() })
      cliVersion = String(stdout || '').trim().split(/\r?\n/)[0]?.slice(0, 60) || ''
    } catch {
      // version check optional
    }
  }

  // Never spawn a heavy background `agy acp` child process during passive status heartbeats;
  // use cached auth state from active ACP calls or explicit `installAntigravityCli` verification.
  const cliAuthenticated = acpClient ? acpClient.authenticated : null

  let mode = 'not-installed'
  if (hasLiveRpc) {
    mode = 'connect-rpc'
  } else if (hasCli && cliAuthenticated !== false) {
    mode = 'acp'
  } else if (hasCli && cliAuthenticated === false) {
    mode = 'acp-needs-login'
  } else if (hasDesktopApp) {
    mode = 'desktop-only'
  }

  return {
    mode,
    hasDesktopApp,
    hasLiveRpc: Boolean(hasLiveRpc),
    hasCli,
    cliPath,
    cliVersion,
    cliAuthenticated,
    needsCliInstall: Boolean(!hasLiveRpc && !hasCli && hasDesktopApp),
    needsCliLogin: Boolean(!hasLiveRpc && hasCli && cliAuthenticated === false),
    installing: Boolean(installing),
    installError: String(installError || '').slice(0, 200),
    updatedAt: Date.now(),
  }
}

/**
 * Trigger official Google Antigravity CLI (`agy`) installation on the host machine.
 * Uses strictly the official installer documented at https://antigravity.google/docs/getting-started.md.
 */
async function detectMacSystemProxyEnv(execImpl = execFileAsync) {
  if (process.platform !== 'darwin' || typeof execImpl !== 'function') return {}
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy) {
    return {}
  }
  try {
    const { stdout } = await execImpl('/usr/sbin/scutil', ['--proxy'], { timeout: 2500 })
    const txt = String(stdout || '')
    const httpsEnable = /HTTPSEnable\s*:\s*1/.test(txt)
    const httpsHost = txt.match(/HTTPSProxy\s*:\s*([^\s]+)/)?.[1] || ''
    const httpsPort = txt.match(/HTTPSPort\s*:\s*(\d+)/)?.[1] || ''
    if (httpsEnable && httpsHost && httpsPort) {
      const url = `http://${httpsHost}:${httpsPort}`
      return { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url }
    }
    const httpEnable = /HTTPEnable\s*:\s*1/.test(txt)
    const httpHost = txt.match(/HTTPProxy\s*:\s*([^\s]+)/)?.[1] || ''
    const httpPort = txt.match(/HTTPPort\s*:\s*(\d+)/)?.[1] || ''
    if (httpEnable && httpHost && httpPort) {
      const url = `http://${httpHost}:${httpPort}`
      return { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url }
    }
    const socksEnable = /SOCKSEnable\s*:\s*1/.test(txt)
    const socksHost = txt.match(/SOCKSProxy\s*:\s*([^\s]+)/)?.[1] || ''
    const socksPort = txt.match(/SOCKSPort\s*:\s*(\d+)/)?.[1] || ''
    if (socksEnable && socksHost && socksPort) {
      const url = `socks5h://${socksHost}:${socksPort}`
      return { ALL_PROXY: url, all_proxy: url, HTTPS_PROXY: url, https_proxy: url }
    }
  } catch {
    // system proxy optional
  }
  return {}
}

export async function installAntigravityCli({
  acpClient = null,
  home = homedir(),
  platform = process.platform,
  execImpl = execFileAsync,
  accessImpl = access,
  spawnImpl = spawn,
} = {}) {
  const proxyEnv = platform === 'darwin' ? await detectMacSystemProxyEnv(execImpl) : {}
  const env = withCliEnv(proxyEnv)
  try {
    if (platform === 'win32') {
      await execImpl(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${AGY_INSTALL_URL_WIN} | iex`],
        { timeout: 180_000, env },
      )
    } else {
      await execImpl(
        '/bin/bash',
        ['-lc', `curl -fsSL ${AGY_INSTALL_URL_UNIX} | bash`],
        { timeout: 180_000, env },
      )
    }
  } catch (err) {
    const detail = String(err?.stderr || err?.stdout || err?.message || '安装脚本执行失败').trim().slice(0, 220)
    return {
      ok: false,
      error: `安装官方 agy CLI 失败：${detail}`,
    }
  }

  const cliPath = await findOfficialAgyCliPath({ home, platform, execImpl, accessImpl })
  if (!cliPath) {
    return {
      ok: false,
      error: '安装脚本已结束，但未在 ~/.local/bin/agy 或 ~/.gemini/bin/agy 找到可执行文件，请检查网络或代理后重试',
    }
  }

  let cliVersion = ''
  try {
    const { stdout } = await execImpl(cliPath, ['--version'], { timeout: 4000, env })
    cliVersion = String(stdout || '').trim().split(/\r?\n/)[0]?.slice(0, 60) || ''
  } catch {
    // ignore
  }

  if (acpClient) {
    acpClient.cliPath = cliPath
    acpClient.authenticated = null
    acpClient.lastAuthCheckAt = 0
    const authRes = await acpClient.checkAuthAndSessions({ force: true })
    if (authRes.authenticated) {
      return {
        ok: true,
        mode: 'acp',
        cliPath,
        cliVersion,
        authenticated: true,
        needsLogin: false,
        message: `✅ 已安装官方 agy CLI${cliVersion ? ` (${cliVersion})` : ''}，并已自动连接 ACP 直连通道！`,
      }
    }
    // Installed cleanly, needs one-time Google OAuth login — launch login helper best-effort
    await triggerAntigravityCliLogin({ cliPath, platform, spawnImpl, execImpl, home, accessImpl }).catch(() => null)
    return {
      ok: true,
      mode: 'acp-needs-login',
      cliPath,
      cliVersion,
      authenticated: false,
      needsLogin: true,
      message: '✅ 官方 agy CLI 已安装完成！已在电脑端弹出 Google 登录授权窗口，点一次确认即可解锁完整遥控',
    }
  }

  return {
    ok: true,
    mode: 'acp',
    cliPath,
    cliVersion,
    authenticated: null,
    needsLogin: false,
    message: `✅ 已成功安装官方 agy CLI${cliVersion ? ` (${cliVersion})` : ''}`,
  }
}

/**
 * Trigger the official `agy acp --login` interactive OAuth flow on the host machine.
 */
export async function triggerAntigravityCliLogin({
  cliPath = '',
  home = homedir(),
  platform = process.platform,
  execImpl = execFileAsync,
  accessImpl = access,
  spawnImpl = spawn,
} = {}) {
  const bin = cliPath || await findOfficialAgyCliPath({ home, platform, execImpl, accessImpl })
  if (!bin) {
    return { ok: false, error: '当前电脑尚未安装 agy CLI，请先点击「一键安装」' }
  }
  try {
    if (platform === 'darwin') {
      // Open macOS Terminal cleanly running `agy acp --login` so OAuth URL & browser launch smoothly
      const escaped = bin.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const script = `tell application "Terminal"
        activate
        do script "\\"${escaped}\\" acp --login --app-data-dir=antigravity"
      end tell`
      await execImpl('osascript', ['-e', script], { timeout: 6000, env: withCliEnv() })
    } else {
      const child = spawnImpl(bin, ['acp', '--login', '--app-data-dir=antigravity'], {
        detached: true,
        stdio: 'ignore',
        env: withCliEnv(),
      })
      child.unref?.()
    }
    return {
      ok: true,
      message: '🔑 已在电脑端打开官方 agy 登录授权流程，请在电脑浏览器确认 Google 登录',
    }
  } catch (err) {
    return {
      ok: false,
      error: `无法自动拉起登录窗口，请在电脑终端手动运行 agy acp --login（${err?.message || '未知错误'}）`,
    }
  }
}
