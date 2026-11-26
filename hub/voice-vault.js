import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'

export const VOICE_PROVIDER_CATALOG = [
  {
    id: 'openai_compat',
    name: 'OpenAI 兼容接口 (通用)',
    shortName: 'OpenAI 兼容',
    capabilities: ['stt', 'brain', 'tts'],
    authMode: 'apiKey',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlExamples: [
      { label: 'OpenAI 官方', url: 'https://api.openai.com/v1' },
      { label: 'DeepSeek 官方', url: 'https://api.deepseek.com/v1' },
      { label: '火山方舟 Ark', url: 'https://ark.cn-beijing.volces.com/api/v3' },
      { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
      { label: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1' },
      { label: 'Groq', url: 'https://api.groq.com/openai/v1' },
      { label: '本机 Ollama', url: 'http://127.0.0.1:11434/v1' },
    ],
    sampleModels: {
      stt: ['gpt-4o-mini-transcribe', 'whisper-1', 'whisper-large-v3-turbo'],
      brain: ['deepseek-chat', 'gpt-4o-mini', 'deepseek-v4-1-flash-261017', 'doubao-seed-2-0-lite-260215'],
      tts: ['gpt-4o-mini-tts', 'tts-1'],
    },
    sampleVoices: ['alloy', 'nova', 'shimmer', 'echo', 'coral'],
    hint: '兼容所有 /v1/chat/completions、/v1/audio/transcriptions、/v1/audio/speech 协议的云端或本地服务',
  },
  {
    id: 'gemini',
    name: 'Google Gemini API',
    shortName: 'Gemini',
    capabilities: ['stt', 'brain', 'tts'],
    authMode: 'apiKey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlExamples: [
      { label: 'Gemini 官方 v1beta', url: 'https://generativelanguage.googleapis.com/v1beta' },
    ],
    sampleModels: {
      stt: ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
      brain: ['gemini-2.5-flash', 'gemini-3.8-flash', 'gemini-4-hydrogen'],
      tts: ['gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'],
    },
    sampleVoices: ['Kore', 'Puck', 'Aoede', 'Zephyr', 'Fenrir'],
    hint: '支持 AIza... 与新版 AQ.Ab... 密钥；可单独控制思考档位（2.5 系列支持关闭思考，3.x/4.x 最低为 low）',
  },
  {
    id: 'volcengine_asr',
    name: '火山豆包语音识别 (Flash ASR)',
    shortName: '火山 ASR',
    capabilities: ['stt'],
    authMode: 'volcengine',
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
    defaultResourceId: 'volc.bigasr.auc_turbo',
    sampleModels: {
      stt: ['volc.seedasr.auc', 'volc.bigasr.auc_turbo', 'volc.bigasr.auc'],
    },
    sampleVoices: [],
    hint: '支持 API Key 或 AppID + Access Token 鉴权，16kHz WAV 极速识别（静音自动返回 20000003）',
  },
  {
    id: 'volcengine_tts',
    name: '火山豆包语音合成 (Seed-TTS 3.0 / 2.0)',
    shortName: '火山 TTS',
    capabilities: ['tts'],
    authMode: 'volcengine',
    defaultBaseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    defaultResourceId: 'seed-tts-2.0',
    sampleModels: {
      tts: ['doubao-seed-tts-3.0', 'seed-tts-2.0', 'volc.service_type.10029'],
    },
    sampleVoices: [
      'multi_female_tuanzi_v3_uranus_bigtts',
      'zh_female_vv_uranus_bigtts',
      'zh_female_xiaohe_uranus_bigtts',
      'zh_male_m191_uranus_bigtts',
      'zh_male_taocheng_uranus_bigtts',
    ],
    hint: '支持 3.0 新版（仅 API Key，voice.cn-beijing.volces.com）与 2.0 经典版（API Key 或 AppID + Token）',
  },
]

export const DEFAULT_NATIVE_PROFILE = Object.freeze({
  id: 'native',
  name: '系统原生语音（免 Key 免费）',
  builtin: true,
  stt: {
    provider: 'native',
    credId: '',
    model: 'browser-web-speech',
    language: 'zh-CN',
    thinkingLevel: 'default',
    fallbackChain: [],
  },
  brain: {
    provider: 'native',
    credId: '',
    model: 'rule-router',
    thinkingLevel: 'off',
    maxTokens: 256,
  },
  tts: {
    provider: 'native',
    credId: '',
    model: 'browser-speech-synthesis',
    voice: 'system-default',
    format: 'mp3',
    speed: 1.0,
  },
})

export const DEFAULT_VOICE_PREFS = Object.freeze({
  activeProfileId: 'native',
  l2Policy: 'pin', // 'pin' | 'screen_only'
  proactiveBriefing: 'approvals', // 'approvals' | 'all' | 'manual'
  briefingDetail: 'detailed', // 'detailed' | 'verbatim' | 'concise'
  autoVad: true,
  vadSilenceMs: 850,
  autoListenAfterBriefing: true,
  duckMusicMode: true,
  useByokForChatStt: false,
  useByokForChatTts: false,
  autoPlayWalkReplies: true,
  speechRate: 1.0,
})

const ALLOWED_PROVIDERS = new Set(['openai_compat', 'gemini', 'volcengine_asr', 'volcengine_tts'])
const ALLOWED_STAGE_PROVIDERS = new Set(['native', ...ALLOWED_PROVIDERS])
const ALLOWED_THINKING = new Set(['off', 'low', 'medium', 'high', 'default'])
const ALLOWED_L2_POLICIES = new Set(['pin', 'screen_only'])
const ALLOWED_BRIEFING = new Set(['approvals', 'all', 'manual'])
const ALLOWED_BRIEFING_DETAIL = new Set(['detailed', 'verbatim', 'concise'])

export function maskSecret(value = '') {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (s.length <= 6) return '••••'
  if (s.length <= 12) return `${s.slice(0, 2)}••••${s.slice(-2)}`
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  '100.100.100.200',
  'fd00:ec2::254',
  '0.0.0.0',
  '::',
])

function shouldAllowLocalVoiceUrls() {
  if (process.env.VOICE_ALLOW_LOCAL_URLS === '1' || process.env.VOICE_ALLOW_LOCAL_URLS === 'true') {
    return true
  }
  const isCloudProd =
    process.env.NODE_ENV === 'production'
    || Boolean(process.env.K_SERVICE)
    || Boolean(process.env.RAILWAY_ENVIRONMENT)
  return !isCloudProd
}

function parseIpv4Octets(ip = '') {
  const parts = String(ip || '').trim().split('.')
  if (parts.length !== 4) return null
  const nums = parts.map(p => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  if (nums.some(n => n < 0 || n > 255)) return null
  return nums
}

function extractEmbeddedIpv4FromIpv6(rawHost = '') {
  const h = String(rawHost || '').toLowerCase().replace(/^\[|\]$/g, '')
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(h)
  if (dotted) return dotted[1]
  // WHATWG URL normalizes ::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe
  const hexPair = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h)
  if (hexPair) {
    const hi = parseInt(hexPair[1], 16)
    const lo = parseInt(hexPair[2], 16)
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
  }
  return ''
}

export function isBlockedVoiceIp(rawIp = '', { allowLocal = shouldAllowLocalVoiceUrls() } = {}) {
  const ip = String(rawIp || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!ip) return true
  const embeddedV4 = extractEmbeddedIpv4FromIpv6(ip)
  if (embeddedV4) {
    return isBlockedVoiceIp(embeddedV4, { allowLocal })
  }
  const ipVer = isIP(ip)
  if (ipVer === 4) {
    const o = parseIpv4Octets(ip)
    if (!o) return true
    const [a, b] = o
    // Always block unspecified (0.0.0.0/8), link-local/cloud metadata (169.254.0.0/16), and CGNAT/Alibaba metadata (100.64.0.0/10)
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true // multicast / reserved
    if (!allowLocal) {
      if (a === 127) return true
      if (a === 10) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
    }
    return false
  }
  if (ipVer === 6) {
    if (ip === '::' || /^0{0,4}(?::0{0,4})*$/.test(ip)) return true
    // Always block link-local fe80::/10 (fe80..febf) and ULA fc00::/7 (fc00..fdff)
    if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true
    if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true
    if (ip.startsWith('ff')) return true // multicast
    if (!allowLocal && (ip === '::1' || /^0{0,4}(?::0{0,4})*:0*1$/.test(ip))) return true
    return false
  }
  return false
}

export function isBlockedVoiceBaseUrl(rawUrl = '', { allowLocal = shouldAllowLocalVoiceUrls() } = {}) {
  const s = String(rawUrl ?? '').trim()
  if (!s) return false
  let parsed
  try {
    parsed = new URL(s)
  } catch {
    return true
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
  if (parsed.username || parsed.password) return true
  const rawHost = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  const host = rawHost.replace(/\.+$/, '')
  if (!host) return true
  if (BLOCKED_METADATA_HOSTS.has(host)) return true
  if (host.endsWith('.internal') || host.endsWith('.metadata.goog')) return true
  if (!allowLocal && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) return true
  if (isIP(host) !== 0) {
    return isBlockedVoiceIp(host, { allowLocal })
  }
  return false
}

export async function assertSafeVoiceTargetUrl(
  rawUrl = '',
  { allowLocal = shouldAllowLocalVoiceUrls(), resolveDns = true } = {},
) {
  if (isBlockedVoiceBaseUrl(rawUrl, { allowLocal })) {
    throw new Error('Blocked unsafe Voice API URL (SSRF policy)')
  }
  if (!resolveDns) return
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid Voice API URL')
  }
  const host = String(parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!host || isIP(host) !== 0) return
  try {
    const records = await dnsLookup(host, { all: true })
    for (const rec of records || []) {
      if (rec?.address && isBlockedVoiceIp(rec.address, { allowLocal })) {
        throw new Error(`Blocked Voice API URL resolving to disallowed IP (${rec.address})`)
      }
    }
  } catch (err) {
    if (/Blocked Voice API URL/i.test(String(err?.message || ''))) throw err
    // Let fetch handle normal transient DNS errors
  }
}

function sanitizeUrl(url = '') {
  const s = String(url ?? '').trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) return ''
  if (isBlockedVoiceBaseUrl(s)) return ''
  return s.replace(/\/+$/, '')
}

function normalizeThinkingLevel(val, fallback = 'default') {
  const clean = String(val ?? '').trim().toLowerCase()
  return ALLOWED_THINKING.has(clean) ? clean : fallback
}

function normalizeStageConfig(input = {}, stage = 'stt') {
  const rawProvider = String(input?.provider ?? 'native').trim().toLowerCase()
  const provider = ALLOWED_STAGE_PROVIDERS.has(rawProvider) ? rawProvider : 'native'
  const base = {
    provider,
    credId: provider === 'native' ? '' : String(input?.credId ?? '').trim().slice(0, 80),
    model: String(input?.model ?? '').trim().slice(0, 120),
  }
  if (stage === 'stt') {
    const rawChain = Array.isArray(input?.fallbackChain) ? input.fallbackChain : []
    const fallbackChain = rawChain
      .slice(0, 4)
      .map(item => ({
        provider: ALLOWED_STAGE_PROVIDERS.has(String(item?.provider || '').trim().toLowerCase())
          ? String(item.provider).trim().toLowerCase()
          : 'native',
        credId: String(item?.credId ?? '').trim().slice(0, 80),
        model: String(item?.model ?? '').trim().slice(0, 120),
        thinkingLevel: normalizeThinkingLevel(item?.thinkingLevel, 'low'),
      }))
      .filter(item => item.provider !== 'native')
    return {
      ...base,
      language: String(input?.language || 'zh-CN').trim().slice(0, 24),
      thinkingLevel: normalizeThinkingLevel(input?.thinkingLevel, 'low'),
      fallbackChain,
    }
  }
  if (stage === 'brain') {
    const maxTokens = Number(input?.maxTokens)
    return {
      ...base,
      thinkingLevel: normalizeThinkingLevel(input?.thinkingLevel, 'off'),
      maxTokens: Number.isFinite(maxTokens) && maxTokens >= 64 && maxTokens <= 4096 ? Math.round(maxTokens) : 320,
    }
  }
  const speed = Number(input?.speed)
  return {
    ...base,
    voice: String(input?.voice ?? '').trim().slice(0, 120),
    format: String(input?.format || 'mp3').trim().toLowerCase() === 'wav' ? 'wav' : 'mp3',
    speed: Number.isFinite(speed) && speed >= 0.5 && speed <= 2.0 ? Math.round(speed * 100) / 100 : 1.0,
  }
}

function normalizePrefs(input = {}) {
  const vadMs = Number(input?.vadSilenceMs)
  const speechRate = Number(input?.speechRate)
  return {
    activeProfileId: String(input?.activeProfileId || 'native').trim().slice(0, 80) || 'native',
    l2Policy: ALLOWED_L2_POLICIES.has(String(input?.l2Policy || '')) ? String(input.l2Policy) : 'pin',
    proactiveBriefing: ALLOWED_BRIEFING.has(String(input?.proactiveBriefing || ''))
      ? String(input.proactiveBriefing)
      : 'approvals',
    briefingDetail: ALLOWED_BRIEFING_DETAIL.has(String(input?.briefingDetail || ''))
      ? String(input.briefingDetail)
      : 'detailed',
    autoVad: input?.autoVad !== undefined ? Boolean(input.autoVad) : true,
    vadSilenceMs: Number.isFinite(vadMs) && vadMs >= 350 && vadMs <= 3000 ? Math.round(vadMs) : 850,
    autoListenAfterBriefing: input?.autoListenAfterBriefing !== undefined ? Boolean(input.autoListenAfterBriefing) : true,
    duckMusicMode: input?.duckMusicMode !== undefined ? Boolean(input.duckMusicMode) : true,
    useByokForChatStt: Boolean(input?.useByokForChatStt),
    useByokForChatTts: Boolean(input?.useByokForChatTts),
    autoPlayWalkReplies: input?.autoPlayWalkReplies !== undefined ? Boolean(input.autoPlayWalkReplies) : true,
    speechRate: Number.isFinite(speechRate) && speechRate >= 0.6 && speechRate <= 2.0
      ? Math.round(speechRate * 100) / 100
      : 1.0,
  }
}

function cloneDefaultState() {
  return {
    schemaVersion: 1,
    credentials: [],
    profiles: [structuredClone(DEFAULT_NATIVE_PROFILE)],
    prefs: { ...DEFAULT_VOICE_PREFS },
  }
}

export class VoiceVault {
  constructor({
    vaultFile = '',
    secret = process.env.VOICE_VAULT_SECRET || '',
    now = () => Date.now(),
  } = {}) {
    this.vaultFile = String(vaultFile ?? '').trim()
    this.secret = String(secret ?? '').trim()
    this.now = now
    this.state = cloneDefaultState()
    this._keyBytes = null
    this._persistChain = Promise.resolve()
    this._initialized = false
    this._initPromise = null
  }

  getKeyFilePath() {
    if (!this.vaultFile) return ''
    return join(dirname(this.vaultFile), '.voice-vault.key')
  }

  async resolveMasterKey(saltBuf) {
    if (this.secret) {
      return scryptSync(this.secret, saltBuf, 32)
    }
    if (this._keyBytes && this._keyBytes.length === 32) {
      return this._keyBytes
    }
    if (this.vaultFile) {
      const keyPath = this.getKeyFilePath()
      try {
        const raw = (await readFile(keyPath, 'utf8')).trim()
        if (/^[0-9a-f]{64}$/i.test(raw)) {
          this._keyBytes = Buffer.from(raw, 'hex')
          return this._keyBytes
        }
      } catch {
        // key file does not exist yet
      }
      await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 })
      const generated = randomBytes(32)
      const tmpKeyPath = `${keyPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
      await writeFile(tmpKeyPath, `${generated.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(tmpKeyPath, 0o600).catch(() => { })
      await rename(tmpKeyPath, keyPath)
      await chmod(keyPath, 0o600).catch(() => { })
      this._keyBytes = generated
      return this._keyBytes
    }
    this._keyBytes = randomBytes(32)
    return this._keyBytes
  }

  async init() {
    if (this._initialized) return
    if (this._initPromise) return this._initPromise
    this._initPromise = (async () => {
      if (!this.vaultFile) {
        this._initialized = true
        return
      }
      try {
        const text = await readFile(this.vaultFile, 'utf8')
        const envelope = JSON.parse(text)
        if (!envelope || envelope.alg !== 'aes-256-gcm' || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
          this._initialized = true
          return
        }
        const salt = envelope.salt ? Buffer.from(envelope.salt, 'base64') : Buffer.from('pocketagents-voice-v1')
        const key = await this.resolveMasterKey(salt)
        const iv = Buffer.from(envelope.iv, 'base64')
        const tag = Buffer.from(envelope.tag, 'base64')
        const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(tag)
        const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()])
        const parsed = JSON.parse(plainBuf.toString('utf8'))
        this._hydrateParsedState(parsed)
      } catch {
        // missing file or unreadable vault starts cleanly with default native profile
        this.state = cloneDefaultState()
      } finally {
        this._initialized = true
      }
    })()
    return this._initPromise
  }

  _hydrateParsedState(parsed) {
    const next = cloneDefaultState()
    if (Array.isArray(parsed?.credentials)) {
      next.credentials = parsed.credentials
        .filter(c => c && c.id && ALLOWED_PROVIDERS.has(String(c.provider || '')))
        .map(c => ({
          id: String(c.id),
          provider: String(c.provider),
          label: String(c.label || c.provider).slice(0, 80),
          baseUrl: sanitizeUrl(c.baseUrl),
          apiKey: String(c.apiKey || '').trim(),
          appId: String(c.appId || '').trim(),
          accessToken: String(c.accessToken || '').trim(),
          resourceId: String(c.resourceId || '').trim().slice(0, 80),
          defaultModel: String(c.defaultModel || '').trim().slice(0, 120),
          defaultVoice: String(c.defaultVoice || '').trim().slice(0, 120),
          enabled: c.enabled !== false,
          active: Boolean(c.active),
          createdAt: Number(c.createdAt) || this.now(),
          updatedAt: Number(c.updatedAt) || this.now(),
        }))
    }
    const customProfiles = Array.isArray(parsed?.profiles)
      ? parsed.profiles
        .filter(p => p && p.id && p.id !== 'native')
        .map(p => ({
          id: String(p.id).slice(0, 80),
          name: String(p.name || p.id).trim().slice(0, 80),
          builtin: false,
          stt: normalizeStageConfig(p.stt, 'stt'),
          brain: normalizeStageConfig(p.brain, 'brain'),
          tts: normalizeStageConfig(p.tts, 'tts'),
          createdAt: Number(p.createdAt) || this.now(),
          updatedAt: Number(p.updatedAt) || this.now(),
        }))
      : []
    next.profiles = [structuredClone(DEFAULT_NATIVE_PROFILE), ...customProfiles]
    next.prefs = normalizePrefs(parsed?.prefs)
    if (!next.profiles.some(p => p.id === next.prefs.activeProfileId)) {
      next.prefs.activeProfileId = 'native'
    }
    this.state = next
  }

  async persist() {
    if (!this.vaultFile) return { ok: true, inMemory: true }
    const writeTask = this._persistChain.then(async () => {
      await mkdir(dirname(this.vaultFile), { recursive: true, mode: 0o700 })
      const salt = randomBytes(16)
      const key = await this.resolveMasterKey(salt)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const plaintext = Buffer.from(JSON.stringify(this.state), 'utf8')
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
      const tag = cipher.getAuthTag()
      const envelope = {
        v: 1,
        alg: 'aes-256-gcm',
        kdf: this.secret ? 'scrypt' : 'keyfile',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        updatedAt: this.now(),
      }
      const tmpPath = `${this.vaultFile}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
      await writeFile(tmpPath, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 })
      await chmod(tmpPath, 0o600).catch(() => { })
      await rename(tmpPath, this.vaultFile)
      await chmod(this.vaultFile, 0o600).catch(() => { })
      return { ok: true }
    })
    this._persistChain = writeTask.catch(() => { })
    return writeTask
  }

  toPublicCredential(cred) {
    const hasApiKey = Boolean(cred.apiKey)
    const hasAccessToken = Boolean(cred.accessToken)
    const hasAppId = Boolean(cred.appId)
    return {
      id: cred.id,
      provider: cred.provider,
      label: cred.label,
      baseUrl: cred.baseUrl,
      resourceId: cred.resourceId,
      defaultModel: cred.defaultModel,
      defaultVoice: cred.defaultVoice,
      enabled: cred.enabled !== false,
      active: Boolean(cred.active),
      hasApiKey,
      hasAppId,
      hasAccessToken,
      maskedApiKey: hasApiKey ? maskSecret(cred.apiKey) : '',
      maskedAppId: hasAppId ? maskSecret(cred.appId) : '',
      maskedAccessToken: hasAccessToken ? maskSecret(cred.accessToken) : '',
      authSummary: hasApiKey
        ? `Key ${maskSecret(cred.apiKey)}`
        : hasAppId && hasAccessToken
          ? `AppID ${maskSecret(cred.appId)} · Token ${maskSecret(cred.accessToken)}`
          : '未填写密钥',
      createdAt: cred.createdAt,
      updatedAt: cred.updatedAt,
    }
  }

  toPublicState() {
    return {
      schemaVersion: 1,
      storageMode: this.vaultFile ? 'aes-256-gcm-file' : 'memory',
      catalog: VOICE_PROVIDER_CATALOG,
      credentials: this.state.credentials.map(c => this.toPublicCredential(c)),
      profiles: this.state.profiles.map(p => structuredClone(p)),
      prefs: { ...this.state.prefs },
      activeProfile: structuredClone(this.getActiveProfile()),
    }
  }

  getActiveProfile() {
    const found = this.state.profiles.find(p => p.id === this.state.prefs.activeProfileId)
    return found || this.state.profiles[0] || structuredClone(DEFAULT_NATIVE_PROFILE)
  }

  getProfileById(profileId = '') {
    const clean = String(profileId || '').trim()
    if (!clean) return this.getActiveProfile()
    return this.state.profiles.find(p => p.id === clean) || this.getActiveProfile()
  }

  resolveCredential({ provider = '', credId = '' } = {}) {
    const cleanProvider = String(provider || '').trim().toLowerCase()
    const cleanCredId = String(credId || '').trim()
    if (cleanCredId) {
      const exact = this.state.credentials.find(c => c.id === cleanCredId && c.enabled !== false)
      if (exact) return exact
    }
    if (cleanProvider) {
      const activeMatch = this.state.credentials.find(
        c => c.provider === cleanProvider && c.enabled !== false && c.active,
      )
      if (activeMatch) return activeMatch
      const firstMatch = this.state.credentials.find(c => c.provider === cleanProvider && c.enabled !== false)
      if (firstMatch) return firstMatch
    }
    return null
  }

  async upsertCredential(input = {}) {
    const provider = String(input?.provider ?? '').trim().toLowerCase()
    if (!ALLOWED_PROVIDERS.has(provider)) {
      return { ok: false, error: `不支持的服务商类型：${provider || '(空)'}` }
    }
    const catalogMeta = VOICE_PROVIDER_CATALOG.find(item => item.id === provider)
    const now = this.now()
    const existingId = String(input?.id ?? '').trim()
    const existing = existingId ? this.state.credentials.find(c => c.id === existingId) : null

    const cloneFromId = String(input?.cloneSecretFromCredId ?? '').trim()
    const cloneSource = cloneFromId ? this.state.credentials.find(c => c.id === cloneFromId) : null
    const baseUrlRawPreview = input?.baseUrl !== undefined ? String(input.baseUrl).trim() : existing?.baseUrl || ''
    const canCloneVolcSecret = Boolean(
      cloneSource
      && cloneSource.provider.startsWith('volcengine_')
      && provider.startsWith('volcengine_')
      && (!baseUrlRawPreview || /^https:\/\/openspeech\.bytedance\.com\//i.test(baseUrlRawPreview)),
    )

    const rawApiKey = input?.apiKey !== undefined ? String(input.apiKey).trim() : ''
    const rawAppId = input?.appId !== undefined ? String(input.appId).trim() : ''
    const rawAccessToken = input?.accessToken !== undefined ? String(input.accessToken).trim() : ''
    const apiKey = rawApiKey || (input?.apiKey === undefined ? existing?.apiKey || '' : '') || (canCloneVolcSecret ? cloneSource.apiKey || '' : '')
    const appId = rawAppId || (input?.appId === undefined ? existing?.appId || '' : '') || (canCloneVolcSecret ? cloneSource.appId || '' : '')
    const accessToken = rawAccessToken || (input?.accessToken === undefined ? existing?.accessToken || '' : '') || (canCloneVolcSecret ? cloneSource.accessToken || '' : '')

    if (provider === 'volcengine_asr' || provider === 'volcengine_tts') {
      if (!apiKey && !(appId && accessToken)) {
        return { ok: false, error: '请填写 API Key，或同时填写 AppID 与 Access Token' }
      }
    } else if (!apiKey) {
      return { ok: false, error: '请填写 API Key（不会写入明文日志或返回给前端）' }
    }

    const baseUrlRaw = input?.baseUrl !== undefined ? String(input.baseUrl).trim() : existing?.baseUrl || ''
    if (baseUrlRaw && isBlockedVoiceBaseUrl(baseUrlRaw)) {
      return { ok: false, error: '安全策略拦截：禁止将语音接口 Base URL 指向云厂商内网元数据或非法地址' }
    }
    const baseUrl = sanitizeUrl(baseUrlRaw) || catalogMeta?.defaultBaseUrl || ''
    const label = String(input?.label ?? '').trim().slice(0, 80) || existing?.label || `${catalogMeta?.shortName || provider} 密钥`
    const resourceId = String(input?.resourceId ?? existing?.resourceId ?? catalogMeta?.defaultResourceId ?? '').trim().slice(0, 80)
    const defaultModel = String(input?.defaultModel ?? existing?.defaultModel ?? '').trim().slice(0, 120)
    const defaultVoice = String(input?.defaultVoice ?? existing?.defaultVoice ?? '').trim().slice(0, 120)

    const hasSameProviderActive = this.state.credentials.some(c => c.provider === provider && c.active && c.id !== existing?.id)
    const shouldActivate = input?.active !== undefined ? Boolean(input.active) : (!existing && !hasSameProviderActive) || Boolean(existing?.active)

    if (shouldActivate) {
      for (const c of this.state.credentials) {
        if (c.provider === provider) c.active = false
      }
    }

    let saved
    if (existing) {
      existing.label = label
      existing.baseUrl = baseUrl
      existing.apiKey = apiKey
      existing.appId = appId
      existing.accessToken = accessToken
      existing.resourceId = resourceId
      existing.defaultModel = defaultModel
      existing.defaultVoice = defaultVoice
      existing.enabled = input?.enabled !== undefined ? Boolean(input.enabled) : existing.enabled !== false
      existing.active = shouldActivate
      existing.updatedAt = now
      saved = existing
    } else {
      saved = {
        id: `cred_${provider}_${randomBytes(4).toString('hex')}`,
        provider,
        label,
        baseUrl,
        apiKey,
        appId,
        accessToken,
        resourceId,
        defaultModel,
        defaultVoice,
        enabled: input?.enabled !== false,
        active: shouldActivate,
        createdAt: now,
        updatedAt: now,
      }
      this.state.credentials.push(saved)
    }

    await this.persist()
    return {
      ok: true,
      credential: this.toPublicCredential(saved),
      config: this.toPublicState(),
    }
  }

  async activateCredential(credId = '') {
    const cleanId = String(credId ?? '').trim()
    const target = this.state.credentials.find(c => c.id === cleanId)
    if (!target) {
      return { ok: false, error: '未找到指定密钥' }
    }
    for (const c of this.state.credentials) {
      if (c.provider === target.provider) {
        c.active = c.id === target.id
      }
    }
    target.updatedAt = this.now()
    await this.persist()
    return { ok: true, credential: this.toPublicCredential(target), config: this.toPublicState() }
  }

  async deleteCredential(credId = '') {
    const cleanId = String(credId ?? '').trim()
    const idx = this.state.credentials.findIndex(c => c.id === cleanId)
    if (idx < 0) {
      return { ok: false, error: '未找到要删除的密钥' }
    }
    const [removed] = this.state.credentials.splice(idx, 1)
    if (removed.active) {
      const replacement = this.state.credentials.find(c => c.provider === removed.provider && c.enabled !== false)
      if (replacement) replacement.active = true
    }
    // Clear dangling credId references in custom profiles so they fall back cleanly to active pool key
    for (const prof of this.state.profiles) {
      if (prof.builtin) continue
      if (prof.stt?.credId === cleanId) prof.stt.credId = ''
      if (prof.brain?.credId === cleanId) prof.brain.credId = ''
      if (prof.tts?.credId === cleanId) prof.tts.credId = ''
      if (Array.isArray(prof.stt?.fallbackChain)) {
        for (const step of prof.stt.fallbackChain) {
          if (step.credId === cleanId) step.credId = ''
        }
      }
    }
    await this.persist()
    return { ok: true, deletedId: cleanId, config: this.toPublicState() }
  }

  async upsertProfile(input = {}) {
    const now = this.now()
    const reqId = String(input?.id ?? '').trim()
    if (reqId === 'native') {
      return { ok: false, error: '系统原生语音方案为内置只读，请新建或编辑自定义方案' }
    }
    const name = String(input?.name ?? '').trim().slice(0, 80)
    if (!name) {
      return { ok: false, error: '请填写方案名称（例如：通勤混搭方案）' }
    }
    const existing = reqId ? this.state.profiles.find(p => p.id === reqId && !p.builtin) : null
    const stt = normalizeStageConfig(input?.stt, 'stt')
    const brain = normalizeStageConfig(input?.brain, 'brain')
    const tts = normalizeStageConfig(input?.tts, 'tts')

    let saved
    if (existing) {
      existing.name = name
      existing.stt = stt
      existing.brain = brain
      existing.tts = tts
      existing.updatedAt = now
      saved = existing
    } else {
      saved = {
        id: `prof_${randomBytes(4).toString('hex')}`,
        name,
        builtin: false,
        stt,
        brain,
        tts,
        createdAt: now,
        updatedAt: now,
      }
      this.state.profiles.push(saved)
    }

    if (input?.activate) {
      this.state.prefs.activeProfileId = saved.id
    }
    await this.persist()
    return { ok: true, profile: structuredClone(saved), config: this.toPublicState() }
  }

  async deleteProfile(profileId = '') {
    const cleanId = String(profileId ?? '').trim()
    if (!cleanId || cleanId === 'native') {
      return { ok: false, error: '内置系统原生方案不可删除' }
    }
    const idx = this.state.profiles.findIndex(p => p.id === cleanId)
    if (idx < 0) {
      return { ok: false, error: '未找到指定方案' }
    }
    this.state.profiles.splice(idx, 1)
    if (this.state.prefs.activeProfileId === cleanId) {
      this.state.prefs.activeProfileId = 'native'
    }
    await this.persist()
    return { ok: true, deletedId: cleanId, config: this.toPublicState() }
  }

  async updatePrefs(patch = {}) {
    const merged = { ...this.state.prefs, ...(patch && typeof patch === 'object' ? patch : {}) }
    const normalized = normalizePrefs(merged)
    if (!this.state.profiles.some(p => p.id === normalized.activeProfileId)) {
      normalized.activeProfileId = 'native'
    }
    this.state.prefs = normalized
    await this.persist()
    return { ok: true, prefs: { ...this.state.prefs }, config: this.toPublicState() }
  }
}
