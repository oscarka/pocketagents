import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { assertSafeVoiceTargetUrl, isBlockedVoiceBaseUrl, maskSecret } from './voice-vault.js'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const MAX_CACHED_PANELS = 120

export function isLoopbackPluginUrl(raw = '') {
  try {
    const u = new URL(String(raw || '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function normalizePluginUrl(raw = '') {
  const s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    if (u.username || u.password) return ''
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''))
  } catch {
    return ''
  }
}

function normalizeBrainTarget(raw = '') {
  const s = String(raw || '').trim()
  if (!s || s === 'none') return 'none'
  if (/^cred:[A-Za-z0-9_-]{1,80}$/.test(s)) return s
  return 'none'
}

export function sanitizePluginPanel(raw = null) {
  if (!raw || typeof raw !== 'object') return null
  const toneSet = new Set(['neutral', 'info', 'success', 'warning', 'danger'])
  const rawTone = String(raw.tone || 'neutral').trim().toLowerCase()
  const tone = toneSet.has(rawTone) ? rawTone : 'neutral'
  const rawOptions = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.actions)
      ? raw.actions
      : []
  const options = rawOptions
    .slice(0, 8)
    .map((opt, idx) => {
      if (!opt || typeof opt !== 'object') return null
      const label = String(opt.label || '').trim().slice(0, 60)
      if (!label) return null
      const kindRaw = String(opt.kind || 'fill').trim().toLowerCase()
      const kind = ['fill', 'copy', 'send', 'callback'].includes(kindRaw) ? kindRaw : 'fill'
      const styleRaw = String(opt.style || (idx === 0 ? 'primary' : 'default')).trim().toLowerCase()
      const style = ['primary', 'default', 'ghost', 'danger'].includes(styleRaw) ? styleRaw : 'default'
      return {
        id: String(opt.id || `opt_${idx}`).slice(0, 64),
        label,
        kind,
        style,
        text: String(opt.text ?? opt.fillText ?? '').slice(0, 6000),
        actionId: String(opt.actionId || opt.id || `act_${idx}`).slice(0, 64),
        inputPlaceholder: String(opt.inputPlaceholder || '').trim().slice(0, 120),
        payload: opt.payload && typeof opt.payload === 'object' ? opt.payload : undefined,
      }
    })
    .filter(Boolean)

  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(t => String(t || '').trim().slice(0, 32)).filter(Boolean).slice(0, 8)
    : []

  const title = String(raw.title || '').trim().slice(0, 100)
  const badge = String(raw.badge || '').trim().slice(0, 40)
  const subtitle = String(raw.subtitle || '').trim().slice(0, 160)
  const thinking = String(raw.thinking || '').slice(0, 16000)
  const body = String(raw.body ?? raw.summary ?? '').slice(0, 8000)

  if (!title && !badge && !thinking && !body && options.length === 0) {
    return null
  }

  return {
    id: String(raw.id || `pnl_${Date.now()}`).slice(0, 64),
    title,
    badge,
    tone,
    subtitle,
    thinking,
    thinkingCollapsed: raw.thinkingCollapsed === true,
    body,
    tags,
    options,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  }
}

export class GoalCopilotBridge {
  constructor({
    hub,
    voiceVault = null,
    configFile = '',
    defaultPluginUrl = process.env.GOAL_COPILOT_PLUGIN_URL || '',
    fetchImpl = globalThis.fetch,
    logger = console,
  } = {}) {
    this.hub = hub
    this.voiceVault = voiceVault
    this.configFile = String(configFile || '').trim()
    this.fetch = fetchImpl
    this.logger = logger
    const normEnv = normalizePluginUrl(defaultPluginUrl)
    this.config = {
      enabled: Boolean(normEnv),
      pluginUrl: normEnv,
      authToken: String(process.env.GOAL_COPILOT_PLUGIN_TOKEN || '').trim(),
      brainTarget: 'none',
    }
    this._inFlightCompleted = new Set()
    this._panelCache = new Map()
    this._loadConfigSync()
  }

  _loadConfigSync() {
    if (!this.configFile || !existsSync(this.configFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.configFile, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        const url = normalizePluginUrl(parsed.pluginUrl || '')
        this.config = {
          enabled: Boolean(parsed.enabled && url),
          pluginUrl: url,
          authToken: String(parsed.authToken || '').trim(),
          brainTarget: normalizeBrainTarget(parsed.brainTarget),
        }
      }
    } catch { }
  }

  _saveConfigSync() {
    if (!this.configFile) return
    try {
      mkdirSync(dirname(this.configFile), { recursive: true, mode: 0o700 })
      const tmp = `${this.configFile}.tmp.${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(tmp, 0o600) } catch { }
      renameSync(tmp, this.configFile)
      try { chmodSync(this.configFile, 0o600) } catch { }
    } catch { }
  }

  getConfig() {
    const token = String(this.config.authToken || '').trim()
    return {
      enabled: Boolean(this.config.enabled && this.config.pluginUrl),
      pluginUrl: this.config.pluginUrl || '',
      hasAuthToken: Boolean(token),
      authTokenPreview: token ? maskSecret(token) : '',
      brainTarget: normalizeBrainTarget(this.config.brainTarget),
      isLoopback: isLoopbackPluginUrl(this.config.pluginUrl),
    }
  }

  updateConfig({ enabled, pluginUrl, authToken, brainTarget } = {}) {
    const nextUrl = pluginUrl !== undefined ? normalizePluginUrl(pluginUrl) : this.config.pluginUrl
    if (pluginUrl !== undefined && String(pluginUrl || '').trim()) {
      if (!nextUrl) {
        return { ok: false, error: '插件地址格式无效，请输入 http:// 或 https:// 开头的地址（如 http://127.0.0.1:8789）' }
      }
      if (isBlockedVoiceBaseUrl(nextUrl, { allowLocal: true })) {
        return { ok: false, error: '已拦截不安全的云元数据或保留地址（SSRF 防护）' }
      }
    }
    const nextEnabled = enabled !== undefined ? Boolean(enabled) : this.config.enabled
    let nextToken = this.config.authToken || ''
    if (authToken !== undefined) {
      const cleanToken = String(authToken || '').trim()
      // Empty string keeps existing token unless caller passes explicit clear marker or replaces it;
      // pass null to explicitly clear saved token.
      if (authToken === null) {
        nextToken = ''
      } else if (cleanToken) {
        nextToken = cleanToken.slice(0, 512)
      }
    }
    const nextBrain = brainTarget !== undefined ? normalizeBrainTarget(brainTarget) : this.config.brainTarget
    this.config = {
      enabled: Boolean(nextEnabled && nextUrl),
      pluginUrl: nextUrl,
      authToken: nextToken,
      brainTarget: nextBrain,
    }
    this._saveConfigSync()
    return { ok: true, config: this.getConfig() }
  }

  _buildPluginHeaders(extra = {}) {
    const headers = { ...extra }
    const token = String(this.config.authToken || '').trim()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    return headers
  }

  async _assertSafePluginUrl(url = '') {
    // Allow loopback/LAN for self-hosted local plugins, while strictly blocking cloud metadata
    // (169.254.169.254, 100.64.0.0/10, metadata.google.internal, link-local IPv6, multicast).
    await assertSafeVoiceTargetUrl(url, {
      allowLocal: true,
      resolveDns: this.fetch === globalThis.fetch,
    })
  }

  async _resolveLoopbackBrainLlmConfig() {
    // Strictly opt-in & independent from Walk Mode: ONLY forward credentials when
    // (1) user explicitly picked a `cred:<id>` for this plugin, AND (2) pluginUrl is loopback!
    if (!isLoopbackPluginUrl(this.config.pluginUrl)) return null
    const target = normalizeBrainTarget(this.config.brainTarget)
    if (!target.startsWith('cred:') || !this.voiceVault) return null
    const credId = target.slice(5)
    try {
      await this.voiceVault.init()
      const cred = this.voiceVault.resolveCredential({ credId })
      if (!cred || !cred.apiKey) return null
      if (cred.provider !== 'gemini' && cred.provider !== 'openai_compat') return null
      return {
        provider: cred.provider,
        model: cred.defaultModel || '',
        baseUrl: cred.baseUrl || '',
        apiKey: cred.apiKey,
      }
    } catch {
      return null
    }
  }

  _cachePanel(hostId = '', agentId = '', panel = null) {
    if (!agentId) return
    const key = `${String(hostId || 'local')}::${String(agentId)}`
    if (!panel) {
      this._panelCache.delete(key)
      return
    }
    this._panelCache.delete(key)
    this._panelCache.set(key, panel)
    if (this._panelCache.size > MAX_CACHED_PANELS) {
      const oldestKey = this._panelCache.keys().next().value
      this._panelCache.delete(oldestKey)
    }
  }

  getCachedPanel({ hostId = '', agentId = '' } = {}) {
    if (!this.getConfig().enabled) {
      return { ok: true, enabled: false, panel: null }
    }
    const key = `${String(hostId || 'local')}::${String(agentId || '')}`
    return {
      ok: true,
      enabled: true,
      panel: this._panelCache.get(key) || null,
    }
  }

  _findTaskContext(hostId = '', agentId = '') {
    const host = this.hub?.hosts?.get(hostId) || null
    const bridgeState = host?.bridgeState || {}
    const tasks = Array.isArray(bridgeState.tasks) ? bridgeState.tasks : []
    const task = tasks.find(t => t && t.id === agentId) || null
    const approvals = (Array.isArray(bridgeState.approvals) ? bridgeState.approvals : [])
      .filter(a => !agentId || a.agentId === agentId)
    const rawTr = Array.isArray(task?.transcript) ? task.transcript : []
    const recentTurns = rawTr
      .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-8)
      .map(m => ({
        role: m.role,
        text: String(m.text || m.content || '').slice(0, 1200),
      }))
    const lastAssistant = [...recentTurns].reverse().find(m => m.role === 'assistant')
    return {
      hostName: host?.hostName || hostId,
      sessionTitle: task?.title || '',
      harness: task?.harness || '',
      project: task?.project || '',
      cwd: task?.cwd || '',
      lastOutput: String(task?.lastOutput || lastAssistant?.text || '').slice(0, 6000),
      recentTurns,
      pendingApprovals: approvals.map(a => ({
        code: a.code,
        title: a.promptTitle || a.title || a.toolName || '',
        riskLevel: a.riskLevel || a.risk || 'L1',
      })),
    }
  }

  async _fetchPluginJson(path, { method = 'GET', body = null, timeoutMs = 6000 } = {}) {
    const cfg = this.getConfig()
    if (!cfg.pluginUrl) {
      return { ok: false, offline: true, error: '未配置外部插件地址' }
    }
    const targetUrl = `${cfg.pluginUrl}${path}`
    try {
      await this._assertSafePluginUrl(targetUrl)
    } catch {
      return { ok: false, error: '已拦截不安全的插件地址（SSRF 防护）' }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await this.fetch(targetUrl, {
        method,
        redirect: 'error',
        headers: this._buildPluginHeaders(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        return { ok: false, status: resp.status, error: data?.error || `Plugin HTTP ${resp.status}`, data }
      }
      return { ok: true, status: resp.status, data }
    } catch (err) {
      return {
        ok: false,
        offline: true,
        error: err?.name === 'AbortError' ? '连接插件超时' : (err?.message || '无法连接外挂插件'),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async checkHealth(overrideUrl = '') {
    const rawCandidate = String(overrideUrl || '').trim()
    const targetUrl = rawCandidate ? normalizePluginUrl(rawCandidate) : this.config.pluginUrl
    const cfg = this.getConfig()
    if (rawCandidate && !targetUrl) {
      return { ok: true, enabled: cfg.enabled, connected: false, pluginUrl: '', detail: null, error: '插件地址格式无效' }
    }
    if (!targetUrl) {
      return { ok: true, enabled: false, connected: false, pluginUrl: '', detail: null }
    }
    try {
      await this._assertSafePluginUrl(`${targetUrl}/health`)
    } catch {
      return {
        ok: true,
        enabled: cfg.enabled,
        connected: false,
        pluginUrl: targetUrl,
        detail: null,
        error: '已拦截不安全的地址（SSRF 防护）',
      }
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2200)
    try {
      const resp = await this.fetch(`${targetUrl}/health`, {
        method: 'GET',
        redirect: 'error',
        headers: this._buildPluginHeaders(),
        signal: ctrl.signal,
      })
      const data = await resp.json().catch(() => ({}))
      const connected = Boolean(resp.ok && data?.ok)
      const detail = connected
        ? {
            name: String(data.name || '外部插件').slice(0, 60),
            shortLabel: String(data.shortLabel || '').slice(0, 20),
            version: String(data.version || '').slice(0, 32),
            statusText: String(data.statusText || '已连接').slice(0, 120),
          }
        : null
      return {
        ok: true,
        enabled: cfg.enabled,
        connected,
        pluginUrl: targetUrl,
        detail,
        error: connected ? '' : (data?.error || `HTTP ${resp.status}`),
      }
    } catch (err) {
      return {
        ok: true,
        enabled: cfg.enabled,
        connected: false,
        pluginUrl: targetUrl,
        detail: null,
        error: err?.name === 'AbortError' ? '连接超时（请确认外挂服务已启动）' : '外挂服务未启动或不可达',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async streamPanel({ hostId = '', agentId = '', event = 'manual_trigger', lastOutputOverride = '', signal } = {}) {
    const cfg = this.getConfig()
    if (!cfg.enabled || !cfg.pluginUrl) {
      return { status: 400, json: { ok: false, error: '请先在「设置 → 目标副驾插件 (Beta)」中启用并填写插件地址' } }
    }
    const streamUrl = `${cfg.pluginUrl}/api/panel/stream`
    const jsonUrl = `${cfg.pluginUrl}/api/panel`
    try {
      await this._assertSafePluginUrl(streamUrl)
    } catch {
      return { status: 400, json: { ok: false, error: '已拦截不安全的插件地址（SSRF 防护）' } }
    }

    const ctx = this._findTaskContext(hostId, agentId)
    const llmConfig = await this._resolveLoopbackBrainLlmConfig()
    const payload = {
      event: String(event || 'manual_trigger'),
      hostId: hostId || 'local',
      agentId: agentId || '',
      ...ctx,
      ...(lastOutputOverride ? { lastOutput: String(lastOutputOverride).slice(0, 6000) } : {}),
      ...(llmConfig ? { llmConfig } : {}),
    }

    let resp
    try {
      resp = await this.fetch(streamUrl, {
        method: 'POST',
        redirect: 'error',
        headers: this._buildPluginHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
        signal,
      })
    } catch (err) {
      return {
        status: 502,
        json: { ok: false, error: `无法连接外挂插件服务（${cfg.pluginUrl}）：${err?.message || '连接失败'}` },
      }
    }

    // Automatic fallback to simple JSON `POST /api/panel` if plugin does not implement SSE streaming!
    if (resp.status === 404 || resp.status === 405) {
      const jsonRes = await this._fetchPluginJson('/api/panel', {
        method: 'POST',
        body: payload,
        timeoutMs: 60_000,
      })
      if (!jsonRes.ok) {
        return { status: 502, json: { ok: false, error: jsonRes.error || '外挂服务请求失败' } }
      }
      const panel = sanitizePluginPanel(jsonRes.data?.panel ?? jsonRes.data)
      this._cachePanel(hostId, agentId, panel)
      return { status: 200, json: { ok: true, panel } }
    }

    if (!resp.ok || !resp.body) {
      const errBody = await resp.text().catch(() => '')
      return { status: 502, json: { ok: false, error: `外挂服务返回异常 (${resp.status}): ${errBody.slice(0, 180)}` } }
    }

    const ct = String(resp.headers?.get?.('content-type') || '').toLowerCase()
    if (ct.includes('application/json')) {
      const data = await resp.json().catch(() => ({}))
      const panel = sanitizePluginPanel(data?.panel ?? data)
      this._cachePanel(hostId, agentId, panel)
      return { status: 200, json: { ok: true, panel } }
    }

    // Pass through SSE stream and capture final `result` panel into Hub cache seamlessly
    const bridge = this
    const nodeStream = Readable.fromWeb(resp.body)
    let sseBuf = ''
    let curEvent = ''
    const tee = new Readable({
      read() { },
    })
    nodeStream.on('data', chunk => {
      tee.push(chunk)
      try {
        sseBuf += chunk.toString('utf8')
        const lines = sseBuf.split('\n')
        sseBuf = lines.pop() || ''
        for (const rawLine of lines) {
          const line = rawLine.trimEnd()
          if (line.startsWith('event:')) {
            curEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const rawJson = line.slice(5).trim()
            if (curEvent === 'result' && rawJson) {
              const parsed = JSON.parse(rawJson)
              const panel = sanitizePluginPanel(parsed?.panel ?? parsed)
              if (panel) bridge._cachePanel(hostId, agentId, panel)
            }
          } else if (line === '') {
            curEvent = ''
          }
        }
      } catch { }
    })
    nodeStream.on('end', () => tee.push(null))
    nodeStream.on('error', err => tee.destroy(err))

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      stream: tee,
    }
  }

  async runAction({ hostId = '', agentId = '', actionId = '', payload = null, inputText = '' } = {}) {
    if (!this.getConfig().enabled) {
      return { ok: false, error: '外部插件未启用' }
    }
    const ctx = this._findTaskContext(hostId, agentId)
    const llmConfig = await this._resolveLoopbackBrainLlmConfig()
    const res = await this._fetchPluginJson('/api/action', {
      method: 'POST',
      timeoutMs: 30_000,
      body: {
        hostId: hostId || 'local',
        agentId: agentId || '',
        actionId: String(actionId || '').slice(0, 64),
        payload: payload && typeof payload === 'object' ? payload : undefined,
        inputText: String(inputText || '').slice(0, 4000),
        ...ctx,
        ...(llmConfig ? { llmConfig } : {}),
      },
    })
    if (!res.ok) {
      return { ok: false, error: res.error }
    }
    const data = res.data || {}
    let panel = undefined
    if ('panel' in data) {
      panel = data.panel === null ? null : sanitizePluginPanel(data.panel)
      this._cachePanel(hostId, agentId, panel)
    }
    return {
      ok: true,
      toast: String(data.toast || '').trim().slice(0, 120),
      fillText: String(data.fillText || '').slice(0, 6000),
      ...(panel !== undefined ? { panel } : {}),
    }
  }

  async notifyUserSpoke({ hostId = '', agentId = '' } = {}) {
    if (!this.getConfig().enabled || !agentId) return
    await this._fetchPluginJson('/api/events/user-spoke', {
      method: 'POST',
      body: { hostId: hostId || 'local', agentId },
      timeoutMs: 1200,
    }).catch(() => { })
  }

  /**
   * 非阻塞旁路监听：AI 回合完成时异步询问外部插件是否返回展示栏与推送提醒。
   * 无论外挂在线、超时还是报错，绝不影响 PocketAgents 主服务运行。
   */
  async handleTaskCompleted({ hostId = '', hostName = '', task = null, approvals = [] } = {}) {
    try {
      const cfg = this.getConfig()
      if (!cfg.enabled || !cfg.pluginUrl || !task?.id) return
      const key = `${hostId}::${task.id}`
      if (this._inFlightCompleted.has(key)) return
      this._inFlightCompleted.add(key)
      try {
        const ctx = this._findTaskContext(hostId, task.id)
        const llmConfig = await this._resolveLoopbackBrainLlmConfig()
        const res = await this._fetchPluginJson('/api/panel', {
          method: 'POST',
          timeoutMs: 60_000,
          body: {
            event: 'task_completed',
            hostId,
            agentId: task.id,
            ...ctx,
            pendingApprovals: (approvals || []).map(a => ({
              code: a.code,
              title: a.promptTitle || a.title || a.toolName || '',
              riskLevel: a.riskLevel || a.risk || 'L1',
            })),
            ...(llmConfig ? { llmConfig } : {}),
          },
        })
        if (!res.ok) return
        const panel = sanitizePluginPanel(res.data?.panel ?? res.data)
        if (panel) {
          this._cachePanel(hostId, task.id, panel)
        }
        const notify = res.data?.notify || res.data?.panel?.notify
        if (notify && typeof notify === 'object' && this.hub?.broadcastWebPush) {
          const title = String(notify.title || panel?.title || `🔌 插件提醒 · ${task.title || hostName}`).slice(0, 120)
          const body = String(notify.body || panel?.body || '').slice(0, 240)
          if (title || body) {
            void this.hub.broadcastWebPush({
              title,
              body,
              tag: `plugin-${task.id}`,
              data: {
                type: 'plugin_panel',
                hostId,
                hostName,
                agentId: task.id,
                url: `/?host=${encodeURIComponent(hostId)}&task=${encodeURIComponent(task.id)}`,
              },
            })
          }
        }
      } finally {
        this._inFlightCompleted.delete(key)
      }
    } catch {
      // 完全静默隔离，绝不抛错影响主服务
    }
  }
}
