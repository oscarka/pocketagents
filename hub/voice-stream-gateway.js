import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { buildDynamicVoiceContext, resamplePcm16Mono } from './voice-copilot.js'
import { assertSafeVoiceWsUrl } from './voice-vault.js'
import { WS_OPEN, acceptWebSocketUpgrade, connectWebSocket, rejectUpgradeSocket } from './ws-lite.js'

const MAX_ACTIVE_STREAM_SESSIONS = 16
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000
const PING_INTERVAL_MS = 25_000

// ── 1. Volcengine SAUC v3 Binary Protocol Helpers ─────────────────────────────

export function buildVolcSaucHeader(msgType, flags, serialization, compression) {
  const header = Buffer.alloc(4)
  header[0] = 0x11 // v1, 4-byte header
  header[1] = ((msgType & 0x0f) << 4) | (flags & 0x0f)
  header[2] = ((serialization & 0x0f) << 4) | (compression & 0x0f)
  header[3] = 0x00
  return header
}

export function buildVolcSaucFullRequest(payloadObj = {}) {
  const jsonBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const compressed = gzipSync(jsonBuf)
  const header = buildVolcSaucHeader(0x1, 0x0, 0x1, 0x1) // Full Client Request, JSON, Gzip
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32BE(compressed.length, 0)
  return Buffer.concat([header, sizeBuf, compressed])
}

export function buildVolcSaucAudioPacket(pcmBuf, { isLast = false, compress = false } = {}) {
  const raw = Buffer.isBuffer(pcmBuf) ? pcmBuf : Buffer.from(pcmBuf || [])
  const payload = compress && raw.length > 0 ? gzipSync(raw) : raw
  const flags = isLast ? 0x2 : 0x0
  const compression = compress && raw.length > 0 ? 0x1 : 0x0
  const header = buildVolcSaucHeader(0x2, flags, 0x0, compression) // Audio-Only Request, raw PCM
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, sizeBuf, payload])
}

export function parseVolcSaucServerFrame(frameBuf) {
  const buf = Buffer.isBuffer(frameBuf) ? frameBuf : Buffer.from(frameBuf || [])
  if (buf.length < 4) return null
  const headerWords = Math.max(1, buf[0] & 0x0f)
  const headerSize = headerWords * 4
  const msgType = (buf[1] & 0xf0) >> 4
  const flags = buf[1] & 0x0f
  const serialization = (buf[2] & 0xf0) >> 4
  const compression = buf[2] & 0x0f

  let offset = headerSize
  if (msgType === 0x0f) {
    // Server error frame: 4-byte errorCode + 4-byte msgSize + payload
    const errorCode = buf.length >= offset + 4 ? buf.readUInt32BE(offset) : 0
    offset += 4
    const msgSize = buf.length >= offset + 4 ? buf.readUInt32BE(offset) : 0
    offset += 4
    let rawMsg = buf.subarray(offset, msgSize > 0 ? Math.min(buf.length, offset + msgSize) : buf.length)
    if (compression === 0x1 && rawMsg.length > 0) {
      try { rawMsg = gunzipSync(rawMsg) } catch { }
    }
    const text = rawMsg.toString('utf8').trim()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { }
    return {
      msgType,
      flags,
      isError: true,
      errorCode,
      errorMessage: parsed?.error || parsed?.message || text || `Volcengine SAUC error ${errorCode}`,
      payload: parsed,
    }
  }

  let sequence = null
  if ((flags & 0x01) !== 0) {
    if (buf.length < offset + 4) return null
    sequence = buf.readInt32BE(offset)
    offset += 4
  }
  if (buf.length < offset + 4) return null
  const payloadSize = buf.readUInt32BE(offset)
  offset += 4
  if (payloadSize === 0 || offset >= buf.length) {
    return { msgType, flags, sequence, isLast: (flags & 0x02) !== 0, payload: null }
  }
  let rawPayload = buf.subarray(offset, Math.min(buf.length, offset + payloadSize))
  if (compression === 0x1) {
    try {
      rawPayload = gunzipSync(rawPayload)
    } catch {
      return { msgType, flags, sequence, isLast: (flags & 0x02) !== 0, payload: null }
    }
  }
  let payload = null
  if (serialization === 0x1 || rawPayload[0] === 0x7b) {
    try {
      payload = JSON.parse(rawPayload.toString('utf8'))
    } catch {
      payload = { rawText: rawPayload.toString('utf8') }
    }
  } else {
    payload = { rawText: rawPayload.toString('utf8') }
  }
  return {
    msgType,
    flags,
    sequence,
    isLast: (flags & 0x02) !== 0,
    isError: false,
    payload,
  }
}

// ── 2. Provider Capability & Endpoint Resolution ──────────────────────────────

export function isVolcengineStreamingResource(resourceId = '', baseUrl = '') {
  const r = String(resourceId || '').trim().toLowerCase()
  const u = String(baseUrl || '').trim().toLowerCase()
  return r.includes('.sauc') || u.includes('/sauc/')
}

export function isOfficialOpenAiBaseUrl(baseUrl = '') {
  const s = String(baseUrl || '').trim()
  if (!s) return false
  try {
    return new URL(s).hostname.toLowerCase() === 'api.openai.com'
  } catch {
    return false
  }
}

export function resolveDashScopeRealtimeWsUrl(baseUrl = '', model = '') {
  const raw = String(baseUrl || '').trim()
  let wsBase = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
  if (raw) {
    try {
      const parsed = new URL(raw)
      const host = parsed.hostname.toLowerCase()
      if (parsed.protocol === 'wss:' || parsed.protocol === 'ws:') {
        wsBase = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '') || '/api-ws/v1/realtime'}`
      } else if (host.includes('dashscope-intl')) {
        wsBase = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime'
      } else if (host.includes('.maas.aliyuncs.com')) {
        wsBase = `wss://${parsed.host}/api-ws/v1/realtime`
      } else if (host && host !== 'dashscope.aliyuncs.com') {
        // Custom OpenAI/DashScope proxy host
        wsBase = `${parsed.protocol === 'http:' ? 'ws:' : 'wss:'}//${parsed.host}/api-ws/v1/realtime`
      }
    } catch { }
  }
  if (!model) return wsBase
  const sep = wsBase.includes('?') ? '&' : '?'
  return `${wsBase}${sep}model=${encodeURIComponent(model)}`
}

export function resolveDeepgramWsUrl(baseUrl = '', { model = 'nova-3', language = 'multi' } = {}) {
  const raw = String(baseUrl || '').trim()
  let wsBase = 'wss://api.deepgram.com/v1/listen'
  if (raw) {
    try {
      const parsed = new URL(raw)
      const proto = parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? 'ws:' : 'wss:'
      const cleanPath = parsed.pathname.replace(/\/+$/, '')
      wsBase = `${proto}//${parsed.host}${cleanPath.endsWith('/listen') ? cleanPath : `${cleanPath || '/v1'}/listen`}`
    } catch { }
  }
  const params = new URLSearchParams({
    model: String(model || 'nova-3').trim() || 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    vad_events: 'true',
    endpointing: '400',
    utterance_end_ms: '1000',
    smart_format: 'true',
    language: String(language || 'multi').trim() || 'multi',
  })
  return `${wsBase}?${params.toString()}`
}

export function resolveVolcSaucWsUrl(baseUrl = '') {
  const raw = String(baseUrl || '').trim()
  if (raw) {
    try {
      const parsed = new URL(raw)
      if ((parsed.protocol === 'wss:' || parsed.protocol === 'ws:') && parsed.pathname.includes('/sauc/')) {
        return raw
      }
      if (parsed.hostname.toLowerCase() !== 'openspeech.bytedance.com' && parsed.hostname) {
        const proto = parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? 'ws:' : 'wss:'
        return `${proto}//${parsed.host}/api/v3/sauc/bigmodel_async`
      }
    } catch { }
  }
  return 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
}

export function resolveOpenAiRealtimeWsUrl(baseUrl = '', query = '') {
  const raw = String(baseUrl || '').trim()
  let wsBase = 'wss://api.openai.com/v1/realtime'
  if (raw) {
    try {
      const parsed = new URL(raw)
      const proto = parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? 'ws:' : 'wss:'
      const cleanPath = parsed.pathname.replace(/\/+$/, '')
      const basePath = cleanPath.endsWith('/realtime') ? cleanPath : `${cleanPath || '/v1'}/realtime`
      wsBase = `${proto}//${parsed.host}${basePath}`
    } catch { }
  }
  return query ? `${wsBase}?${query}` : wsBase
}

export function buildVolcSaucHeaders(cred, resourceId = '') {
  const resId = String(resourceId || cred?.resourceId || 'volc.seedasr.sauc.duration').trim() || 'volc.seedasr.sauc.duration'
  const headers = {
    'X-Api-Resource-Id': resId,
    'X-Api-Connect-Id': randomUUID(),
  }
  if (cred?.apiKey) {
    headers['X-Api-Key'] = cred.apiKey
  } else {
    if (cred?.appId) headers['X-Api-App-Key'] = cred.appId
    if (cred?.accessToken) headers['X-Api-Access-Key'] = cred.accessToken
  }
  return headers
}

/**
 * Resolves the concrete streaming strategy for a given VoiceVault state.
 * - Route A (`mode: 'realtime'`): 1-Key All-in-One S2S (DashScope Qwen Omni or OpenAI Realtime)
 * - Route B (`mode: 'pipeline'`): Streaming ASR (Volc SAUC / Qwen ASR Realtime / Deepgram / OpenAI Realtime STT)
 *                                  + ANY Brain (`voiceCopilot.runBrainTurn`) + ANY TTS (`voiceCopilot.runTts`)
 */
export function resolveVoiceStreamPlan(vault, { requestedMode = 'auto', profileId = '' } = {}) {
  const prefs = vault?.state?.prefs || {}
  const profile = vault?.getProfileById ? vault.getProfileById(profileId) : null
  const wantMode = requestedMode && requestedMode !== 'auto'
    ? String(requestedMode).toLowerCase()
    : String(prefs.voiceMode || 'pipeline').toLowerCase()

  // Route A: 1-Key All-in-One Realtime S2S
  if (wantMode === 'realtime') {
    let cred = prefs.realtimeCredId
      ? vault.resolveCredential({ credId: prefs.realtimeCredId })
      : null
    if (!cred) {
      cred = vault.resolveCredential({ provider: 'dashscope' })
        || (vault.state?.credentials || []).find(
          c => c.enabled !== false && c.provider === 'openai_compat' && isOfficialOpenAiBaseUrl(c.baseUrl),
        )
        || null
    }
    if (!cred) {
      return {
        supported: false,
        mode: 'realtime',
        reason: '未找到支持一键实时通话的密钥，请先添加阿里云百炼或 OpenAI 官方密钥',
      }
    }
    if (cred.provider === 'dashscope') {
      const rawModel = String(prefs.realtimeModel || cred.defaultModel || '').trim()
      const model = /omni/i.test(rawModel) ? rawModel : 'qwen3.8-omni-flash-realtime'
      const voice = String(prefs.realtimeVoice || cred.defaultVoice || 'Tina').trim() || 'Tina'
      return {
        supported: true,
        mode: 'realtime',
        adapter: 'qwen_omni_realtime',
        providerLabel: '通义千问 Omni 实时通话',
        cred,
        model,
        voice,
        profile,
      }
    }
    if (cred.provider === 'openai_compat') {
      const rawModel = String(prefs.realtimeModel || cred.defaultModel || '').trim()
      const model = /realtime/i.test(rawModel) ? rawModel : 'gpt-realtime-mini'
      const voice = String(prefs.realtimeVoice || cred.defaultVoice || 'shimmer').trim() || 'shimmer'
      return {
        supported: true,
        mode: 'realtime',
        adapter: 'openai_realtime',
        providerLabel: 'OpenAI 实时通话',
        cred,
        model,
        voice,
        profile,
      }
    }
    return {
      supported: false,
      mode: 'realtime',
      reason: `当前密钥类型（${cred.provider}）不支持一键实时通话，请选择阿里云百炼或 OpenAI 官方密钥`,
    }
  }

  // Route B: Mix-and-Match Streaming Ear + Arbitrary Brain + Arbitrary TTS
  if (prefs.streamingSttEnabled === false) {
    return { supported: false, mode: 'pipeline', reason: '流式实时听写已在设置中关闭' }
  }
  const sttStage = profile?.stt || {}
  const sttProv = String(sttStage.provider || 'native').toLowerCase()
  if (sttProv === 'native') {
    return { supported: false, mode: 'pipeline', reason: '当前听写为手机自带原生模式' }
  }
  const cred = vault.resolveCredential({ provider: sttProv, credId: sttStage.credId })
  if (!cred) {
    return { supported: false, mode: 'pipeline', reason: `未找到可用的 ${sttProv} 听写密钥` }
  }

  if (sttProv === 'volcengine_asr') {
    const resId = String(sttStage.model || cred.resourceId || '').trim()
    if (!isVolcengineStreamingResource(resId, cred.baseUrl)) {
      return {
        supported: false,
        mode: 'pipeline',
        reason: '当前火山听写为录音文件版（auc），如需边说边出字幕请将 Resource ID 切为 volc.seedasr.sauc.duration',
      }
    }
    return {
      supported: true,
      mode: 'pipeline',
      adapter: 'volcengine_sauc',
      providerLabel: '豆包流式实时听写 2.0',
      cred,
      model: resId || 'volc.seedasr.sauc.duration',
      language: sttStage.language || 'zh-CN',
      profile,
    }
  }

  if (sttProv === 'dashscope') {
    const rawModel = String(sttStage.model || cred.defaultModel || '').trim()
    const model = /asr/i.test(rawModel) ? rawModel : 'qwen3-asr-flash-realtime'
    return {
      supported: true,
      mode: 'pipeline',
      adapter: 'qwen_asr_realtime',
      providerLabel: '千问流式实时听写',
      cred,
      model,
      language: sttStage.language || 'zh-CN',
      profile,
    }
  }

  if (sttProv === 'deepgram') {
    const model = String(sttStage.model || cred.defaultModel || 'nova-3').trim() || 'nova-3'
    return {
      supported: true,
      mode: 'pipeline',
      adapter: 'deepgram',
      providerLabel: 'Deepgram Nova-3 实时听写',
      cred,
      model,
      language: sttStage.language || 'multi',
      profile,
    }
  }

  if (sttProv === 'openai_compat' && isOfficialOpenAiBaseUrl(cred.baseUrl)) {
    const rawModel = String(sttStage.model || cred.defaultModel || '').trim()
    const model = /transcribe/i.test(rawModel) ? rawModel : 'gpt-4o-mini-transcribe'
    return {
      supported: true,
      mode: 'pipeline',
      adapter: 'openai_realtime_stt',
      providerLabel: 'OpenAI 实时听写',
      cred,
      model,
      language: sttStage.language || 'zh',
      profile,
    }
  }

  return {
    supported: false,
    mode: 'pipeline',
    reason: `当前听写服务商（${sttProv}）走标准录音识别模式`,
  }
}

// ── 3. Route B Streaming ASR Adapters ─────────────────────────────────────────

class VolcengineSaucAdapter {
  constructor({ cred, model, hotwords = [], connectWs = connectWebSocket, callbacks = {} }) {
    this.cred = cred
    this.model = model || cred?.resourceId || 'volc.seedasr.sauc.duration'
    this.hotwords = hotwords
    this.connectWs = connectWs
    this.cb = callbacks
    this.ws = null
    this.pcmPending = Buffer.alloc(0)
    this.emittedUtterances = new Set()
    this.lastPartial = ''
    this.closed = false
  }

  async connect() {
    const wsUrl = resolveVolcSaucWsUrl(this.cred?.baseUrl)
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: this.connectWs === connectWebSocket })
    const headers = buildVolcSaucHeaders(this.cred, this.model)
    this.ws = await this.connectWs(wsUrl, { headers, timeoutMs: 15_000 })

    this.ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      const frame = parseVolcSaucServerFrame(data)
      if (!frame) return
      if (frame.isError) {
        this.cb.onError?.(new Error(frame.errorMessage || `豆包流式听写错误 (${frame.errorCode})`))
        return
      }
      this._handleResultPayload(frame.payload)
    })
    this.ws.on('error', err => {
      if (!this.closed) this.cb.onError?.(err)
    })
    this.ws.on('close', (code, reason) => {
      if (!this.closed) this.cb.onClose?.(code, reason)
    })

    const formattedHotwords = [...new Set(
      (Array.isArray(this.hotwords) ? this.hotwords : [])
        .map(w => String(w || '').trim())
        .filter(w => w.length >= 2 && w.length <= 24),
    )]
      .slice(0, 30)
      .map(word => ({ word }))

    const fullReq = buildVolcSaucFullRequest({
      user: { uid: 'pocketagents-stream' },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        end_window_size: 800,
        result_type: 'single',
        ...(formattedHotwords.length > 0
          ? { corpus: { context: JSON.stringify({ hotwords: formattedHotwords }) } }
          : {}),
      },
    })
    this.ws.sendBinary(fullReq)
  }

  _handleResultPayload(payload) {
    if (!payload || typeof payload !== 'object') return
    const result = payload.result || payload
    const utterances = Array.isArray(result?.utterances) ? result.utterances : []
    if (utterances.length > 0) {
      let liveTail = ''
      for (let i = 0; i < utterances.length; i += 1) {
        const u = utterances[i]
        const text = String(u?.text || '').trim()
        if (!text) continue
        if (u?.definite === true) {
          const uKey = `${u.start_time ?? i}:${u.end_time ?? ''}:${text}`
          if (!this.emittedUtterances.has(uKey)) {
            this.emittedUtterances.add(uKey)
            if (this.emittedUtterances.size > 200) {
              const oldest = this.emittedUtterances.values().next().value
              this.emittedUtterances.delete(oldest)
            }
            this.lastPartial = ''
            this.cb.onSpeechStopped?.()
            this.cb.onFinal?.(text)
          }
        } else {
          liveTail = liveTail ? `${liveTail} ${text}` : text
        }
      }
      if (liveTail && liveTail !== this.lastPartial) {
        if (!this.lastPartial) this.cb.onSpeechStarted?.()
        this.lastPartial = liveTail
        this.cb.onPartial?.(liveTail)
      }
      return
    }

    const fallbackText = String(result?.text || '').trim()
    if (fallbackText && fallbackText !== this.lastPartial) {
      if (!this.lastPartial) this.cb.onSpeechStarted?.()
      this.lastPartial = fallbackText
      this.cb.onPartial?.(fallbackText)
    }
  }

  pushPcm16(pcmBuf) {
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN || !pcmBuf?.length) return
    this.pcmPending = this.pcmPending.length === 0 ? Buffer.from(pcmBuf) : Buffer.concat([this.pcmPending, pcmBuf])
    // Send ~100ms chunks (16000Hz * 2B * 0.1s = 3200 bytes)
    while (this.pcmPending.length >= 3200) {
      const chunk = this.pcmPending.subarray(0, 3200)
      this.pcmPending = this.pcmPending.subarray(3200)
      this.ws.sendBinary(buildVolcSaucAudioPacket(chunk, { isLast: false, compress: false }))
    }
  }

  finish() {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return
    const tail = this.pcmPending
    this.pcmPending = Buffer.alloc(0)
    this.ws.sendBinary(buildVolcSaucAudioPacket(tail, { isLast: true, compress: false }))
  }

  close() {
    this.closed = true
    this.pcmPending = Buffer.alloc(0)
    try { this.ws?.close(1000, 'client_stop') } catch { }
  }
}

class QwenAsrRealtimeAdapter {
  constructor({ cred, model, language = 'zh-CN', connectWs = connectWebSocket, callbacks = {} }) {
    this.cred = cred
    this.model = model || 'qwen3-asr-flash-realtime'
    this.language = String(language || 'zh').split('-')[0].toLowerCase() || 'zh'
    this.connectWs = connectWs
    this.cb = callbacks
    this.ws = null
    this.pcmPending = Buffer.alloc(0)
    this.closed = false
  }

  async connect() {
    const wsUrl = resolveDashScopeRealtimeWsUrl(this.cred?.baseUrl, this.model)
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: this.connectWs === connectWebSocket })
    this.ws = await this.connectWs(wsUrl, {
      headers: {
        Authorization: `Bearer ${this.cred.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
      timeoutMs: 15_000,
    })

    this.ws.on('message', data => {
      let ev
      try { ev = JSON.parse(String(data || '')) } catch { return }
      this._handleEvent(ev)
    })
    this.ws.on('error', err => {
      if (!this.closed) this.cb.onError?.(err)
    })
    this.ws.on('close', (code, reason) => {
      if (!this.closed) this.cb.onClose?.(code, reason)
    })

    this.ws.sendJson({
      event_id: `evt_${randomUUID().slice(0, 8)}`,
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        sample_rate: 16000,
        input_audio_transcription: {
          language: this.language,
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.2,
          silence_duration_ms: 600,
        },
      },
    })
  }

  _handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.cb.onSpeechStarted?.()
        break
      case 'input_audio_buffer.speech_stopped':
        this.cb.onSpeechStopped?.()
        break
      case 'conversation.item.input_audio_transcription.text':
      case 'conversation.item.input_audio_transcription.delta': {
        const partial = String(`${ev.text || ''}${ev.stash || ''}` || ev.delta || '').trim()
        if (partial) this.cb.onPartial?.(partial)
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const finalText = String(ev.transcript || ev.text || '').trim()
        if (finalText) this.cb.onFinal?.(finalText)
        break
      }
      case 'error': {
        const msg = ev.error?.message || ev.message || '阿里云百炼实时听写错误'
        this.cb.onError?.(new Error(msg))
        break
      }
      default:
        break
    }
  }

  pushPcm16(pcmBuf) {
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN || !pcmBuf?.length) return
    this.pcmPending = this.pcmPending.length === 0 ? Buffer.from(pcmBuf) : Buffer.concat([this.pcmPending, pcmBuf])
    while (this.pcmPending.length >= 3200) {
      const chunk = this.pcmPending.subarray(0, 3200)
      this.pcmPending = this.pcmPending.subarray(3200)
      this.ws.sendJson({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      })
    }
  }

  finish() {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return
    if (this.pcmPending.length > 0) {
      const tail = this.pcmPending
      this.pcmPending = Buffer.alloc(0)
      this.ws.sendJson({ type: 'input_audio_buffer.append', audio: tail.toString('base64') })
    }
    this.ws.sendJson({ type: 'input_audio_buffer.commit' })
    this.ws.sendJson({ type: 'session.finish' })
  }

  close() {
    this.closed = true
    this.pcmPending = Buffer.alloc(0)
    try { this.ws?.close(1000, 'client_stop') } catch { }
  }
}

class DeepgramStreamingAdapter {
  constructor({ cred, model, language = 'multi', connectWs = connectWebSocket, callbacks = {} }) {
    this.cred = cred
    this.model = model || 'nova-3'
    this.language = language || 'multi'
    this.connectWs = connectWs
    this.cb = callbacks
    this.ws = null
    this.keepAliveTimer = null
    this.finalParts = []
    this.closed = false
  }

  async connect() {
    const dgLang = this.language === 'zh-CN' ? 'multi' : this.language
    const wsUrl = resolveDeepgramWsUrl(this.cred?.baseUrl, { model: this.model, language: dgLang })
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: this.connectWs === connectWebSocket })
    this.ws = await this.connectWs(wsUrl, {
      headers: {
        Authorization: `Token ${this.cred.apiKey}`,
      },
      timeoutMs: 15_000,
    })

    this.keepAliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WS_OPEN) {
        this.ws.sendJson({ type: 'KeepAlive' })
      }
    }, 8_000)
    this.keepAliveTimer.unref?.()

    this.ws.on('message', data => {
      let ev
      try { ev = JSON.parse(String(data || '')) } catch { return }
      this._handleEvent(ev)
    })
    this.ws.on('error', err => {
      if (!this.closed) this.cb.onError?.(err)
    })
    this.ws.on('close', (code, reason) => {
      this._clearTimer()
      if (!this.closed) this.cb.onClose?.(code, reason)
    })
  }

  _clearTimer() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  _handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'SpeechStarted') {
      this.cb.onSpeechStarted?.()
      return
    }
    if (ev.type === 'UtteranceEnd') {
      if (this.finalParts.length > 0) {
        const joined = this.finalParts.join(' ').trim()
        this.finalParts = []
        this.cb.onSpeechStopped?.()
        if (joined) this.cb.onFinal?.(joined)
      }
      return
    }
    if (ev.type === 'Results') {
      const alt = ev.channel?.alternatives?.[0]
      const transcript = String(alt?.transcript || '').trim()
      if (ev.is_final && transcript) {
        this.finalParts.push(transcript)
      }
      const combinedLive = [...this.finalParts, (!ev.is_final && transcript) ? transcript : ''].filter(Boolean).join(' ').trim()
      if (ev.speech_final) {
        const committed = this.finalParts.join(' ').trim() || transcript
        this.finalParts = []
        this.cb.onSpeechStopped?.()
        if (committed) this.cb.onFinal?.(committed)
      } else if (combinedLive) {
        this.cb.onPartial?.(combinedLive)
      }
      return
    }
    if (ev.type === 'Error' || ev.err_msg) {
      this.cb.onError?.(new Error(ev.err_msg || ev.description || 'Deepgram 实时听写错误'))
    }
  }

  pushPcm16(pcmBuf) {
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN || !pcmBuf?.length) return
    this.ws.sendBinary(pcmBuf)
  }

  finish() {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.sendJson({ type: 'Finalize' })
      this.ws.sendJson({ type: 'CloseStream' })
    }
  }

  close() {
    this.closed = true
    this._clearTimer()
    try { this.ws?.close(1000, 'client_stop') } catch { }
  }
}

class OpenAiRealtimeTranscriptionAdapter {
  constructor({ cred, model, language = 'zh', connectWs = connectWebSocket, callbacks = {} }) {
    this.cred = cred
    this.model = model || 'gpt-4o-mini-transcribe'
    this.language = String(language || 'zh').split('-')[0].toLowerCase() || 'zh'
    this.connectWs = connectWs
    this.cb = callbacks
    this.ws = null
    this.pcmPending = Buffer.alloc(0)
    this.partialAcc = ''
    this.closed = false
  }

  async connect() {
    const wsUrl = resolveOpenAiRealtimeWsUrl(this.cred?.baseUrl, 'intent=transcription')
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: this.connectWs === connectWebSocket })
    this.ws = await this.connectWs(wsUrl, {
      headers: {
        Authorization: `Bearer ${this.cred.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
      timeoutMs: 15_000,
    })

    this.ws.on('message', data => {
      let ev
      try { ev = JSON.parse(String(data || '')) } catch { return }
      this._handleEvent(ev)
    })
    this.ws.on('error', err => {
      if (!this.closed) this.cb.onError?.(err)
    })
    this.ws.on('close', (code, reason) => {
      if (!this.closed) this.cb.onClose?.(code, reason)
    })

    this.ws.sendJson({
      type: 'transcription_session.update',
      session: {
        input_audio_format: 'pcm16',
        input_audio_transcription: {
          model: this.model,
          ...(this.language && this.language !== 'multi' ? { language: this.language } : {}),
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
        },
      },
    })
  }

  _handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.partialAcc = ''
        this.cb.onSpeechStarted?.()
        break
      case 'input_audio_buffer.speech_stopped':
        this.cb.onSpeechStopped?.()
        break
      case 'conversation.item.input_audio_transcription.delta': {
        const delta = String(ev.delta || '')
        if (delta) {
          this.partialAcc += delta
          this.cb.onPartial?.(this.partialAcc.trim())
        }
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        this.partialAcc = ''
        const text = String(ev.transcript || '').trim()
        if (text) this.cb.onFinal?.(text)
        break
      }
      case 'error':
        this.cb.onError?.(new Error(ev.error?.message || 'OpenAI 实时听写错误'))
        break
      default:
        break
    }
  }

  pushPcm16(pcmBuf) {
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN || !pcmBuf?.length) return
    // OpenAI Realtime expects 24kHz PCM16 mono
    const pcm24k = resamplePcm16Mono(pcmBuf, 16000, 24000)
    this.pcmPending = this.pcmPending.length === 0 ? pcm24k : Buffer.concat([this.pcmPending, pcm24k])
    while (this.pcmPending.length >= 4800) {
      const chunk = this.pcmPending.subarray(0, 4800)
      this.pcmPending = this.pcmPending.subarray(4800)
      this.ws.sendJson({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      })
    }
  }

  finish() {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return
    if (this.pcmPending.length > 0) {
      const tail = this.pcmPending
      this.pcmPending = Buffer.alloc(0)
      this.ws.sendJson({ type: 'input_audio_buffer.append', audio: tail.toString('base64') })
    }
    this.ws.sendJson({ type: 'input_audio_buffer.commit' })
  }

  close() {
    this.closed = true
    this.pcmPending = Buffer.alloc(0)
    try { this.ws?.close(1000, 'client_stop') } catch { }
  }
}

// ── 4. Route A All-in-One Realtime S2S Adapter (Qwen Omni + OpenAI Realtime) ─

const REALTIME_BUTLER_INSTRUCTIONS = [
  '你是 PocketAgents 的随行语音大管家，帮助用户通过自然口语远程控制多台 Mac 上的 AI 编程代理。',
  '回复原则：',
  '1. 口语化、简短自然，每次回复控制在 1-3 句内；用户用中文就用中文，用英文就用英文。',
  '2. 严禁编造电脑状态、任务进度、工作区路径或 3 位确认码。询问电脑、任务或审批状态时，必须先调用 get_pocketagents_status。',
  '3. 凡是涉及任何操作（批准/拒绝审批、核验 3 位数字确认码、新建任务/选电脑/选或新建工作区/确认创建、发送追问、停止/重命名/删除会话、调节语速或播报队列），必须调用 execute_pocketagents_command，把用户的原话完整传给 spokenCommand，并忠实转述工具返回的 spokenReply。',
  '4. 真正写代码的是用户 Mac 上的 Agent，你只负责听懂需求、汇报进度和通过工具安全下发指令。',
].join('\n')

const REALTIME_BUTLER_TOOLS = [
  {
    type: 'function',
    name: 'get_pocketagents_status',
    description: '获取所有在线电脑、工作区、运行中任务、待审批列表、新建任务草稿和待确认高危确认码的实时状态。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'execute_pocketagents_command',
    description: '执行用户语音操控指令（审批放行/拒绝、3位确认码核验、多轮新建任务与新建工作区校验确认、发追问、停止/重命名/删除会话、调语速或播报队列）。',
    parameters: {
      type: 'object',
      properties: {
        spokenCommand: {
          type: 'string',
          description: '用户刚刚说出的完整指令原话',
        },
      },
      required: ['spokenCommand'],
      additionalProperties: false,
    },
  },
]

class RealtimeS2SAdapter {
  constructor({ adapter, cred, model, voice, connectWs = connectWebSocket, callbacks = {} }) {
    this.adapter = adapter // 'qwen_omni_realtime' | 'openai_realtime'
    this.cred = cred
    this.model = model
    this.voice = voice
    this.connectWs = connectWs
    this.cb = callbacks
    this.ws = null
    this.pcmPending = Buffer.alloc(0)
    this.activeResponseId = null
    this.cancelledResponseIds = new Set()
    this.handledCallIds = new Set()
    this.closed = false
  }

  async connect() {
    const isQwen = this.adapter === 'qwen_omni_realtime'
    const wsUrl = isQwen
      ? resolveDashScopeRealtimeWsUrl(this.cred?.baseUrl, this.model || 'qwen3.8-omni-flash-realtime')
      : resolveOpenAiRealtimeWsUrl(this.cred?.baseUrl, `model=${encodeURIComponent(this.model || 'gpt-realtime-mini')}`)
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: this.connectWs === connectWebSocket })

    const headers = {
      Authorization: `Bearer ${this.cred.apiKey}`,
      ...(isQwen ? {} : { 'OpenAI-Beta': 'realtime=v1' }),
    }
    this.ws = await this.connectWs(wsUrl, { headers, timeoutMs: 15_000 })

    this.ws.on('message', data => {
      let ev
      try { ev = JSON.parse(String(data || '')) } catch { return }
      void this._handleEvent(ev)
    })
    this.ws.on('error', err => {
      if (!this.closed) this.cb.onError?.(err)
    })
    this.ws.on('close', (code, reason) => {
      if (!this.closed) this.cb.onClose?.(code, reason)
    })

    if (isQwen) {
      this.ws.sendJson({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          smooth_output: true,
          audio: {
            input: { format: { type: 'pcm', sample_rate: 16000 } },
            output: {
              voice: this.voice || 'Tina',
              format: { type: 'pcm', sample_rate: 24000 },
            },
          },
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
          turn_detection: {
            type: 'semantic_vad',
            create_response: true,
            interrupt_response: true,
          },
          tools: REALTIME_BUTLER_TOOLS,
          tool_choice: 'auto',
          instructions: REALTIME_BUTLER_INSTRUCTIONS,
        },
      })
    } else {
      this.ws.sendJson({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: this.voice || 'shimmer',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 600,
            create_response: true,
            interrupt_response: true,
          },
          tools: REALTIME_BUTLER_TOOLS,
          tool_choice: 'auto',
          instructions: REALTIME_BUTLER_INSTRUCTIONS,
        },
      })
    }
  }

  cancelActiveResponse(reason = 'client_barge_in', skipUpstreamCancel = false) {
    if (!this.activeResponseId || this.cancelledResponseIds.has(this.activeResponseId)) {
      return false
    }
    const respId = this.activeResponseId
    this.cancelledResponseIds.add(respId)
    this.activeResponseId = null
    if (this.cancelledResponseIds.size > 32) {
      const oldest = this.cancelledResponseIds.values().next().value
      this.cancelledResponseIds.delete(oldest)
    }
    if (!skipUpstreamCancel && this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.sendJson({ type: 'response.cancel' })
    }
    this.cb.onClearOutput?.(reason)
    return true
  }

  sendUserText(text = '') {
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN) return
    const clean = String(text || '').trim()
    if (!clean) return
    this.cancelActiveResponse('text_turn', false)
    this.ws.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: clean }],
      },
    })
    this.ws.sendJson({ type: 'response.create' })
  }

  pushPcm16(pcmBuf) {
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN || !pcmBuf?.length) return
    const isQwen = this.adapter === 'qwen_omni_realtime'
    const inputBuf = isQwen ? Buffer.from(pcmBuf) : resamplePcm16Mono(pcmBuf, 16000, 24000)
    const chunkBytes = isQwen ? 3200 : 4800 // 100ms chunks
    this.pcmPending = this.pcmPending.length === 0 ? inputBuf : Buffer.concat([this.pcmPending, inputBuf])
    while (this.pcmPending.length >= chunkBytes) {
      const chunk = this.pcmPending.subarray(0, chunkBytes)
      this.pcmPending = this.pcmPending.subarray(chunkBytes)
      this.ws.sendJson({
        type: 'input_audio_buffer.append',
        audio: chunk.toString('base64'),
      })
    }
  }

  async _executeToolCall(callId, name, rawArgs) {
    if (!callId || this.handledCallIds.has(callId)) return
    this.handledCallIds.add(callId)
    if (this.handledCallIds.size > 64) {
      const oldest = this.handledCallIds.values().next().value
      this.handledCallIds.delete(oldest)
    }
    let args = {}
    if (typeof rawArgs === 'string' && rawArgs.trim()) {
      try { args = JSON.parse(rawArgs) } catch { args = { spokenCommand: rawArgs } }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs
    }
    let resultObj = { ok: false, error: `Unknown tool: ${name}` }
    try {
      resultObj = await this.cb.onToolCall?.(name, args)
    } catch (err) {
      resultObj = { ok: false, error: err?.message || 'Tool execution failed' }
    }
    if (this.closed || !this.ws || this.ws.readyState !== WS_OPEN) return
    this.ws.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(resultObj || { ok: true }),
      },
    })
    this.ws.sendJson({ type: 'response.create' })
  }

  async _handleEvent(ev) {
    if (!ev || typeof ev !== 'object') return
    const respId = ev.response_id || ev.response?.id
    if (respId && this.cancelledResponseIds.has(respId)) {
      return
    }
    switch (ev.type) {
      case 'response.created':
        this.activeResponseId = ev.response?.id || 'active'
        break
      case 'input_audio_buffer.speech_started':
        this.cancelActiveResponse('vad_speech_started', true)
        this.cb.onSpeechStarted?.()
        break
      case 'input_audio_buffer.speech_stopped':
        this.cb.onSpeechStopped?.()
        break
      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription.text': {
        const partial = String(`${ev.text || ''}${ev.stash || ''}` || ev.delta || '').trim()
        if (partial) this.cb.onPartial?.(partial)
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = String(ev.transcript || '').trim()
        if (text) this.cb.onUserFinal?.(text)
        break
      }
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        const delta = String(ev.delta || '')
        if (delta) this.cb.onAssistantDelta?.(delta)
        break
      }
      case 'response.audio_transcript.done':
      case 'response.text.done': {
        const text = String(ev.transcript || ev.text || '').trim()
        if (text) this.cb.onAssistantDone?.(text)
        break
      }
      case 'response.audio.delta': {
        if (ev.delta) {
          this.cb.onAudioDelta?.(ev.delta)
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const callId = String(ev.call_id || ev.item_id || '').trim()
        const name = String(ev.name || '').trim()
        if (callId && name) {
          await this._executeToolCall(callId, name, ev.arguments)
        }
        break
      }
      case 'response.done':
      case 'response.cancelled': {
        if (this.activeResponseId === respId) {
          this.activeResponseId = null
        }
        const outputs = Array.isArray(ev.response?.output) ? ev.response.output : []
        let hadToolCall = false
        for (const item of outputs) {
          if (item?.type === 'function_call' && item.call_id && item.name && !this.handledCallIds.has(item.call_id)) {
            hadToolCall = true
            await this._executeToolCall(item.call_id, item.name, item.arguments)
          }
        }
        if (!hadToolCall) {
          this.cb.onAudioDone?.()
        }
        break
      }
      case 'error': {
        const msg = String(ev.error?.message || ev.message || 'Realtime upstream error')
        if (/none active response|no active response/i.test(msg)) {
          this.activeResponseId = null
          break
        }
        this.cb.onError?.(new Error(msg))
        break
      }
      default:
        break
    }
  }

  close() {
    this.closed = true
    this.pcmPending = Buffer.alloc(0)
    try { this.ws?.close(1000, 'client_stop') } catch { }
  }
}

// ── 5. Connectivity Probe & One-Shot Batch Fallback for Streaming Credentials ─

export async function probeStreamingCredential(cred, { connectWs = connectWebSocket, now = () => Date.now() } = {}) {
  const t0 = now()
  const provider = String(cred?.provider || '').toLowerCase()

  if (provider === 'volcengine_asr') {
    const resId = String(cred?.resourceId || 'volc.seedasr.sauc.duration').trim() || 'volc.seedasr.sauc.duration'
    const wsUrl = resolveVolcSaucWsUrl(cred?.baseUrl)
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: connectWs === connectWebSocket })
    let ws = null
    try {
      ws = await connectWs(wsUrl, {
        headers: buildVolcSaucHeaders(cred, resId),
        timeoutMs: 12_000,
      })
      const probeResult = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true }), 2500)
        timer.unref?.()
        ws.on('message', (data, isBinary) => {
          if (!isBinary) return
          const frame = parseVolcSaucServerFrame(data)
          if (!frame) return
          clearTimeout(timer)
          if (frame.isError) {
            reject(new Error(frame.errorMessage || `SAUC error ${frame.errorCode}`))
          } else {
            resolve({ ok: true })
          }
        })
        ws.on('error', err => {
          clearTimeout(timer)
          reject(err)
        })
        ws.on('close', (code, reason) => {
          clearTimeout(timer)
          if (code !== 1000 && code !== 1005) {
            reject(new Error(`WebSocket closed (${code}${reason ? `: ${reason}` : ''})`))
          } else {
            resolve({ ok: true })
          }
        })
        ws.sendBinary(buildVolcSaucFullRequest({
          user: { uid: 'pocketagents-probe' },
          audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
          request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true },
        }))
        ws.sendBinary(buildVolcSaucAudioPacket(Buffer.alloc(3200), { isLast: true, compress: false }))
      })
      const latencyMs = now() - t0
      return {
        ok: Boolean(probeResult?.ok),
        provider,
        model: resId,
        latencyMs,
        summary: `豆包流式 2.0 连通正常 (${latencyMs}ms · ${resId})`,
      }
    } catch (err) {
      const msg = String(err?.message || '豆包流式连接失败')
      return {
        ok: false,
        provider,
        model: resId,
        latencyMs: now() - t0,
        error: msg,
        summary: `豆包流式连接失败：${msg}`,
      }
    } finally {
      try { ws?.close(1000, 'probe_done') } catch { }
    }
  }

  if (provider === 'dashscope') {
    const model = String(cred?.defaultModel || 'qwen3-asr-flash-realtime').trim() || 'qwen3-asr-flash-realtime'
    const wsUrl = resolveDashScopeRealtimeWsUrl(cred?.baseUrl, model)
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: connectWs === connectWebSocket })
    let ws = null
    try {
      ws = await connectWs(wsUrl, {
        headers: {
          Authorization: `Bearer ${cred.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
        timeoutMs: 12_000,
      })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true }), 2200)
        timer.unref?.()
        ws.on('message', data => {
          let ev
          try { ev = JSON.parse(String(data || '')) } catch { return }
          if (ev?.type === 'error') {
            clearTimeout(timer)
            reject(new Error(ev.error?.message || ev.message || 'DashScope error'))
          } else if (ev?.type === 'session.created' || ev?.type === 'session.updated') {
            clearTimeout(timer)
            resolve({ ok: true })
          }
        })
        ws.on('error', err => { clearTimeout(timer); reject(err) })
      })
      const latencyMs = now() - t0
      return {
        ok: true,
        provider,
        model,
        latencyMs,
        summary: `阿里云百炼实时连通正常 (${latencyMs}ms · ${model})`,
      }
    } catch (err) {
      const msg = String(err?.message || '阿里云百炼连接失败')
      return {
        ok: false,
        provider,
        model,
        latencyMs: now() - t0,
        error: msg,
        summary: `阿里云百炼连接失败：${msg}`,
      }
    } finally {
      try { ws?.close(1000, 'probe_done') } catch { }
    }
  }

  if (provider === 'deepgram') {
    const model = String(cred?.defaultModel || 'nova-3').trim() || 'nova-3'
    const wsUrl = resolveDeepgramWsUrl(cred?.baseUrl, { model, language: 'multi' })
    await assertSafeVoiceWsUrl(wsUrl, { resolveDns: connectWs === connectWebSocket })
    let ws = null
    try {
      ws = await connectWs(wsUrl, {
        headers: { Authorization: `Token ${cred.apiKey}` },
        timeoutMs: 12_000,
      })
      const latencyMs = now() - t0
      return {
        ok: true,
        provider,
        model,
        latencyMs,
        summary: `Deepgram 实时连通正常 (${latencyMs}ms · ${model})`,
      }
    } catch (err) {
      const msg = String(err?.message || 'Deepgram 连接失败')
      return {
        ok: false,
        provider,
        model,
        latencyMs: now() - t0,
        error: msg,
        summary: `Deepgram 连接失败：${msg}`,
      }
    } finally {
      try { ws?.close(1000, 'probe_done') } catch { }
    }
  }

  return { ok: false, provider, latencyMs: now() - t0, error: `不支持的流式服务商：${provider}` }
}

// ── 6. Unified Voice Stream Session Controller ────────────────────────────────

export class VoiceStreamGateway {
  constructor({
    hub,
    vault,
    voiceCopilot,
    logger = console,
    connectWs = connectWebSocket,
    now = () => Date.now(),
  } = {}) {
    this.hub = hub
    this.vault = vault
    this.voiceCopilot = voiceCopilot
    this.logger = logger
    this.connectWs = connectWs
    this.now = now
    this.sessions = new Set()
  }

  handleUpgrade(req, socket, head) {
    if (this.sessions.size >= MAX_ACTIVE_STREAM_SESSIONS) {
      rejectUpgradeSocket(socket, 429, 'Too many concurrent voice stream sessions')
      return false
    }
    const clientWs = acceptWebSocketUpgrade(req, socket, head)
    if (!clientWs) return false
    this._attachClient(clientWs)
    return true
  }

  _attachClient(clientWs) {
    const session = {
      id: `vs_${randomUUID().slice(0, 8)}`,
      ws: clientWs,
      adapter: null,
      plan: null,
      voiceSessionId: `walk_${randomUUID().slice(0, 8)}`,
      activeHostId: '',
      activeSessionId: '',
      focusedApproval: null,
      profileId: '',
      epoch: 1,
      isSpeaking: false,
      activeTurnPromise: Promise.resolve(),
      lastActivityAt: this.now(),
      closed: false,
    }
    this.sessions.add(session)

    const sendClient = obj => {
      if (!session.closed && clientWs.readyState === WS_OPEN) {
        clientWs.sendJson(obj)
      }
    }

    const cleanup = () => {
      if (session.closed) return
      session.closed = true
      clearInterval(heartbeat)
      try { session.adapter?.close?.() } catch { }
      session.adapter = null
      this.sessions.delete(session)
    }

    const heartbeat = setInterval(() => {
      if (session.closed || clientWs.readyState !== WS_OPEN) {
        cleanup()
        return
      }
      if (this.now() - session.lastActivityAt > STREAM_IDLE_TIMEOUT_MS) {
        sendClient({ type: 'error', code: 'idle_timeout', message: '长时间未说话，实时连接已自动待命', fatal: true })
        clientWs.close(1000, 'idle_timeout')
        cleanup()
        return
      }
      clientWs.ping('pa')
    }, PING_INTERVAL_MS)
    heartbeat.unref?.()

    const bumpOutputEpoch = (reason = 'barge_in') => {
      session.epoch += 1
      session.isSpeaking = false
      if (session.plan?.mode === 'realtime' && session.adapter?.cancelActiveResponse) {
        session.adapter.cancelActiveResponse(reason, false)
      }
      sendClient({ type: 'clear_output', epoch: session.epoch, reason })
    }

    const runPipelineUtterance = async (spokenText, sttMs = 0) => {
      const clean = String(spokenText || '').trim()
      if (!clean || session.closed) return
      // Interrupt any previous reply stream cleanly
      session.epoch += 1
      const turnEpoch = session.epoch
      session.isSpeaking = false
      sendClient({ type: 'clear_output', epoch: turnEpoch, reason: 'new_turn' })
      sendClient({ type: 'transcript_final', text: clean, sttMs, epoch: turnEpoch })
      sendClient({ type: 'turn_thinking', text: clean, epoch: turnEpoch })

      try {
        const turnRes = await this.voiceCopilot.runBrainTurn({
          text: clean,
          voiceSessionId: session.voiceSessionId,
          activeHostId: session.activeHostId,
          activeSessionId: session.activeSessionId,
          focusedApproval: session.focusedApproval,
          profileId: session.profileId,
          dryRun: false,
        })
        if (session.closed || session.epoch !== turnEpoch) return

        if (turnRes?.nextFocusedApproval !== undefined) {
          session.focusedApproval = turnRes.nextFocusedApproval || null
        } else if (turnRes?.execution?.executed) {
          session.focusedApproval = null
        }
        if (turnRes?.focusedSession?.hostId) {
          session.activeHostId = String(turnRes.focusedSession.hostId)
          if (turnRes.focusedSession.agentId) {
            session.activeSessionId = String(turnRes.focusedSession.agentId)
          }
        }

        sendClient({ type: 'turn_result', turn: turnRes, epoch: turnEpoch })

        const reply = String(turnRes?.spokenReply || '').trim()
        const chunks = Array.isArray(turnRes?.spokenChunks) && turnRes.spokenChunks.length > 0
          ? turnRes.spokenChunks
          : (reply ? [reply] : [])
        const profile = this.vault.getProfileById(session.profileId)
        const useCloudTts = Boolean(profile?.tts?.provider && profile.tts.provider !== 'native')

        if (chunks.length > 0 && useCloudTts && this.vault.state.prefs.autoPlayWalkReplies !== false) {
          session.isSpeaking = true
          for (let i = 0; i < chunks.length; i += 1) {
            if (session.closed || session.epoch !== turnEpoch) return
            const ttsRes = await this.voiceCopilot.runTts({
              text: chunks[i],
              profileId: session.profileId,
            })
            if (session.closed || session.epoch !== turnEpoch) return
            if (ttsRes?.ok && ttsRes.audioBase64) {
              sendClient({
                type: 'audio_chunk',
                format: /wav/i.test(ttsRes.mimeType || '') ? 'wav' : 'mp3',
                mimeType: ttsRes.mimeType || 'audio/mpeg',
                audioBase64: ttsRes.audioBase64,
                chunkIndex: i,
                latencyMs: ttsRes.latencyMs || 0,
                epoch: turnEpoch,
              })
            }
          }
          if (!session.closed && session.epoch === turnEpoch) {
            session.isSpeaking = false
            sendClient({ type: 'audio_done', epoch: turnEpoch })
          }
        } else {
          sendClient({ type: 'audio_done', epoch: turnEpoch, useNativeTts: !useCloudTts })
        }
      } catch (err) {
        if (!session.closed && session.epoch === turnEpoch) {
          session.isSpeaking = false
          sendClient({
            type: 'error',
            code: 'turn_error',
            message: err?.message || '语音大脑处理失败',
            fatal: false,
          })
        }
      }
    }

    const startUpstream = async startMsg => {
      await this.vault.init()
      try { session.adapter?.close?.() } catch { }
      session.adapter = null

      session.voiceSessionId = String(startMsg?.voiceSessionId || session.voiceSessionId).slice(0, 64)
      session.profileId = String(startMsg?.profileId || '').slice(0, 80)
      session.activeHostId = String(startMsg?.activeHostId || '').slice(0, 80)
      session.activeSessionId = String(startMsg?.activeSessionId || '').slice(0, 80)
      session.focusedApproval = startMsg?.focusedApproval || null

      const plan = resolveVoiceStreamPlan(this.vault, {
        requestedMode: startMsg?.mode || 'auto',
        profileId: session.profileId,
      })
      if (!plan.supported) {
        sendClient({
          type: 'error',
          code: 'streaming_not_configured',
          message: plan.reason || '当前配置未启用流式实时语音',
          fatal: true,
        })
        return
      }

      session.plan = plan
      const ctx = buildDynamicVoiceContext(this.hub, {
        activeHostId: session.activeHostId,
        activeSessionId: session.activeSessionId,
      })

      if (plan.mode === 'realtime') {
        const adapter = new RealtimeS2SAdapter({
          adapter: plan.adapter,
          cred: plan.cred,
          model: plan.model,
          voice: plan.voice,
          connectWs: this.connectWs,
          callbacks: {
            onSpeechStarted: () => {
              session.lastActivityAt = this.now()
              sendClient({ type: 'speech_started', epoch: session.epoch })
            },
            onSpeechStopped: () => {
              sendClient({ type: 'speech_stopped', epoch: session.epoch })
            },
            onPartial: text => {
              session.lastActivityAt = this.now()
              sendClient({ type: 'transcript_partial', text, epoch: session.epoch })
            },
            onUserFinal: text => {
              session.lastActivityAt = this.now()
              sendClient({ type: 'transcript_final', text, sttMs: 0, epoch: session.epoch })
            },
            onAssistantDelta: delta => {
              session.isSpeaking = true
              sendClient({ type: 'assistant_delta', delta, epoch: session.epoch })
            },
            onAssistantDone: text => {
              sendClient({ type: 'assistant_done', text, epoch: session.epoch })
            },
            onAudioDelta: audioBase64 => {
              session.isSpeaking = true
              sendClient({
                type: 'audio_chunk',
                format: 'pcm16',
                sampleRate: 24000,
                audioBase64,
                epoch: session.epoch,
              })
            },
            onAudioDone: () => {
              session.isSpeaking = false
              sendClient({ type: 'audio_done', epoch: session.epoch })
            },
            onClearOutput: reason => {
              session.epoch += 1
              session.isSpeaking = false
              sendClient({ type: 'clear_output', epoch: session.epoch, reason })
            },
            onToolCall: async (name, args) => {
              session.lastActivityAt = this.now()
              if (name === 'get_pocketagents_status') {
                const liveCtx = buildDynamicVoiceContext(this.hub, {
                  activeHostId: session.activeHostId,
                  activeSessionId: session.activeSessionId,
                })
                return {
                  ok: true,
                  hosts: liveCtx.hosts.map(h => ({
                    hostId: h.hostId,
                    hostName: h.hostName,
                    online: h.online,
                    workspaces: (h.workspaces || []).slice(0, 8),
                    runningTasks: h.runningTasks,
                  })),
                  pendingApprovals: liveCtx.pendingApprovals.slice(0, 8),
                  tasks: liveCtx.tasks.slice(0, 10),
                  activeDraft: this.voiceCopilot.getActiveDraft(session.voiceSessionId),
                  activePin: this.voiceCopilot.getActivePinChallenge(session.voiceSessionId),
                }
              }
              if (name === 'execute_pocketagents_command') {
                const spokenCommand = String(args?.spokenCommand || '').trim()
                if (!spokenCommand) return { ok: false, error: 'Missing spokenCommand' }
                const turnRes = await this.voiceCopilot.runBrainTurn({
                  text: spokenCommand,
                  voiceSessionId: session.voiceSessionId,
                  activeHostId: session.activeHostId,
                  activeSessionId: session.activeSessionId,
                  focusedApproval: session.focusedApproval,
                  profileId: session.profileId,
                  dryRun: false,
                })
                if (turnRes?.nextFocusedApproval !== undefined) {
                  session.focusedApproval = turnRes.nextFocusedApproval || null
                } else if (turnRes?.execution?.executed) {
                  session.focusedApproval = null
                }
                sendClient({ type: 'turn_result', turn: turnRes, fromRealtimeTool: true, epoch: session.epoch })
                return {
                  ok: Boolean(turnRes?.ok),
                  spokenReply: turnRes?.spokenReply || '',
                  action: turnRes?.action || null,
                  execution: turnRes?.execution || null,
                  draftCard: turnRes?.draftCard || null,
                  pinChallenge: turnRes?.pinChallenge || null,
                }
              }
              return { ok: false, error: `Unknown tool: ${name}` }
            },
            onError: err => {
              sendClient({ type: 'error', code: 'upstream_error', message: err?.message || '实时通道异常', fatal: false })
            },
            onClose: () => {
              if (!session.closed) {
                sendClient({ type: 'error', code: 'upstream_closed', message: '云端实时语音通道已断开，轻点圆麦重连', fatal: true })
              }
            },
          },
        })
        await adapter.connect()
        if (session.closed) {
          adapter.close()
          return
        }
        session.adapter = adapter
      } else {
        let speechStartedAt = 0
        const asrCallbacks = {
          onSpeechStarted: () => {
            session.lastActivityAt = this.now()
            speechStartedAt = this.now()
            sendClient({ type: 'speech_started', epoch: session.epoch })
          },
          onSpeechStopped: () => {
            sendClient({ type: 'speech_stopped', epoch: session.epoch })
          },
          onPartial: text => {
            session.lastActivityAt = this.now()
            if (session.isSpeaking && String(text || '').trim().length >= 3) {
              // Real user speech started while AI was speaking -> instant barge-in!
              bumpOutputEpoch('speech_barge_in')
            }
            sendClient({ type: 'transcript_partial', text, epoch: session.epoch })
          },
          onFinal: text => {
            session.lastActivityAt = this.now()
            const sttMs = speechStartedAt > 0 ? Math.max(0, this.now() - speechStartedAt) : 0
            speechStartedAt = 0
            session.activeTurnPromise = session.activeTurnPromise
              .catch(() => { })
              .then(() => runPipelineUtterance(text, sttMs))
          },
          onError: err => {
            sendClient({ type: 'error', code: 'upstream_asr_error', message: err?.message || '流式听写异常', fatal: false })
          },
          onClose: () => {
            if (!session.closed) {
              sendClient({ type: 'error', code: 'upstream_closed', message: '实时听写连接已关闭', fatal: true })
            }
          },
        }

        let adapter = null
        if (plan.adapter === 'volcengine_sauc') {
          adapter = new VolcengineSaucAdapter({
            cred: plan.cred,
            model: plan.model,
            hotwords: ctx.hotwords,
            connectWs: this.connectWs,
            callbacks: asrCallbacks,
          })
        } else if (plan.adapter === 'qwen_asr_realtime') {
          adapter = new QwenAsrRealtimeAdapter({
            cred: plan.cred,
            model: plan.model,
            language: plan.language,
            connectWs: this.connectWs,
            callbacks: asrCallbacks,
          })
        } else if (plan.adapter === 'deepgram') {
          adapter = new DeepgramStreamingAdapter({
            cred: plan.cred,
            model: plan.model,
            language: plan.language,
            connectWs: this.connectWs,
            callbacks: asrCallbacks,
          })
        } else if (plan.adapter === 'openai_realtime_stt') {
          adapter = new OpenAiRealtimeTranscriptionAdapter({
            cred: plan.cred,
            model: plan.model,
            language: plan.language,
            connectWs: this.connectWs,
            callbacks: asrCallbacks,
          })
        }

        await adapter.connect()
        if (session.closed) {
          adapter.close()
          return
        }
        session.adapter = adapter
      }

      this.logger?.info?.(
        `[voice-stream] ready sid=${session.id} mode=${plan.mode} adapter=${plan.adapter} model=${plan.model}`,
      )
      sendClient({
        type: 'ready',
        mode: plan.mode,
        adapter: plan.adapter,
        providerLabel: plan.providerLabel,
        model: plan.model,
        voice: plan.voice || '',
        sampleRateIn: 16000,
        sampleRateOut: 24000,
        epoch: session.epoch,
      })
    }

    clientWs.on('message', (data, isBinary) => {
      session.lastActivityAt = this.now()
      if (isBinary) {
        if (session.adapter?.pushPcm16) {
          session.adapter.pushPcm16(data)
        }
        return
      }
      let msg
      try { msg = JSON.parse(String(data || '')) } catch { return }
      if (!msg || typeof msg !== 'object') return

      if (msg.type === 'start') {
        void startUpstream(msg).catch(err => {
          this.logger?.warn?.(`[voice-stream] start failed sid=${session.id} err=${err?.message || err}`)
          sendClient({
            type: 'error',
            code: 'upstream_connect_failed',
            message: err?.message || '无法连接云端实时语音通道',
            fatal: true,
          })
        })
        return
      }
      if (msg.type === 'audio' && msg.pcmBase64 && session.adapter?.pushPcm16) {
        try {
          session.adapter.pushPcm16(Buffer.from(String(msg.pcmBase64), 'base64'))
        } catch { }
        return
      }
      if (msg.type === 'barge_in') {
        bumpOutputEpoch('client_barge_in')
        return
      }
      if (msg.type === 'context') {
        if (msg.activeHostId !== undefined) session.activeHostId = String(msg.activeHostId || '').slice(0, 80)
        if (msg.activeSessionId !== undefined) session.activeSessionId = String(msg.activeSessionId || '').slice(0, 80)
        if (msg.focusedApproval !== undefined) session.focusedApproval = msg.focusedApproval || null
        return
      }
      if (msg.type === 'text_turn' && msg.text) {
        if (session.plan?.mode === 'realtime' && session.adapter?.sendUserText) {
          session.adapter.sendUserText(msg.text)
        } else {
          session.activeTurnPromise = session.activeTurnPromise
            .catch(() => { })
            .then(() => runPipelineUtterance(msg.text, 0))
        }
        return
      }
      if (msg.type === 'stop') {
        try { session.adapter?.finish?.() } catch { }
        cleanup()
        clientWs.close(1000, 'client_stop')
      }
    })

    clientWs.on('close', cleanup)
    clientWs.on('error', cleanup)
  }
}
