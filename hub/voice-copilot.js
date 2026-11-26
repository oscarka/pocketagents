import { randomInt, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { assertSafeVoiceTargetUrl, isBlockedVoiceBaseUrl } from './voice-vault.js'

const DEFAULT_HTTP_TIMEOUT_MS = 25_000
const PIN_DEFAULT_TTL_MS = 30_000
const PIN_MAX_ATTEMPTS = 3
const PIN_LOCKOUT_TTL_MS = 10 * 60_000
const MAX_TTS_AUDIO_BYTES = 15 * 1024 * 1024

const L2_HIGH_RISK_PATTERNS = [
  /\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-r\s+-f|-f\s+-r|--recursive\b[^\n]*--force|--force\b[^\n]*--recursive|-r\b)/i,
  /\bgit\s+push\b[^\n]*(--force(?:-with-lease)?|-f\b|\s\+[^\s]+)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+(?:branch\s+-D|checkout\s+--\s+\.)/i,
  /\bdrop\s+(?:table|database|schema|index|view|user|role)\b/i,
  /\balter\s+table\b[^\n]*\bdrop\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b(?:\s+\S+\s+where\s+1\s*=\s*1\b|(?![^\n]*\bwhere\b))/i,
  /\bsudo\b/i,
  /\bchmod\s+(?:-R\s+)?(?:0?777|\+s)\b|\bchown\s+-R\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bkill\s+-9\b|\bpkill\s+-9\b/i,
  /\bkubectl\s+(?:delete|apply|exec)\b|\bhelm\s+uninstall\b/i,
  /\b(?:gcloud|aws|az)\b[^\n]*\bdelete\b/i,
  /\bterraform\s+(?:apply|destroy)\b/i,
  /\bdocker\s+(?:system\s+prune|rm\s+-f|push)\b/i,
  /\brsync\b[^\n]*--delete\b/i,
  /\bfind\b[^\n]*-delete\b|\bxargs\s+rm\b/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i,
  /\bdeploy\b[^\n]*(prod|production|live|main)\b/i,
  /\b(?:curl|wget)\b[^\n]*\|\s*(?:ba|z)?sh\b|\b(?:curl|wget)\b[^\n]*\|\s*(?:python3?|node)\b|\bbash\s+<\(/i,
  /\b(?:sh|bash|zsh)\s+-c\b|\bpython3?\s+-c\b|\bnode\s+-e\b|\bbase64\s+(?:-d|--decode)\s*\|/i,
  /\bwipe_host\b/i,
]

const L0_SAFE_TOOLS = new Set([
  'read_file',
  'view_file',
  'list_dir',
  'list_files',
  'grep',
  'grep_search',
  'find_by_name',
  'search',
  'glob',
  'get_status',
])

export function encodePcm16ToWav(pcmBuffer, sampleRate = 24000, channels = 1) {
  const pcm = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || [])
  const bitsPerSample = 16
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function resamplePcm16Mono(pcmBuffer, fromRate = 24000, toRate = 16000) {
  const src = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || [])
  const srcSamples = Math.floor(src.length / 2)
  const inRate = Math.max(4000, Math.min(96000, Math.round(Number(fromRate) || 24000)))
  const outRate = Math.max(4000, Math.min(96000, Math.round(Number(toRate) || 16000)))
  if (srcSamples === 0) return Buffer.alloc(0)
  if (inRate === outRate) return src.subarray(0, srcSamples * 2)
  const outSamples = Math.max(1, Math.round((srcSamples * outRate) / inRate))
  const out = Buffer.allocUnsafe(outSamples * 2)
  const ratio = inRate / outRate
  for (let i = 0; i < outSamples; i += 1) {
    const pos = i * ratio
    const idx = Math.floor(pos)
    const frac = pos - idx
    const s0 = src.readInt16LE(Math.min(idx, srcSamples - 1) * 2)
    const s1 = src.readInt16LE(Math.min(idx + 1, srcSamples - 1) * 2)
    const val = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac)))
    out.writeInt16LE(val, i * 2)
  }
  return out
}

export function classifyApprovalRisk(approval = {}) {
  if (!approval || typeof approval !== 'object') {
    return { level: 'L1', reason: '常规工具操作' }
  }
  const explicitRisk = String(approval.risk || approval.riskLevel || '').trim().toLowerCase()
  if (explicitRisk === 'l2' || explicitRisk === 'high' || explicitRisk === 'critical' || explicitRisk === 'danger') {
    return { level: 'L2', reason: '系统标记为高危操作' }
  }
  const kind = String(approval.kind || '').trim().toLowerCase()
  const toolName = String(approval.toolName || approval.tool || '').trim().toLowerCase()
  const rawBlob = [
    approval.toolName,
    approval.tool,
    approval.title,
    approval.promptTitle,
    approval.summary,
    approval.command,
    approval.commandLine,
    approval.permissionTarget,
    approval.reason,
    approval.description,
    approval.detail,
    typeof approval.input === 'string' ? approval.input : JSON.stringify(approval.input || ''),
    typeof approval.args === 'string' ? approval.args : JSON.stringify(approval.args || ''),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/\s+/g, ' ')

  for (const re of L2_HIGH_RISK_PATTERNS) {
    const m = re.exec(rawBlob)
    if (m) {
      return { level: 'L2', reason: `命中高危指令特征 (${m[0].trim()})` }
    }
  }
  if (kind === 'question' || toolName === 'ask_user_question' || L0_SAFE_TOOLS.has(toolName)) {
    return { level: 'L0', reason: '只读或问答交互' }
  }
  return { level: 'L1', reason: '常规可逆开发操作' }
}

const ZH_SINGLE_DIGITS = {
  零: '0',
  〇: '0',
  洞: '0',
  一: '1',
  壹: '1',
  幺: '1',
  妖: '1',
  二: '2',
  贰: '2',
  两: '2',
  三: '3',
  叁: '3',
  四: '4',
  肆: '4',
  五: '5',
  伍: '5',
  六: '6',
  陆: '6',
  七: '7',
  柒: '7',
  拐: '7',
  八: '8',
  捌: '8',
  九: '9',
  玖: '9',
  勾: '9',
}

const EN_DIGIT_WORDS = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
}

function parseChineseHundredsTo3Digits(raw = '') {
  const s = String(raw || '')
  // Match e.g. 七百三十九, 两百零八, 二百五, 三百二十, 一百零一, 九百
  const m = /([一壹幺二贰两三叁四肆五伍六陆七柒八捌九玖])百(?:([零〇一壹二贰三叁四肆五伍六陆七柒八捌九玖])(?:十([一壹二贰三叁四肆五伍六陆七柒八捌九玖])?)?|十([一壹二贰三叁四肆五伍六陆七柒八捌九玖])?)?/.exec(s)
  if (!m) return ''
  const h = Number(ZH_SINGLE_DIGITS[m[1]] || 0)
  if (!h) return ''
  let t = 0
  let u = 0
  if (m[2]) {
    if (m[2] === '零' || m[2] === '〇') {
      // 七百零八 -> check next char after 零 in raw substring
      const afterZeroIdx = m.index + m[1].length + 2
      const nextCh = s[afterZeroIdx]
      if (nextCh && ZH_SINGLE_DIGITS[nextCh] !== undefined) {
        u = Number(ZH_SINGLE_DIGITS[nextCh])
      }
    } else if (m[0].includes('十')) {
      t = Number(ZH_SINGLE_DIGITS[m[2]] || 0)
      u = m[3] ? Number(ZH_SINGLE_DIGITS[m[3]] || 0) : 0
    } else {
      // Colloquial 二百五 -> 250
      t = Number(ZH_SINGLE_DIGITS[m[2]] || 0)
    }
  } else if (m[0].includes('十')) {
    t = 1
    u = m[4] ? Number(ZH_SINGLE_DIGITS[m[4]] || 0) : 0
  }
  const total = h * 100 + t * 10 + u
  return total >= 100 && total <= 999 ? String(total) : ''
}

export function extractSpokenPin(text = '') {
  const raw = String(text ?? '').trim()
  if (!raw) return ''

  // 1. Direct 3 consecutive Arabic digits (or separated by spaces/dashes/commas/dots)
  const direct = /(?<!\d)(\d)\s*[-,，、.\s]?\s*(\d)\s*[-,，、.\s]?\s*(\d)(?!\d)/.exec(raw)
  if (direct) {
    return `${direct[1]}${direct[2]}${direct[3]}`
  }

  // 2. Spoken Chinese hundreds form ("七百三十九", "两百零八")
  const zhHundreds = parseChineseHundredsTo3Digits(raw)
  if (zhHundreds) return zhHundreds

  // 3. Spoken Chinese digit-by-digit ("七三九", "确认码 幺 洞 九", "七、三、九")
  const zhDigits = []
  for (const ch of raw) {
    if (ZH_SINGLE_DIGITS[ch] !== undefined) {
      zhDigits.push(ZH_SINGLE_DIGITS[ch])
    } else if (/\d/.test(ch)) {
      zhDigits.push(ch)
    } else if (zhDigits.length > 0 && !/[\s,，、.。·\-~]/.test(ch)) {
      if (zhDigits.length === 3) return zhDigits.join('')
      zhDigits.length = 0
    }
  }
  if (zhDigits.length === 3) return zhDigits.join('')

  // 4. Spoken English digit words ("seven three nine", "oh two five")
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const enDigits = []
  for (const w of words) {
    if (EN_DIGIT_WORDS[w] !== undefined) {
      enDigits.push(EN_DIGIT_WORDS[w])
    } else if (/^\d$/.test(w)) {
      enDigits.push(w)
    } else if (enDigits.length === 3) {
      return enDigits.join('')
    } else {
      enDigits.length = 0
    }
  }
  if (enDigits.length === 3) return enDigits.join('')

  return ''
}

const REJECT_INTENT_RE = /(拒绝|不同意|取消|算了|别执行|不要执行|驳回|跳过|停止|\breject\b|\bdeny\b|\bcancel\b|\bno\b)/i
const APPROVE_INTENT_RE = /(批准|放行|同意|允许|通过|确认执行|准了|可以执行|\bapprove\b|\ballow\b|\byes\b|\bconfirm\b)/i

export function generateSafe3DigitPin() {
  for (let i = 0; i < 12; i += 1) {
    const n = randomInt(100, 1000)
    const s = String(n)
    if (!(s[0] === s[1] && s[1] === s[2])) {
      return s
    }
  }
  return '739'
}

export function formatPinForSpeech(pin = '') {
  return String(pin || '').split('').join('、')
}

export class VoicePinChallengeStore {
  constructor({ now = () => Date.now(), ttlMs = PIN_DEFAULT_TTL_MS, maxAttempts = PIN_MAX_ATTEMPTS } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    this.maxAttempts = maxAttempts
    this.challenges = new Map()
    this.lockedApprovals = new Map()
  }

  isApprovalLocked(hostId = '', code = '') {
    const cleanCode = String(code || '').trim().toUpperCase()
    if (!cleanCode) return false
    const lockKey = `${String(hostId || '').trim()}:${cleanCode}`
    const until = this.lockedApprovals.get(lockKey)
    if (!until) return false
    if (this.now() > until) {
      this.lockedApprovals.delete(lockKey)
      return false
    }
    return true
  }

  issue(sessionKey = 'default', { hostId = '', code = '', agentId = '', summary = '', reason = '' } = {}) {
    const key = String(sessionKey || 'default').trim() || 'default'
    const now = this.now()
    for (const [k, v] of this.challenges.entries()) {
      if (now > v.expiresAt) this.challenges.delete(k)
    }
    const pin = generateSafe3DigitPin()
    const entry = {
      id: `pin_${randomUUID().slice(0, 8)}`,
      sessionKey: key,
      pin,
      hostId,
      code: String(code || '').trim().toUpperCase(),
      agentId,
      summary: String(summary || '').slice(0, 160),
      reason: String(reason || '高危操作').slice(0, 120),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      attempts: 0,
      maxAttempts: this.maxAttempts,
    }
    this.challenges.set(key, entry)
    while (this.challenges.size > 100) {
      const oldest = this.challenges.keys().next().value
      this.challenges.delete(oldest)
    }
    return { ...entry }
  }

  getActive(sessionKey = 'default') {
    const key = String(sessionKey || 'default').trim() || 'default'
    const entry = this.challenges.get(key)
    if (!entry) return null
    if (this.now() > entry.expiresAt) {
      this.challenges.delete(key)
      return null
    }
    return { ...entry }
  }

  clear(sessionKey = 'default') {
    const key = String(sessionKey || 'default').trim() || 'default'
    this.challenges.delete(key)
  }

  verify(sessionKey = 'default', spokenText = '') {
    const key = String(sessionKey || 'default').trim() || 'default'
    const entry = this.challenges.get(key)
    if (!entry) return { status: 'none' }
    if (this.now() > entry.expiresAt) {
      this.challenges.delete(key)
      return { status: 'expired', challenge: { ...entry } }
    }
    const cleanText = String(spokenText || '').trim()
    if (REJECT_INTENT_RE.test(cleanText)) {
      this.challenges.delete(key)
      return { status: 'rejected', challenge: { ...entry } }
    }
    const extracted = extractSpokenPin(cleanText)
    if (extracted && extracted === entry.pin) {
      this.challenges.delete(key)
      return { status: 'matched', extractedPin: extracted, challenge: { ...entry } }
    }
    if (extracted && extracted !== entry.pin) {
      entry.attempts += 1
      if (entry.attempts >= entry.maxAttempts) {
        this.challenges.delete(key)
        if (entry.code) {
          this.lockedApprovals.set(`${entry.hostId}:${entry.code}`, this.now() + PIN_LOCKOUT_TTL_MS)
          while (this.lockedApprovals.size > 200) {
            const oldest = this.lockedApprovals.keys().next().value
            this.lockedApprovals.delete(oldest)
          }
        }
        return { status: 'locked', extractedPin: extracted, challenge: { ...entry } }
      }
      return {
        status: 'mismatch',
        extractedPin: extracted,
        remainingAttempts: entry.maxAttempts - entry.attempts,
        challenge: { ...entry },
      }
    }
    if (APPROVE_INTENT_RE.test(cleanText)) {
      return {
        status: 'missing_pin',
        remainingAttempts: entry.maxAttempts - entry.attempts,
        challenge: { ...entry },
      }
    }
    return { status: 'passthrough', challenge: { ...entry } }
  }
}

export function splitIntoProgressiveTtsChunks(text = '', { firstChunkMax = 32, nextChunkMax = 140 } = {}) {
  const clean = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[`*_#>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return []
  const sentences = clean.split(/(?<=[。！？.!?\n；;])\s*/).filter(Boolean)
  const chunks = []
  let current = ''
  const limitForIndex = idx => (idx === 0 ? firstChunkMax : nextChunkMax)

  for (const s of sentences) {
    const seg = s.trim()
    if (!seg) continue
    const limit = limitForIndex(chunks.length)
    if (!current) {
      if (seg.length <= limit) {
        current = seg
      } else {
        const subParts = seg.split(/(?<=[，,、：:])\s*/).filter(Boolean)
        for (const sp of subParts) {
          const curLim = limitForIndex(chunks.length)
          if (!current) {
            current = sp
          } else if (current.length + sp.length <= curLim) {
            current += sp
          } else {
            chunks.push(current.trim())
            current = sp
          }
        }
      }
    } else if (current.length + seg.length <= limit) {
      current += seg
    } else {
      chunks.push(current.trim())
      current = seg
    }
  }
  if (current.trim()) {
    chunks.push(current.trim())
  }
  return chunks
}

const FOCUS_APPROVAL_TTL_MS = 45_000
const SLOT_ZH_MAP = {
  一: 1, 幺: 1,
  二: 2, 两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}
const OPTION_LETTER_MAP = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }

function parseSmallZhOrDigit(token = '') {
  const t = String(token || '').trim()
  if (!t) return 0
  if (/^[1-9]$/.test(t)) return Number(t)
  return SLOT_ZH_MAP[t] || 0
}

/**
 * Extract an explicit approval queue slot number (1..9) from spoken text,
 * e.g. "放行1号", "拒绝二号", "第一条允许", "#2 批准", "2号选第三个" -> 1/2/1/2/2.
 * Carefully avoids matching option choices like "选第二个" or "选项2".
 */
export function extractSpokenSlotNumber(text = '') {
  const raw = String(text ?? '').trim()
  if (!raw) return 0
  const m1 = /(?:第\s*([1-9一二两三四五六七八九])\s*(?:条|号)|([1-9一二两三四五六七八九])\s*号|#([1-9])\b|slot\s*([1-9])\b)/i.exec(raw)
  if (m1) {
    return parseSmallZhOrDigit(m1[1] || m1[2] || m1[3] || m1[4])
  }
  const m2 = /(?:批准|放行|拒绝|取消|同意|允许|跳过|驳回)\s*(?:第\s*)?([1-9一二两三四五六七八九])(?:\s*(?:号|条|个))?(?!\s*(?:项|选项|方案))/i.exec(raw)
  if (m2) {
    return parseSmallZhOrDigit(m2[1])
  }
  return 0
}

/**
 * Extract an explicit spoken choice/option index (1..9) from text,
 * e.g. "选第二个", "选项2", "选B", "方案三", "option 2" -> 2/2/2/3/2.
 */
export function extractSpokenOptionIndex(text = '') {
  const raw = String(text ?? '').trim()
  if (!raw) return 0
  const mNum = /(?:选择?|选项|方案)\s*(?:第\s*)?([1-9一二两三四五六七八九])(?:\s*(?:个|项))?|第\s*([1-9一二两三四五六七八九])\s*(?:个选项|项|个方案)|option\s*([1-9])\b/i.exec(raw)
  if (mNum) {
    return parseSmallZhOrDigit(mNum[1] || mNum[2] || mNum[3])
  }
  const mLetter = /(?:选择?|选项|方案)\s*([a-fA-F])(?![a-zA-Z0-9])/i.exec(raw)
  if (mLetter) {
    return OPTION_LETTER_MAP[mLetter[1].toLowerCase()] || 0
  }
  return 0
}

export function sanitizeTextForVoiceBriefing(rawText = '', maxChars = 120) {
  let s = String(rawText ?? '')
  if (!s.trim()) return ''
  // Strip fenced code blocks and inline code
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`([^`]{1,40})`/g, '$1').replace(/`[^`]+`/g, ' ')
  // Replace markdown links with display text only
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Strip URLs, absolute paths, and long hex hashes
  s = s.replace(/https?:\/\/[^\s)]+/gi, ' ')
  s = s.replace(/(?:\/Users\/|\/home\/|\/var\/|\/tmp\/|\/opt\/|[A-Za-z]:\\)[^\s,，。;；)]+/g, ' ')
  s = s.replace(/\b[0-9a-f]{12,64}\b/gi, ' ')
  // Strip markdown formatting symbols
  s = s.replace(/[#>*_~|]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length <= maxChars) return s
  // Prefer stopping cleanly at sentence boundary
  const head = s.slice(0, maxChars)
  const stopIdx = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'))
  if (stopIdx >= Math.floor(maxChars * 0.45)) {
    return head.slice(0, stopIdx + 1)
  }
  return `${head.trim()}。`
}

export function computeDenyOptionIndex(approval = {}) {
  const opts = Array.isArray(approval?.options) ? approval.options : []
  for (let i = 0; i < opts.length; i += 1) {
    const o = opts[i]
    const label = String(typeof o === 'string' ? o : (o?.label || '')).trim().toLowerCase()
    if (/^(no\b|deny\b|reject\b|skip\b|拒绝|取消)/.test(label)) {
      return Number(o?.index) || (i + 1)
    }
  }
  return opts.length === 2 ? 2 : 4
}

export function formatApprovalBriefingSpeech(approval = {}, { totalCount = 1 } = {}) {
  if (!approval) return ''
  const slot = Number(approval.slot) || 1
  const host = String(approval.hostName || approval.hostId || '电脑').trim()
  const sess = String(approval.sessionTitle || '').trim()
  const who = sess && sess !== approval.title ? `${host}的${sess}` : host
  const slotTag = `${slot}号`

  if (approval.kind === 'question' && Array.isArray(approval.questions) && approval.questions.length > 0) {
    const q = approval.questions[0] || {}
    const qText = sanitizeTextForVoiceBriefing(q.question || approval.promptTitle || approval.title || '需要你选择', 70)
    const opts = Array.isArray(q.options) ? q.options.slice(0, 4) : []
    const optStr = opts
      .map((o, i) => `选项${i + 1}，${sanitizeTextForVoiceBriefing(typeof o === 'string' ? o : (o?.label || ''), 24)}`)
      .filter(Boolean)
      .join('；')
    const suffix = totalCount > 1 ? `请说${slotTag}选第几个。` : '请直接说选第几个。'
    return `${slotTag}提问，${who}问你：${qText}${optStr ? `。${optStr}。` : '。'}${suffix}`
  }

  const rawSummary = approval.promptTitle || approval.title || approval.command || approval.toolName || '工具执行确认'
  const cleanSummary = sanitizeTextForVoiceBriefing(rawSummary, 68)
  const opts = Array.isArray(approval.options) ? approval.options : []
  let optHint = ''
  if (opts.length === 2) {
    optHint = '选项1允许，选项2拒绝。'
  } else if (opts.length > 2 && opts.length <= 4 && approval.kind !== 'approval') {
    optHint = `${opts
      .slice(0, 3)
      .map((o, i) => `选项${i + 1}${sanitizeTextForVoiceBriefing(typeof o === 'string' ? o : (o?.label || ''), 16)}`)
      .join('，')}。`
  }

  if (approval.riskLevel === 'L2') {
    return `${slotTag}高危待审批，${who}：${cleanSummary}。如需放行请说放行${slotTag}触发确认码，或说拒绝。`
  }
  const replyCue = totalCount > 1 ? `请说放行${slotTag}或拒绝${slotTag}。` : '请说放行或拒绝。'
  return `${slotTag}待审批，${who}：${cleanSummary}。${optHint}${replyCue}`
}

export function buildAmbiguousApprovalsReply(approvals = []) {
  const list = approvals
    .slice(0, 4)
    .map(a => {
      const who = a.sessionTitle ? `${a.hostName}的${a.sessionTitle}` : a.hostName
      const desc = sanitizeTextForVoiceBriefing(a.promptTitle || a.title || a.toolName || '待确认', 28)
      return `${a.slot}号，${who}${desc ? `：${desc}` : ''}`
    })
    .join('；')
  return `当前有 ${approvals.length} 条待审批，为防批错请说编号：${list}。请说放行几号或拒绝几号。`
}

export function resolveApprovalTarget(userText = '', approvals = [], { focusedApproval = null, now = Date.now() } = {}) {
  const list = Array.isArray(approvals) ? approvals : []
  if (list.length === 0) return { status: 'empty', approval: null }
  const text = String(userText || '').trim()
  const upper = text.toUpperCase()

  // 1. Exact approval code match
  const byCode = list.find(a => a.code && upper.includes(a.code))
  if (byCode) return { status: 'matched', approval: byCode, reason: 'code' }

  // 2. Explicit spoken slot number ("1号", "第二条")
  const slot = extractSpokenSlotNumber(text)
  if (slot > 0) {
    const bySlot = list.find(a => Number(a.slot) === slot) || list[slot - 1] || null
    if (bySlot) return { status: 'matched', approval: bySlot, reason: 'slot' }
    return { status: 'not_found', slot, approval: null }
  }

  // 3. Unique session title / host name keyword match
  if (text.length >= 2) {
    const lower = text.toLowerCase()
    const matchedByName = list.filter(a => {
      const sess = String(a.sessionTitle || '').trim().toLowerCase()
      const host = String(a.hostName || '').trim().toLowerCase()
      const title = String(a.title || '').trim().toLowerCase()
      const hitSess = sess.length >= 2 && (lower.includes(sess) || (sess.length >= 4 && lower.includes(sess.slice(0, 3))))
      const hitHost = host.length >= 3 && lower.includes(host)
      const hitTitle = title.length >= 4 && lower.includes(title.slice(0, 6))
      return hitSess || hitHost || hitTitle
    })
    if (matchedByName.length === 1) {
      return { status: 'matched', approval: matchedByName[0], reason: 'name' }
    }
  }

  // 4. Single pending approval -> unambiguous!
  if (list.length === 1) {
    return { status: 'matched', approval: list[0], reason: 'sole' }
  }

  // 5. Multiple pending approvals -> ONLY use a fresh focusedApproval announced within 45s
  if (focusedApproval && focusedApproval.code) {
    const announcedAt = Number(focusedApproval.announcedAt) || 0
    const isFresh = announcedAt === 0 || (now - announcedAt <= FOCUS_APPROVAL_TTL_MS)
    if (isFresh) {
      const focused = list.find(
        a => a.code === String(focusedApproval.code).toUpperCase()
          && (!focusedApproval.hostId || a.hostId === focusedApproval.hostId),
      )
      if (focused) {
        return { status: 'matched', approval: focused, reason: 'focus' }
      }
    }
  }

  // 6. Ambiguous multi-approval -> NEVER guess!
  return { status: 'ambiguous', approval: null, approvals: list }
}

export function buildDynamicVoiceContext(hub, { activeHostId = '', activeSessionId = '' } = {}) {
  const state = typeof hub?.getFullState === 'function' ? hub.getFullState() : { hosts: [], activeHostId: '' }
  const hosts = Array.isArray(state?.hosts) ? state.hosts : []
  const effectiveActiveHostId = activeHostId || state?.activeHostId || hosts[0]?.hostId || ''

  const pendingApprovals = []
  const tasks = []
  const hotwords = new Set([
    '放行',
    '批准',
    '拒绝',
    '确认码',
    '一号',
    '二号',
    '三号',
    '选第一个',
    '选第二个',
    '新建任务',
    '停止任务',
    'PocketAgents',
    'Antigravity',
    'Claude',
    'Codex',
    'pytest',
    'npm test',
    'git status',
  ])

  for (const h of hosts) {
    const hostId = String(h?.hostId || '')
    const hostName = String(h?.hostName || hostId)
    if (hostName) hotwords.add(hostName)
    const bridge = h?.bridgeState || {}
    const hostApprovals = Array.isArray(bridge.approvals) ? bridge.approvals : []
    const hostTasks = Array.isArray(bridge.tasks) ? bridge.tasks : []

    const taskTitleByAgentId = new Map()
    for (const t of hostTasks) {
      if (!t || !t.id) continue
      const cwd = String(t.cwd || '')
      const projectName = cwd ? basename(cwd) : ''
      if (projectName) hotwords.add(projectName)
      const title = String(t.title || t.name || projectName || t.id).slice(0, 80)
      taskTitleByAgentId.set(String(t.id), title)
      if (title && title.length <= 24) hotwords.add(title)
      const latestAsstMsg = Array.isArray(t.transcript)
        ? [...t.transcript].reverse().find(m => m?.role === 'assistant' && String(m?.text || '').trim())
        : null
      const fullConclusionText = String(latestAsstMsg?.text || t.lastOutput || t.lastSummary || '')
      tasks.push({
        hostId,
        hostName,
        agentId: String(t.id),
        title,
        projectName,
        cwd,
        harness: String(t.harness || t.source || 'dsh'),
        status: String(t.status || 'idle'),
        updatedAt: Number(t.updatedAt || t.lastActivity || 0),
        lastOutput: fullConclusionText.replace(/\s+/g, ' ').slice(0, 420),
        fullOutput: fullConclusionText.slice(0, 3200),
        hasPendingApproval: Boolean(t.pendingApproval),
      })
    }

    for (const a of hostApprovals) {
      if (!a) continue
      const risk = classifyApprovalRisk(a)
      const code = String(a.code || '').trim().toUpperCase()
      if (code) hotwords.add(code)
      const agentId = String(a.agentId || '')
      const sessionTitle = String(taskTitleByAgentId.get(agentId) || a.sessionTitle || '').slice(0, 60)
      pendingApprovals.push({
        hostId,
        hostName,
        code,
        agentId,
        sessionTitle,
        kind: String(a.kind || 'approval'),
        toolName: String(a.toolName || a.tool || ''),
        promptTitle: String(a.promptTitle || '').slice(0, 140),
        title: String(a.promptTitle || a.title || a.summary || a.toolName || '工具审批').slice(0, 120),
        command: String(a.commandLine || a.command || a.summary || a.description || '').slice(0, 220),
        riskLevel: risk.level,
        riskReason: risk.reason,
        createdAt: Number(a.createdAt) || 0,
        options: Array.isArray(a.options) ? a.options.slice(0, 6) : [],
        questions: Array.isArray(a.questions) ? a.questions.slice(0, 3) : [],
      })
    }
  }

  // Deterministic FIFO numbering so slot #1 stays stable as new approvals arrive as #2, #3...
  pendingApprovals.sort((a, b) => {
    const ca = a.createdAt || Number.MAX_SAFE_INTEGER
    const cb = b.createdAt || Number.MAX_SAFE_INTEGER
    if (ca !== cb) return ca - cb
    return `${a.hostId}:${a.code}`.localeCompare(`${b.hostId}:${b.code}`)
  })
  pendingApprovals.forEach((a, idx) => {
    a.slot = idx + 1
  })

  tasks.sort((a, b) => {
    const score = s => (s.hasPendingApproval ? 3 : s.status === 'running' ? 2 : 1)
    return score(b) - score(a) || b.updatedAt - a.updatedAt
  })

  return {
    activeHostId: effectiveActiveHostId,
    activeSessionId: String(activeSessionId || ''),
    hosts: hosts.map(h => ({
      hostId: h.hostId,
      hostName: h.hostName || h.hostId,
      online: Boolean(h.online),
      runningCount: Number(h.runningCount) || 0,
      taskCount: Number(h.taskCount) || 0,
      workspaces: Array.isArray(h.bridgeState?.workspaces) ? h.bridgeState.workspaces.slice(0, 8) : [],
    })),
    pendingApprovals,
    tasks: tasks.slice(0, 12),
    hotwords: [...hotwords].slice(0, 40),
  }
}

export function buildGeminiThinkingConfig(model = '', thinkingLevel = 'default', { isAudioStt = false } = {}) {
  const m = String(model || '').toLowerCase()
  const level = String(thinkingLevel || 'default').toLowerCase()
  if (level === 'default') return undefined

  const isGemini25 = m.includes('2.5')
  const isGemini3Or4 = /gemini-[34]|hydrogen/.test(m)

  if (isGemini25) {
    if (isAudioStt) {
      // Verified live on Cloud Run: thinkingBudget=0 on 2.5-flash audio STT causes dropped words!
      if (level === 'off') return undefined
      if (level === 'low') return { thinkingBudget: 256 }
      if (level === 'medium') return { thinkingBudget: 1024 }
      return { thinkingBudget: 4096 }
    }
    if (level === 'off') return { thinkingBudget: 0 }
    if (level === 'low') return { thinkingBudget: 512 }
    if (level === 'medium') return { thinkingBudget: 2048 }
    return { thinkingBudget: 8192 }
  }

  if (isGemini3Or4) {
    // Verified live on Cloud Run: Gemini 3.8 & 4-hydrogen reject MINIMAL/budget=0 with HTTP 400; 'low' is minimum valid!
    if (level === 'off' || level === 'low') return { thinkingLevel: 'low' }
    if (level === 'medium') return { thinkingLevel: 'medium' }
    return { thinkingLevel: 'high' }
  }

  return undefined
}

function normalizeOpenAiCompatBaseUrl(raw = '') {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|audio\/transcriptions|audio\/speech)$/i, '')
}

function formatFetchError(err) {
  if (!err) return 'fetch failed'
  if (err?.name === 'AbortError') return '请求超时（timeout）'
  const cause = err?.cause
  const nestedErr = Array.isArray(cause?.errors) && cause.errors.length > 0 ? cause.errors[0] : null
  const code = nestedErr?.code || cause?.code || err?.code || ''
  const detail = nestedErr?.message || cause?.message || err?.message || 'fetch failed'
  if (code && !String(detail).includes(String(code))) {
    return `${detail} (${code})`
  }
  return String(detail)
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  await assertSafeVoiceTargetUrl(url, { resolveDns: fetchImpl === globalThis.fetch })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...options, redirect: 'error', signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

function buildVolcHeaders(cred, resourceId, provider = '') {
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': randomUUID(),
  }
  if (cred.apiKey) {
    headers['X-Api-Key'] = cred.apiKey
  } else {
    if (provider === 'volcengine_asr') {
      headers['X-Api-App-Key'] = cred.appId
    } else if (provider === 'volcengine_tts') {
      headers['X-Api-App-Id'] = cred.appId
    } else {
      headers['X-Api-App-Id'] = cred.appId
      headers['X-Api-App-Key'] = cred.appId
    }
    headers['X-Api-Access-Key'] = cred.accessToken
  }
  return headers
}

function extractJsonObject(rawText = '') {
  const raw = String(rawText || '').trim()
  if (!raw) return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function buildVoiceSystemPrompt(ctx, l2Policy = 'pin', focusedApproval = null) {
  return [
    '你是 PocketAgents 的「随行语音总管」，专门服务于戴耳机听歌/散步/通勤时的开发者。',
    '你必须严格输出一个 JSON 对象，不要输出任何额外解释文字或 Markdown 代码块以外的废话。',
    'JSON Schema:',
    '{',
    '  "spokenReply": "给耳朵听的自然口语中文回复（简短直接，通常1-3句，严禁读出长文件路径、hash、JSON、代码块或反引号）",',
    '  "action": {',
    '    "type": "none | query_status | inspect_session | approve | reject | answer_question | send_prompt | create_task | stop_session",',
    '    "hostId": "目标电脑 hostId（可空，默认当前活跃电脑）",',
    '    "agentId": "目标会话 agentId（涉及具体会话时必填）",',
    '    "code": "审批单号 code（涉及 approve/reject/answer_question 时必填，必须来自上下文真实列表）",',
    '    "slot": 1,',
    '    "optionIndex": 1,',
    '    "answers": [],',
    '    "prompt": "要追问或新建任务的清晰提示词",',
    '    "cwd": "可选工作目录路径",',
    '    "harness": "可选引擎名（dsh / antigravity-ide / claude / codex）"',
    '  }',
    '}',
    '安全铁律与防串台规则：',
    '1. 只能引用下方实时上下文中真实存在的 hostId、agentId、slot 和 code，绝不编造。',
    '2. 每条待审批都有唯一序号 slot（1号、2号、3号…）。如果当前有多条待审批，且用户没有说出序号/会话名/单号，同时也没有刚播报过的 focusedApproval，严禁盲批！必须把 action.type 设为 "none"，简短念出 1号、2号 摘要让用户指定编号。',
    '3. 若存在有效的 focusedApproval（刚刚 45 秒内播报给用户并自动开麦等待回答），用户直接说“放行/拒绝/选第二个”即指该 focusedApproval，输出它对应的 hostId、code、slot，并在 spokenReply 中报出编号与名称方便用户核对。',
    `4. 高危审批策略当前为 ${l2Policy === 'pin' ? '「念出随机 3 位确认码放行」' : '「仅允许在手机屏幕点按确认」'}；若用户想批准风险标记为 L2 的审批，你仍然输出 action.type="approve" 与对应 code，后端安全闸门会自动生成 3 位确认码拦截，绝不要在 spokenReply 中声称“已直接放行高危操作”。`,
    '5. 如果用户问进度、汇总、某任务结论，使用 type="query_status" 或 "inspect_session"，把关键结论用自然口语念出来；若有待审批，按 1号、2号 简短念出要点和选项。',
    '',
    '当前实时电脑与任务上下文：',
    JSON.stringify({
      activeHostId: ctx.activeHostId,
      activeSessionId: ctx.activeSessionId,
      focusedApproval: focusedApproval || null,
      hosts: ctx.hosts,
      pendingApprovals: ctx.pendingApprovals,
      tasks: ctx.tasks,
    }),
  ].join('\n')
}

export function runNativeRuleRouter(userText = '', ctx = {}) {
  const text = String(userText || '').trim()
  const approvals = Array.isArray(ctx.pendingApprovals) ? ctx.pendingApprovals : []
  const tasks = Array.isArray(ctx.tasks) ? ctx.tasks : []
  const runningTasks = tasks.filter(t => t.status === 'running')
  const defaultHostId = ctx.activeHostId || ctx.hosts?.[0]?.hostId || ''
  const focusedApproval = ctx.focusedApproval || null
  const now = Number(ctx.now) || Date.now()

  if (!text) {
    return {
      spokenReply: '没听清，你可以再说一遍，比如问我现在什么进度，或者说放行1号。',
      action: { type: 'none' },
    }
  }

  // 1. Check status / briefing queries
  if (/(状态|进度|怎么样|汇报|几个任务|有啥|有什么审批|待审批|念一下|总结|status|brief)/i.test(text)) {
    const parts = []
    if (approvals.length > 0) {
      parts.push(`当前有 ${approvals.length} 条待审批。${formatApprovalBriefingSpeech(approvals[0], { totalCount: approvals.length })}`)
      if (approvals.length > 1) {
        const rest = approvals.slice(1, 3).map(a => `${a.slot}号，${a.sessionTitle || a.hostName}：${sanitizeTextForVoiceBriefing(a.title, 24)}`).join('；')
        parts.push(`另外还有：${rest}。`)
      }
    } else {
      parts.push('目前没有待审批。')
    }
    if (runningTasks.length > 0) {
      parts.push(`有 ${runningTasks.length} 个任务正在运行，例如 ${runningTasks[0].title}。`)
    } else if (tasks.length > 0) {
      const cleanSummary = sanitizeTextForVoiceBriefing(tasks[0].lastOutput || '', 72)
      parts.push(`最近完成的任务是 ${tasks[0].title}${cleanSummary ? '，摘要：' + cleanSummary : ''}。`)
    } else {
      parts.push('当前没有活跃任务。')
    }
    return {
      spokenReply: parts.join(' '),
      action: { type: 'query_status', hostId: defaultHostId },
    }
  }

  // 2. Select option for multiple-choice question or multi-option approval ("选第二个", "1号选B")
  const chosenOptionIdx = extractSpokenOptionIndex(text)
  if (approvals.length > 0 && chosenOptionIdx > 0) {
    const resolved = resolveApprovalTarget(text, approvals, { focusedApproval, now })
    if (resolved.status === 'ambiguous') {
      return {
        spokenReply: buildAmbiguousApprovalsReply(approvals),
        action: { type: 'none', ambiguousApprovals: true },
      }
    }
    if (resolved.status === 'not_found') {
      return {
        spokenReply: `没有找到 ${resolved.slot} 号待审批，当前共有 ${approvals.length} 条待审批。`,
        action: { type: 'none' },
      }
    }
    const target = resolved.approval
    if (target.kind === 'question' && Array.isArray(target.questions) && target.questions.length > 0) {
      const q = target.questions[0]
      const opts = Array.isArray(q.options) ? q.options : []
      const picked = opts[chosenOptionIdx - 1]
      const pickedLabel = typeof picked === 'string' ? picked : (picked?.label || `选项 ${chosenOptionIdx}`)
      return {
        spokenReply: `好的，已为 ${target.slot} 号「${target.sessionTitle || target.title}」选择第 ${chosenOptionIdx} 项：${sanitizeTextForVoiceBriefing(pickedLabel, 24)}。`,
        action: {
          type: 'answer_question',
          hostId: target.hostId,
          agentId: target.agentId,
          code: target.code,
          slot: target.slot,
          optionIndex: chosenOptionIdx,
          answers: [{ questionId: q.id || 'q_1', selected: [pickedLabel] }],
        },
      }
    }
    const denyIdx = computeDenyOptionIndex(target)
    if (chosenOptionIdx === denyIdx) {
      return {
        spokenReply: `好的，已拒绝 ${target.slot} 号：${sanitizeTextForVoiceBriefing(target.title, 30)}。`,
        action: {
          type: 'reject',
          hostId: target.hostId,
          agentId: target.agentId,
          code: target.code,
          slot: target.slot,
          optionIndex: denyIdx,
        },
      }
    }
    return {
      spokenReply: target.riskLevel === 'L2'
        ? `检测到高危操作 ${target.slot} 号 ${sanitizeTextForVoiceBriefing(target.title, 30)}，正在启动语音确认码校验。`
        : `好的，已为 ${target.slot} 号选择第 ${chosenOptionIdx} 项并提交。`,
      action: {
        type: 'approve',
        hostId: target.hostId,
        agentId: target.agentId,
        code: target.code,
        slot: target.slot,
        optionIndex: chosenOptionIdx,
      },
    }
  }

  // 3. Reject approval (strict anti-mixup!)
  if (approvals.length > 0 && REJECT_INTENT_RE.test(text) && !/(任务|会话|新建)/.test(text)) {
    const resolved = resolveApprovalTarget(text, approvals, { focusedApproval, now })
    if (resolved.status === 'ambiguous') {
      return {
        spokenReply: buildAmbiguousApprovalsReply(approvals),
        action: { type: 'none', ambiguousApprovals: true },
      }
    }
    if (resolved.status === 'not_found') {
      return {
        spokenReply: `没有找到 ${resolved.slot} 号待审批，当前共有 ${approvals.length} 条。`,
        action: { type: 'none' },
      }
    }
    const target = resolved.approval
    return {
      spokenReply: `好的，已为你拒绝 ${target.slot} 号：${sanitizeTextForVoiceBriefing(target.title, 32)}。`,
      action: {
        type: 'reject',
        hostId: target.hostId,
        agentId: target.agentId,
        code: target.code,
        slot: target.slot,
        optionIndex: computeDenyOptionIndex(target),
      },
    }
  }

  // 4. Approve pending approval (strict anti-mixup!)
  if (approvals.length > 0 && APPROVE_INTENT_RE.test(text)) {
    const resolved = resolveApprovalTarget(text, approvals, { focusedApproval, now })
    if (resolved.status === 'ambiguous') {
      return {
        spokenReply: buildAmbiguousApprovalsReply(approvals),
        action: { type: 'none', ambiguousApprovals: true },
      }
    }
    if (resolved.status === 'not_found') {
      return {
        spokenReply: `没有找到 ${resolved.slot} 号待审批，当前共有 ${approvals.length} 条。`,
        action: { type: 'none' },
      }
    }
    const target = resolved.approval
    return {
      spokenReply: target.riskLevel === 'L2'
        ? `检测到高危操作 ${target.slot} 号 ${sanitizeTextForVoiceBriefing(target.title, 32)}，正在启动语音确认码校验。`
        : `好的，已放行 ${target.slot} 号：${sanitizeTextForVoiceBriefing(target.title, 32)}。`,
      action: {
        type: 'approve',
        hostId: target.hostId,
        agentId: target.agentId,
        code: target.code,
        slot: target.slot,
        optionIndex: 1,
      },
    }
  }

  // 5. Stop running task
  if (/(停止|停一下|别跑了|中断|stop)/i.test(text) && runningTasks.length > 0) {
    const target = runningTasks.find(t => t.agentId === ctx.activeSessionId) || runningTasks[0]
    return {
      spokenReply: `好的，正在停止任务 ${target.title}。`,
      action: {
        type: 'stop_session',
        hostId: target.hostId,
        agentId: target.agentId,
      },
    }
  }

  // 6. Create new task
  const createMatch = /^(?:新建(?:一个)?(?:任务|对话)|开个新任务|帮我新开一个任务|create task)[：:，,\s]*(.+)$/i.exec(text)
  if (createMatch && createMatch[1].trim()) {
    const prompt = createMatch[1].trim()
    return {
      spokenReply: `好的，已在电脑上新建任务：${prompt.slice(0, 40)}。`,
      action: {
        type: 'create_task',
        hostId: defaultHostId,
        prompt,
      },
    }
  }

  // 7. Send follow-up prompt to active or latest task
  const followTarget = tasks.find(t => t.agentId === ctx.activeSessionId) || tasks[0]
  if (followTarget && /^(?:告诉它|跟它说|继续|追问|帮我|请帮我|让它)/i.test(text)) {
    const cleanPrompt = text.replace(/^(?:告诉它|跟它说|让它)[：:，,\s]*/, '').trim() || text
    return {
      spokenReply: `好的，已把你的指令发给 ${followTarget.title}。`,
      action: {
        type: 'send_prompt',
        hostId: followTarget.hostId,
        agentId: followTarget.agentId,
        prompt: cleanPrompt,
      },
    }
  }

  return {
    spokenReply: '当前处于系统原生免费模式，仅支持基础口令（查进度、放行1号、拒绝2号、选第几个、停止、新建任务）。如需自由自然语言对话，可在语音配置中接入任意 BYOK 大脑模型。',
    action: { type: 'none' },
  }
}

export class VoiceCopilotEngine {
  constructor({
    hub,
    vault,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = {}) {
    this.hub = hub
    this.vault = vault
    this.fetch = fetchImpl
    this.now = now
    this.pinStore = new VoicePinChallengeStore({ now })
    this.turnHistory = new Map() // voiceSessionId -> recent messages
    this.focusedApprovals = new Map() // voiceSessionId -> { hostId, code, slot, announcedAt }
  }

  setFocusedApproval(voiceSessionId = 'default', approval = null) {
    const sid = String(voiceSessionId || 'default')
    if (!approval || !approval.code) {
      this.focusedApprovals.delete(sid)
      return null
    }
    const entry = {
      hostId: String(approval.hostId || ''),
      code: String(approval.code || '').trim().toUpperCase(),
      slot: Number(approval.slot) || 1,
      announcedAt: this.now(),
    }
    this.focusedApprovals.set(sid, entry)
    while (this.focusedApprovals.size > 50) {
      const oldest = this.focusedApprovals.keys().next().value
      this.focusedApprovals.delete(oldest)
    }
    return entry
  }

  getFreshFocusedApproval(voiceSessionId = 'default', clientHint = null) {
    const sid = String(voiceSessionId || 'default')
    const now = this.now()
    const stored = this.focusedApprovals.get(sid) || null
    if (stored && now - stored.announcedAt <= FOCUS_APPROVAL_TTL_MS) {
      return stored
    }
    if (clientHint && clientHint.code) {
      const announcedAt = Number(clientHint.announcedAt) || now
      if (now - announcedAt <= FOCUS_APPROVAL_TTL_MS) {
        return {
          hostId: String(clientHint.hostId || ''),
          code: String(clientHint.code || '').trim().toUpperCase(),
          slot: Number(clientHint.slot) || 0,
          announcedAt,
        }
      }
    }
    return null
  }

  getActivePinChallenge(voiceSessionId = 'default') {
    return this.pinStore.getActive(voiceSessionId)
  }

  _resolveEffectiveProfile(profileId = '', stageOverrides = null) {
    const base = this.vault.getProfileById(profileId)
    if (!stageOverrides || typeof stageOverrides !== 'object') return base
    return {
      ...base,
      stt: { ...base.stt, ...(stageOverrides.stt || {}) },
      brain: { ...base.brain, ...(stageOverrides.brain || {}) },
      tts: { ...base.tts, ...(stageOverrides.tts || {}) },
    }
  }

  async runSingleStt(stageCfg, { audioBase64, mimeType = 'audio/wav', language = 'zh-CN', hotwords = [], credOverride = null } = {}) {
    const t0 = this.now()
    const provider = String(stageCfg?.provider || 'native').toLowerCase()
    if (provider === 'native') {
      return {
        ok: false,
        provider: 'native',
        error: '当前 STT 配置为系统原生浏览器识别，无需服务端转写',
        latencyMs: this.now() - t0,
      }
    }
    const cred = credOverride || this.vault.resolveCredential({ provider, credId: stageCfg?.credId })
    if (!cred) {
      return {
        ok: false,
        provider,
        error: `未找到可用的 ${provider} 密钥，请先在「密钥池 (BYOK)」中添加`,
        latencyMs: this.now() - t0,
      }
    }
    const cleanB64 = String(audioBase64 || '').replace(/^data:[^;]+;base64,/i, '').trim()
    if (!cleanB64) {
      return { ok: false, provider, error: '音频数据为空', latencyMs: this.now() - t0 }
    }

    if (provider === 'volcengine_asr') {
      const rawUrl = cred.baseUrl || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
      const resourceId = String(stageCfg?.model || cred.resourceId || 'volc.bigasr.auc_turbo').trim() || 'volc.bigasr.auc_turbo'
      const headers = {
        ...buildVolcHeaders(cred, resourceId, 'volcengine_asr'),
        'X-Api-Sequence': '-1',
      }
      const audioFormat = /mp4|m4a/i.test(mimeType)
        ? 'mp4'
        : /mp3|mpeg/i.test(mimeType)
          ? 'mp3'
          : /ogg/i.test(mimeType)
            ? 'ogg'
            : 'wav'
      const isAsyncStandardAuc =
        resourceId === 'volc.seedasr.auc'
        || resourceId === 'volc.bigasr.auc'
        || /\/auc\/bigmodel\/submit\/?$/i.test(rawUrl)

      const reqBody = {
        user: { uid: 'pocketagents-walk' },
        audio: isAsyncStandardAuc ? { data: cleanB64, format: audioFormat } : { data: cleanB64 },
        request: {
          model_name: 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          ...(hotwords.length > 0
            ? { corpus: { context: JSON.stringify({ hotwords: hotwords.slice(0, 30) }) } }
            : {}),
        },
      }

      if (isAsyncStandardAuc) {
        const submitUrl = /\/recognize\/flash\/?$/i.test(rawUrl)
          ? rawUrl.replace(/\/recognize\/flash\/?$/i, '/submit')
          : /\/submit\/?$/i.test(rawUrl)
            ? rawUrl
            : 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
        const queryUrl = submitUrl.replace(/\/submit\/?$/i, '/query')

        const subResp = await fetchWithTimeout(this.fetch, submitUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(reqBody),
        })
        const subCode = String(subResp.headers?.get?.('x-api-status-code') || '').trim()
        const subMsg = String(subResp.headers?.get?.('x-api-message') || '').trim()
        const subData = await subResp.json().catch(() => ({}))
        if (!subResp.ok || (subCode && subCode !== '20000000')) {
          const hdrCode = subData?.header?.code ? ` (${subData.header.code})` : ''
          const hdrMsg = subData?.header?.message ? `${subData.header.message}${hdrCode}` : ''
          return {
            ok: false,
            provider,
            model: resourceId,
            credId: cred.id,
            latencyMs: this.now() - t0,
            error: subMsg || hdrMsg || subData?.message || subData?.error || `Volcengine ASR submit HTTP ${subResp.status} (${subCode || 'err'})`,
          }
        }

        // Poll /query using the exact same X-Api-Request-Id (short utterances typically finish in 300-900ms)
        const queryHeaders = { ...headers }
        delete queryHeaders['X-Api-Sequence']
        const isMockFetch = this.fetch !== globalThis.fetch
        const maxPolls = 40
        for (let attempt = 0; attempt < maxPolls; attempt++) {
          const waitMs = isMockFetch ? 0 : (attempt < 3 ? 250 : 400)
          if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs))
          const qResp = await fetchWithTimeout(this.fetch, queryUrl, {
            method: 'POST',
            headers: queryHeaders,
            body: '{}',
          })
          const qCode = String(qResp.headers?.get?.('x-api-status-code') || '').trim()
          const qMsg = String(qResp.headers?.get?.('x-api-message') || '').trim()
          if (qCode === '20000001' || qCode === '20000002') {
            continue
          }
          const latencyMs = this.now() - t0
          if (qCode === '20000003') {
            return { ok: true, text: '', silence: true, provider, model: resourceId, credId: cred.id, latencyMs }
          }
          const qData = await qResp.json().catch(() => ({}))
          if (!qResp.ok || (qCode && qCode !== '20000000')) {
            const hdrCode = qData?.header?.code ? ` (${qData.header.code})` : ''
            const hdrMsg = qData?.header?.message ? `${qData.header.message}${hdrCode}` : ''
            return {
              ok: false,
              provider,
              model: resourceId,
              credId: cred.id,
              latencyMs,
              error: qMsg || hdrMsg || qData?.message || qData?.error || `Volcengine ASR query HTTP ${qResp.status} (${qCode || 'err'})`,
            }
          }
          const text = String(qData?.result?.text || qData?.text || '').trim()
          return { ok: true, text, silence: !text, provider, model: resourceId, credId: cred.id, latencyMs }
        }
        return {
          ok: false,
          provider,
          model: resourceId,
          credId: cred.id,
          latencyMs: this.now() - t0,
          error: '火山标准版语音识别查询超时，请稍后重试',
        }
      }

      const resp = await fetchWithTimeout(this.fetch, rawUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
      })
      const statusCode = String(resp.headers?.get?.('x-api-status-code') || '').trim()
      const statusMsg = String(resp.headers?.get?.('x-api-message') || '').trim()
      const latencyMs = this.now() - t0
      if (statusCode === '20000003') {
        return { ok: true, text: '', silence: true, provider, model: resourceId, credId: cred.id, latencyMs }
      }
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || (statusCode && statusCode !== '20000000')) {
        const hdrCode = data?.header?.code ? ` (${data.header.code})` : ''
        const hdrMsg = data?.header?.message ? `${data.header.message}${hdrCode}` : ''
        return {
          ok: false,
          provider,
          model: resourceId,
          credId: cred.id,
          latencyMs,
          error: statusMsg || hdrMsg || data?.message || data?.error || `Volcengine ASR HTTP ${resp.status} (${statusCode || 'err'})`,
        }
      }
      const text = String(data?.result?.text || data?.text || '').trim()
      return { ok: true, text, silence: !text, provider, model: resourceId, credId: cred.id, latencyMs }
    }

    if (provider === 'gemini') {
      const model = stageCfg?.model || cred.defaultModel || 'gemini-2.5-flash'
      const base = cred.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      const thinkingConfig = buildGeminiThinkingConfig(model, stageCfg?.thinkingLevel || 'low', { isAudioStt: true })
      const hotwordHint = hotwords.length > 0 ? `参考专有名词：${hotwords.slice(0, 20).join('、')}。` : ''
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `请精准逐字转写这段语音（支持中英混说和数字确认码）。只输出转写文本本身，不要添加任何解释；如果只有静音或环境杂音，返回空字符串。${hotwordHint}`,
              },
              {
                inlineData: {
                  mimeType: mimeType || 'audio/wav',
                  data: cleanB64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }
      const resp = await fetchWithTimeout(this.fetch, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cred.apiKey,
        },
        body: JSON.stringify(payload),
      })
      const latencyMs = this.now() - t0
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        return {
          ok: false,
          provider,
          model,
          credId: cred.id,
          latencyMs,
          error: data?.error?.message || `Gemini STT HTTP ${resp.status}`,
        }
      }
      const parts = data?.candidates?.[0]?.content?.parts || []
      const text = parts
        .filter(p => typeof p?.text === 'string' && !p.thought)
        .map(p => p.text)
        .join('')
        .trim()
      return { ok: true, text, silence: !text, provider, model, credId: cred.id, latencyMs }
    }

    if (provider === 'openai_compat') {
      const model = stageCfg?.model || cred.defaultModel || 'whisper-1'
      const base = cred.baseUrl || 'https://api.openai.com/v1'
      const url = `${base}/audio/transcriptions`
      const audioBuf = Buffer.from(cleanB64, 'base64')
      const ext = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('webm') ? 'webm' : 'wav'
      const form = new FormData()
      form.append('file', new Blob([audioBuf], { type: mimeType || 'audio/wav' }), `speech.${ext}`)
      form.append('model', model)
      if (language) form.append('language', String(language).split('-')[0])
      if (hotwords.length > 0) form.append('prompt', hotwords.slice(0, 20).join(', '))
      const resp = await fetchWithTimeout(this.fetch, url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.apiKey}` },
        body: form,
      })
      const latencyMs = this.now() - t0
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        return {
          ok: false,
          provider,
          model,
          credId: cred.id,
          latencyMs,
          error: data?.error?.message || data?.message || `OpenAI-compat STT HTTP ${resp.status}`,
        }
      }
      const text = String(data?.text || '').trim()
      return { ok: true, text, silence: !text, provider, model, credId: cred.id, latencyMs }
    }

    return { ok: false, provider, error: `不支持的 STT 服务商：${provider}`, latencyMs: this.now() - t0 }
  }

  async runStt({ audioBase64, mimeType = 'audio/wav', profileId = '', stageOverride = null, language = '' } = {}) {
    const profile = this._resolveEffectiveProfile(profileId, stageOverride ? { stt: stageOverride } : null)
    const ctx = buildDynamicVoiceContext(this.hub)
    const chain = [profile.stt, ...(Array.isArray(profile.stt?.fallbackChain) ? profile.stt.fallbackChain : [])]
    const attempts = []

    for (const step of chain) {
      if (!step || step.provider === 'native') continue
      try {
        const res = await this.runSingleStt(step, {
          audioBase64,
          mimeType,
          language: language || step.language || 'zh-CN',
          hotwords: ctx.hotwords,
        })
        attempts.push({
          provider: res.provider,
          model: res.model || step.model || '',
          ok: res.ok,
          latencyMs: res.latencyMs,
          ...(res.error ? { error: res.error } : {}),
        })
        if (res.ok) {
          return { ...res, attempts }
        }
      } catch (err) {
        attempts.push({
          provider: step.provider,
          model: step.model || '',
          ok: false,
          latencyMs: 0,
          error: err?.name === 'AbortError' ? '请求超时' : (err?.message || String(err)),
        })
      }
    }

    return {
      ok: false,
      provider: profile.stt?.provider || 'native',
      error: attempts[attempts.length - 1]?.error || '未配置可用的云端 STT 引擎',
      attempts,
    }
  }

  async _callBrainModel(stageCfg, { systemPrompt, history = [], userText = '', credOverride = null } = {}) {
    const t0 = this.now()
    const provider = String(stageCfg?.provider || 'native').toLowerCase()
    const cred = credOverride || this.vault.resolveCredential({ provider, credId: stageCfg?.credId })
    if (!cred) {
      return {
        ok: false,
        provider,
        error: `未找到可用的 ${provider} 大脑密钥，请先在「密钥池 (BYOK)」中添加`,
        latencyMs: this.now() - t0,
      }
    }

    if (provider === 'gemini') {
      const model = stageCfg?.model || cred.defaultModel || 'gemini-2.5-flash'
      const base = cred.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      const thinkingConfig = buildGeminiThinkingConfig(model, stageCfg?.thinkingLevel || 'off', { isAudioStt: false })
      const contents = [
        ...history.slice(-6).map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: String(m.text || '') }],
        })),
        { role: 'user', parts: [{ text: userText }] },
      ]
      const payload = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: Number(stageCfg?.maxTokens) || 320,
          responseMimeType: 'application/json',
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }
      const resp = await fetchWithTimeout(this.fetch, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cred.apiKey,
        },
        body: JSON.stringify(payload),
      })
      const latencyMs = this.now() - t0
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        return {
          ok: false,
          provider,
          model,
          credId: cred.id,
          latencyMs,
          error: data?.error?.message || `Gemini Brain HTTP ${resp.status}`,
        }
      }
      const parts = data?.candidates?.[0]?.content?.parts || []
      const rawText = parts
        .filter(p => typeof p?.text === 'string' && !p.thought)
        .map(p => p.text)
        .join('')
        .trim()
      return { ok: true, rawText, provider, model, credId: cred.id, latencyMs }
    }

    if (provider === 'openai_compat') {
      const model = stageCfg?.model || cred.defaultModel || 'gpt-4o-mini'
      const base = normalizeOpenAiCompatBaseUrl(cred.baseUrl) || 'https://api.openai.com/v1'
      const url = `${base}/chat/completions`
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6).map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.text || ''),
        })),
        { role: 'user', content: userText },
      ]
      const wantDisableThinking =
        String(stageCfg?.thinkingLevel || 'off').toLowerCase() === 'off' &&
        /ark\.|volces|deepseek|doubao|seed/i.test(`${base} ${model}`)

      const baseBody = {
        model,
        messages,
        temperature: 0.2,
        max_tokens: Number(stageCfg?.maxTokens) || 320,
      }
      const firstBody = wantDisableThinking ? { ...baseBody, thinking: { type: 'disabled' } } : baseBody
      let resp
      try {
        resp = await fetchWithTimeout(this.fetch, url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cred.apiKey}`,
          },
          body: JSON.stringify(firstBody),
        })
      } catch (err) {
        return {
          ok: false,
          provider,
          model,
          credId: cred.id,
          latencyMs: this.now() - t0,
          error: formatFetchError(err),
        }
      }
      let data = await resp.json().catch(() => ({}))
      // Graceful retry without `thinking` field if an OpenAI-compat gateway rejects unknown params
      if (!resp.ok && (resp.status === 400 || resp.status === 422 || resp.status === 500) && wantDisableThinking) {
        try {
          resp = await fetchWithTimeout(this.fetch, url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${cred.apiKey}`,
            },
            body: JSON.stringify(baseBody),
          })
          data = await resp.json().catch(() => ({}))
        } catch (err) {
          return {
            ok: false,
            provider,
            model,
            credId: cred.id,
            latencyMs: this.now() - t0,
            error: formatFetchError(err),
          }
        }
      }
      const latencyMs = this.now() - t0
      if (!resp.ok) {
        return {
          ok: false,
          provider,
          model,
          credId: cred.id,
          latencyMs,
          error: data?.error?.message || data?.message || `OpenAI-compat Brain HTTP ${resp.status}`,
        }
      }
      const rawText = String(data?.choices?.[0]?.message?.content || '').trim()
      return { ok: true, rawText, provider, model, credId: cred.id, latencyMs }
    }

    return { ok: false, provider, error: `不支持的大脑服务商：${provider}`, latencyMs: this.now() - t0 }
  }

  _executeValidatedAction(action, ctx, { voiceSessionId = 'default', dryRun = false, l2Policy = 'pin', focusedApproval = null } = {}) {
    const type = String(action?.type || 'none').trim()
    const defaultHostId = ctx.activeHostId || ctx.hosts?.[0]?.hostId || ''
    const hostId = String(action?.hostId || defaultHostId).trim()

    if (!type || type === 'none' || type === 'query_status' || type === 'inspect_session') {
      return { executed: false, type: type || 'none', dryRun }
    }

    if (type === 'approve' || type === 'reject' || type === 'answer_question') {
      const reqCode = String(action?.code || '').trim().toUpperCase()
      const reqSlot = Number(action?.slot) || 0
      const reqHostId = String(action?.hostId || '').trim()
      const scopedApprovals = reqHostId
        ? ctx.pendingApprovals.filter(a => a.hostId === reqHostId)
        : ctx.pendingApprovals
      let approval = null
      if (reqCode) {
        approval = scopedApprovals.find(a => a.code === reqCode) || null
      } else if (reqSlot > 0) {
        approval = scopedApprovals.find(a => Number(a.slot) === reqSlot) || scopedApprovals[reqSlot - 1] || null
      } else if (action?.agentId) {
        const byAgent = scopedApprovals.filter(a => a.agentId === action.agentId)
        if (byAgent.length === 1) approval = byAgent[0]
      } else if (scopedApprovals.length === 1) {
        approval = scopedApprovals[0]
      } else if (focusedApproval?.code) {
        approval = scopedApprovals.find(
          a => a.code === String(focusedApproval.code).toUpperCase()
            && (!focusedApproval.hostId || a.hostId === focusedApproval.hostId),
        ) || null
      }

      if (!approval && scopedApprovals.length > 1) {
        return {
          executed: false,
          ambiguousApprovals: true,
          type: 'none',
          dryRun,
          overrideReply: buildAmbiguousApprovalsReply(scopedApprovals),
        }
      }

      if (!approval) {
        return {
          executed: false,
          type,
          dryRun,
          overrideReply: '当前没有匹配到待处理的审批单，可能已经处理完了。',
        }
      }

      // Prevent L2 bypass via `answer_question` on non-question command approvals
      if (type === 'answer_question' && approval.kind !== 'question') {
        return {
          executed: false,
          blockedByPolicy: 'invalid_question_target',
          riskLevel: approval.riskLevel,
          type,
          dryRun,
          approval,
          overrideReply: '该待审批项是命令执行确认而非多选题，请明确说明批准或拒绝。',
        }
      }

      if (type !== 'reject' && approval.riskLevel === 'L2') {
        if (l2Policy === 'screen_only' || this.pinStore.isApprovalLocked(approval.hostId, approval.code)) {
          const isLocked = this.pinStore.isApprovalLocked(approval.hostId, approval.code)
          return {
            executed: false,
            blockedByPolicy: isLocked ? 'pin_locked' : 'screen_only',
            riskLevel: 'L2',
            type,
            dryRun,
            approval,
            overrideReply: isLocked
              ? '该高危审批确认码已连续输错被锁定，请改为在手机屏幕上手动点按确认。'
              : `这是高危操作（${approval.riskReason}），当前安全策略禁止语音放行，请在手机屏幕上手动点按确认。`,
          }
        }
        const challenge = this.pinStore.issue(voiceSessionId, {
          hostId: approval.hostId,
          code: approval.code,
          agentId: approval.agentId,
          summary: approval.title || approval.command,
          reason: approval.riskReason,
        })
        return {
          executed: false,
          requiresPin: true,
          riskLevel: 'L2',
          type,
          dryRun,
          approval,
          pinChallenge: challenge,
          overrideReply: `高危操作预警：${approval.slot}号 ${approval.title}。请念出确认码 ${formatPinForSpeech(challenge.pin)} 放行，或说拒绝。`,
        }
      }

      const denyIdx = computeDenyOptionIndex(approval)
      const cmdPayload =
        type === 'reject'
          ? { type: 'deny', code: approval.code, agentId: approval.agentId, optionIndex: Number(action?.optionIndex) || denyIdx }
          : type === 'answer_question'
            ? {
                type: 'approve',
                code: approval.code,
                agentId: approval.agentId,
                optionIndex: Number(action?.optionIndex) || 1,
                ...(Array.isArray(action?.answers) ? { answers: action.answers } : {}),
              }
            : { type: 'approve', code: approval.code, agentId: approval.agentId, optionIndex: Number(action?.optionIndex) || 1 }

      if (dryRun) {
        return { executed: false, dryRun: true, type, hostId: approval.hostId, commandPayload: cmdPayload, approval }
      }
      const outcome = this.hub.queueCommand(approval.hostId, cmdPayload)
      return {
        executed: Boolean(outcome?.ok),
        dryRun: false,
        type,
        hostId: approval.hostId,
        commandPayload: cmdPayload,
        outcome,
        approval,
      }
    }

    if (type === 'send_prompt') {
      const prompt = String(action?.prompt || action?.text || '').trim()
      const task =
        ctx.tasks.find(t => action?.agentId && t.agentId === action.agentId) ||
        ctx.tasks.find(t => ctx.activeSessionId && t.agentId === ctx.activeSessionId) ||
        ctx.tasks[0]
      if (!prompt || !task) {
        return { executed: false, dryRun, type, overrideReply: '未找到要追问的目标对话或内容为空。' }
      }
      const cmdPayload = { type: 'prompt', agentId: task.agentId, text: prompt }
      if (dryRun) {
        return { executed: false, dryRun: true, type, hostId: task.hostId, commandPayload: cmdPayload }
      }
      const outcome = this.hub.queueCommand(task.hostId, cmdPayload)
      return { executed: Boolean(outcome?.ok), dryRun: false, type, hostId: task.hostId, commandPayload: cmdPayload, outcome }
    }

    if (type === 'create_task') {
      const prompt = String(action?.prompt || action?.text || '').trim()
      const knownHost = (ctx.hosts || []).find(h => h.hostId === hostId)
      if (!prompt || !hostId || !knownHost) {
        return { executed: false, dryRun, type, overrideReply: '没有可用电脑或任务描述为空，未能创建新任务。' }
      }
      const cmdPayload = {
        type: 'new_session',
        prompt,
        ...(action?.cwd ? { cwd: String(action.cwd) } : {}),
        ...(action?.harness ? { harness: String(action.harness) } : {}),
      }
      if (dryRun) {
        return { executed: false, dryRun: true, type, hostId, commandPayload: cmdPayload }
      }
      const outcome = this.hub.queueCommand(hostId, cmdPayload)
      return { executed: Boolean(outcome?.ok), dryRun: false, type, hostId, commandPayload: cmdPayload, outcome }
    }

    if (type === 'stop_session') {
      const task =
        ctx.tasks.find(t => action?.agentId && t.agentId === action.agentId) ||
        ctx.tasks.find(t => t.status === 'running')
      if (!task) {
        return { executed: false, dryRun, type, overrideReply: '当前没有正在运行的任务需要停止。' }
      }
      const cmdPayload = { type: 'stop', agentId: task.agentId }
      if (dryRun) {
        return { executed: false, dryRun: true, type, hostId: task.hostId, commandPayload: cmdPayload }
      }
      const outcome = this.hub.queueCommand(task.hostId, cmdPayload)
      return { executed: Boolean(outcome?.ok), dryRun: false, type, hostId: task.hostId, commandPayload: cmdPayload, outcome }
    }

    return { executed: false, dryRun, type: 'none' }
  }

  async runBrainTurn({
    text = '',
    voiceSessionId = 'default',
    activeHostId = '',
    activeSessionId = '',
    focusedApproval = null,
    profileId = '',
    stageOverride = null,
    dryRun = false,
  } = {}) {
    const t0 = this.now()
    const userText = String(text || '').trim()
    const ctx = buildDynamicVoiceContext(this.hub, { activeHostId, activeSessionId })
    const activeFocus = this.getFreshFocusedApproval(voiceSessionId, focusedApproval)
    const prefs = this.vault.state.prefs
    const profile = this._resolveEffectiveProfile(profileId, stageOverride ? { brain: stageOverride } : null)

    // 1. 1ms Deterministic Hub-Side L2 PIN Fast-Path (Zero LLM hallucination, zero latency!)
    const pinVerdict = this.pinStore.verify(voiceSessionId, userText)
    if (pinVerdict.status === 'matched') {
      const ch = pinVerdict.challenge
      if (prefs.l2Policy === 'screen_only') {
        const spokenReply = '当前安全策略已切换为仅限手机屏幕确认，请在屏幕手动点按。'
        return {
          ok: true,
          fastPath: 'l2_pin_policy_blocked',
          provider: 'hub_pin_guard',
          model: 'deterministic-1ms',
          latencyMs: this.now() - t0,
          userText,
          spokenReply,
          spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
          action: { type: 'none' },
          execution: { executed: false, dryRun, blockedByPolicy: 'screen_only', riskLevel: 'L2' },
          pinChallenge: null,
        }
      }
      const stillPending = ctx.pendingApprovals.some(a => a.hostId === ch.hostId && a.code === ch.code)
      if (!stillPending && !dryRun) {
        const spokenReply = '该审批已处理或已过期，无需重复放行。'
        return {
          ok: true,
          fastPath: 'l2_pin_stale',
          provider: 'hub_pin_guard',
          model: 'deterministic-1ms',
          latencyMs: this.now() - t0,
          userText,
          spokenReply,
          spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
          action: { type: 'none' },
          execution: { executed: false, dryRun, type: 'none' },
          pinChallenge: null,
        }
      }
      const cmdPayload = { type: 'approve', code: ch.code, agentId: ch.agentId, optionIndex: 1 }
      const outcome = dryRun ? null : this.hub.queueCommand(ch.hostId, cmdPayload)
      const spokenReply = dryRun
        ? `确认码 ${formatPinForSpeech(ch.pin)} 验证通过（试跑模式，未真实下发放行指令）。`
        : `确认码核验通过，已放行 ${ch.summary || ch.code}。`
      return {
        ok: true,
        fastPath: 'l2_pin_matched',
        provider: 'hub_pin_guard',
        model: 'deterministic-1ms',
        latencyMs: this.now() - t0,
        userText,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        action: { type: 'approve', hostId: ch.hostId, agentId: ch.agentId, code: ch.code, pinVerified: true },
        execution: {
          executed: !dryRun && Boolean(outcome?.ok),
          dryRun,
          type: 'approve',
          hostId: ch.hostId,
          commandPayload: cmdPayload,
          outcome,
        },
        pinChallenge: null,
      }
    }
    if (pinVerdict.status === 'rejected') {
      const ch = pinVerdict.challenge
      const cmdPayload = { type: 'deny', code: ch.code, agentId: ch.agentId, optionIndex: 4 }
      const outcome = dryRun ? null : this.hub.queueCommand(ch.hostId, cmdPayload)
      const spokenReply = dryRun
        ? `已取消高危放行（试跑模式，未真实拒绝）。`
        : `已拒绝高危操作 ${ch.summary || ch.code}。`
      return {
        ok: true,
        fastPath: 'l2_pin_rejected',
        provider: 'hub_pin_guard',
        model: 'deterministic-1ms',
        latencyMs: this.now() - t0,
        userText,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        action: { type: 'reject', hostId: ch.hostId, agentId: ch.agentId, code: ch.code },
        execution: {
          executed: !dryRun && Boolean(outcome?.ok),
          dryRun,
          type: 'reject',
          hostId: ch.hostId,
          commandPayload: cmdPayload,
          outcome,
        },
        pinChallenge: null,
      }
    }
    if (pinVerdict.status === 'mismatch') {
      const ch = pinVerdict.challenge
      const spokenReply = `确认码不对，我听到的是 ${pinVerdict.extractedPin}。请念出 ${formatPinForSpeech(ch.pin)}，还有 ${pinVerdict.remainingAttempts} 次机会。`
      return {
        ok: true,
        fastPath: 'l2_pin_mismatch',
        provider: 'hub_pin_guard',
        model: 'deterministic-1ms',
        latencyMs: this.now() - t0,
        userText,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        action: { type: 'none' },
        execution: { executed: false, dryRun, requiresPin: true, riskLevel: 'L2' },
        pinChallenge: ch,
      }
    }
    if (pinVerdict.status === 'missing_pin') {
      const ch = pinVerdict.challenge
      const spokenReply = `这是高危操作，不能直接说放行，请念出确认码 ${formatPinForSpeech(ch.pin)}，或说拒绝。`
      return {
        ok: true,
        fastPath: 'l2_pin_missing',
        provider: 'hub_pin_guard',
        model: 'deterministic-1ms',
        latencyMs: this.now() - t0,
        userText,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        action: { type: 'none' },
        execution: { executed: false, dryRun, requiresPin: true, riskLevel: 'L2' },
        pinChallenge: ch,
      }
    }
    if (pinVerdict.status === 'locked') {
      const spokenReply = '确认码连续 3 次错误，本次高危语音放行已锁定取消，请改为在手机屏幕确认。'
      return {
        ok: true,
        fastPath: 'l2_pin_locked',
        provider: 'hub_pin_guard',
        model: 'deterministic-1ms',
        latencyMs: this.now() - t0,
        userText,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        action: { type: 'none' },
        execution: { executed: false, dryRun, blockedByPolicy: 'pin_locked', riskLevel: 'L2' },
        pinChallenge: null,
      }
    }
    if (pinVerdict.status === 'expired' && extractSpokenPin(userText)) {
      const spokenReply = '刚才的 3 位确认码已超时失效，如需继续放行请再说一次批准该操作。'
      return {
        ok: true,
        fastPath: 'l2_pin_expired',
        provider: 'hub_pin_guard',
        model: 'deterministic-1ms',
        latencyMs: this.now() - t0,
        userText,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        action: { type: 'none' },
        execution: { executed: false, dryRun, blockedByPolicy: 'pin_expired', riskLevel: 'L2' },
        pinChallenge: null,
      }
    }

    // 2. Native rule-router or BYOK LLM Brain
    let parsed = null
    let provider = profile.brain?.provider || 'native'
    let model = profile.brain?.model || 'rule-router'
    let brainLatencyMs = 0

    if (provider === 'native') {
      parsed = runNativeRuleRouter(userText, {
        ...ctx,
        focusedApproval: activeFocus,
        now: this.now(),
      })
      brainLatencyMs = this.now() - t0
    } else {
      const history = this.turnHistory.get(voiceSessionId) || []
      const systemPrompt = buildVoiceSystemPrompt(ctx, prefs.l2Policy, activeFocus)
      const llmRes = await this._callBrainModel(profile.brain, { systemPrompt, history, userText })
      brainLatencyMs = llmRes.latencyMs
      if (!llmRes.ok) {
        return {
          ok: false,
          provider: llmRes.provider,
          model: llmRes.model || model,
          latencyMs: brainLatencyMs,
          error: llmRes.error,
        }
      }
      provider = llmRes.provider
      model = llmRes.model
      parsed = extractJsonObject(llmRes.rawText) || {
        spokenReply: llmRes.rawText.slice(0, 220) || '收到。',
        action: { type: 'none' },
      }
    }

    const action = parsed?.action && typeof parsed.action === 'object' ? parsed.action : { type: 'none' }
    const execution = this._executeValidatedAction(action, ctx, {
      voiceSessionId,
      dryRun,
      l2Policy: prefs.l2Policy,
      focusedApproval: activeFocus,
    })

    let spokenReply = String(execution.overrideReply || parsed?.spokenReply || '已处理。').trim()
    let nextFocusedApproval = null

    if (execution.executed && execution.approval && ['approve', 'reject', 'answer_question'].includes(execution.type)) {
      const handledCode = execution.approval.code
      const handledHost = execution.approval.hostId
      const remaining = ctx.pendingApprovals.filter(a => !(a.code === handledCode && a.hostId === handledHost))
      if (remaining.length > 0) {
        const nextApp = remaining[0]
        nextFocusedApproval = this.setFocusedApproval(voiceSessionId, nextApp)
        spokenReply = `${spokenReply} 还有下一条：${formatApprovalBriefingSpeech(nextApp, { totalCount: remaining.length })}`
      } else {
        this.setFocusedApproval(voiceSessionId, null)
      }
    } else if (execution.requiresPin && execution.approval) {
      nextFocusedApproval = this.setFocusedApproval(voiceSessionId, execution.approval)
    }

    const expectReply = Boolean(
      execution.requiresPin
      || execution.ambiguousApprovals
      || action?.ambiguousApprovals
      || nextFocusedApproval,
    )

    const historyList = this.turnHistory.get(voiceSessionId) || []
    historyList.push({ role: 'user', text: userText }, { role: 'assistant', text: spokenReply })
    if (historyList.length > 12) historyList.splice(0, historyList.length - 12)
    this.turnHistory.set(voiceSessionId, historyList)
    while (this.turnHistory.size > 30) {
      const oldest = this.turnHistory.keys().next().value
      this.turnHistory.delete(oldest)
    }

    return {
      ok: true,
      provider,
      model,
      latencyMs: brainLatencyMs,
      userText,
      spokenReply,
      spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
      action,
      execution,
      expectReply,
      nextFocusedApproval,
      pinChallenge: execution.pinChallenge || this.pinStore.getActive(voiceSessionId),
      contextSummary: {
        pendingApprovals: ctx.pendingApprovals.length,
        runningTasks: ctx.tasks.filter(t => t.status === 'running').length,
      },
    }
  }

  /**
   * Build a concise, ear-friendly proactive spoken briefing when a new approval,
   * multiple-choice question, or task completion arrives in Walk Mode.
   * Also locks the announced approval into `focusedApprovals` for 45s so immediate
   * hands-free voice replies ("放行" / "选第二个") unambiguously target this exact item.
   */
  async buildProactiveBriefing({
    kind = 'approval',
    hostId = '',
    code = '',
    agentId = '',
    profileId = '',
    voiceSessionId = 'default',
    detailLevel = '',
  } = {}) {
    const t0 = this.now()
    const ctx = buildDynamicVoiceContext(this.hub, { activeHostId: hostId, activeSessionId: agentId })

    if (kind === 'approval') {
      const cleanCode = String(code || '').trim().toUpperCase()
      const approval = (cleanCode && ctx.pendingApprovals.find(a => a.code === cleanCode && (!hostId || a.hostId === hostId)))
        || (agentId && ctx.pendingApprovals.find(a => a.agentId === agentId && (!hostId || a.hostId === hostId)))
        || ctx.pendingApprovals[0]
        || null
      if (!approval) {
        return { ok: false, error: '当前没有待播报的审批项', latencyMs: this.now() - t0 }
      }
      const focused = this.setFocusedApproval(voiceSessionId, approval)
      const spokenReply = formatApprovalBriefingSpeech(approval, { totalCount: ctx.pendingApprovals.length })
      return {
        ok: true,
        kind: 'approval',
        latencyMs: this.now() - t0,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        focusedApproval: focused,
        approval: {
          slot: approval.slot,
          hostId: approval.hostId,
          hostName: approval.hostName,
          code: approval.code,
          sessionTitle: approval.sessionTitle,
          title: approval.title,
          kind: approval.kind,
          riskLevel: approval.riskLevel,
        },
        expectReply: true,
      }
    }

    if (kind === 'completed') {
      const task = ctx.tasks.find(t => t.agentId === agentId && (!hostId || t.hostId === hostId))
        || ctx.tasks.find(t => t.agentId === agentId)
        || null
      if (!task) {
        return { ok: false, error: '未找到对应的已完成任务', latencyMs: this.now() - t0 }
      }
      const effectiveDetail = ['detailed', 'verbatim', 'concise'].includes(String(detailLevel || ''))
        ? String(detailLevel)
        : (this.vault.state.prefs?.briefingDetail || 'detailed')
      const rawConclusion = String(task.fullOutput || task.lastOutput || '').trim()
      const maxFallbackChars = effectiveDetail === 'verbatim' ? 620 : effectiveDetail === 'concise' ? 110 : 360
      const fallbackClean = sanitizeTextForVoiceBriefing(rawConclusion, maxFallbackChars)
      let summaryText = fallbackClean
      let summarizedByBrain = false

      const profile = this._resolveEffectiveProfile(profileId)
      const shouldUseBrain =
        effectiveDetail !== 'verbatim'
        && rawConclusion.length > (effectiveDetail === 'concise' ? 50 : 120)
        && Boolean(profile.brain?.provider && profile.brain.provider !== 'native')

      if (shouldUseBrain) {
        try {
          const isConcise = effectiveDetail === 'concise'
          const sumSystemPrompt = isConcise
            ? [
                '你是 PocketAgents 语音播报编辑。请把 AI 刚完成的工作结论，压缩成 1 到 2 句给耳朵听的自然口语中文摘要（总字数不超过 80 字）。',
                '要求：说清完成了什么、结果成没成；如果 AI 最后给出了选项或需要用户拍板，简短说出选项要点。',
                '严禁输出 JSON、Markdown、文件路径、代码、哈希或括号备注，只输出最终要念出来的纯中文句子。',
              ].join('\n')
            : [
                '你是 PocketAgents 语音播报助手。请把 AI 刚完成的回复整理成自然流畅、适合耳朵听的中文口语播报（约 140 到 280 字）。',
                '要求：',
                '1. 不要过度压缩成一句空话，务必讲清具体完成了哪些事、查出的关键原因/数据/改动点；',
                '2. 如果 AI 给出了多个方案、对比结论或需要用户拍板/下一步指令，完整讲清核心要点和选项；',
                '3. 去掉 Markdown 符号、代码块、长文件路径、哈希和网址，只输出直接朗读的纯中文口语段落。',
              ].join('\n')
          // Preserve both beginning and tail of long replies so final conclusions & options are never lost
          const brainInput = rawConclusion.length > 2400
            ? `${rawConclusion.slice(0, 1450)}\n……\n${rawConclusion.slice(-900)}`
            : rawConclusion
          const llmRes = await this._callBrainModel(
            { ...profile.brain, thinkingLevel: 'off', maxTokens: isConcise ? 160 : 480 },
            {
              systemPrompt: sumSystemPrompt,
              history: [],
              userText: `电脑：${task.hostName}\n会话：${task.title}\n最新回复：\n${brainInput}`,
            },
          )
          if (llmRes.ok && llmRes.rawText) {
            const cleaned = sanitizeTextForVoiceBriefing(llmRes.rawText, isConcise ? 120 : 380)
            if (cleaned) {
              summaryText = cleaned
              summarizedByBrain = true
            }
          }
        } catch {
          // Graceful fallback to deterministic summary
        }
      }

      const spokenReply = summaryText
        ? `${task.hostName}的「${task.title}」已完成：${summaryText}`
        : `${task.hostName}的「${task.title}」已完成。`
      const expectsDecision = /[？?]|要不要|是否需要|需要我|请选择|方案\s*[12一二AB]|回复|告诉我/i.test(summaryText)
      return {
        ok: true,
        kind: 'completed',
        detailLevel: effectiveDetail,
        summarizedByBrain,
        latencyMs: this.now() - t0,
        spokenReply,
        spokenChunks: splitIntoProgressiveTtsChunks(spokenReply),
        focusedSession: {
          hostId: task.hostId,
          hostName: task.hostName,
          agentId: task.agentId,
          title: task.title,
        },
        expectReply: expectsDecision,
      }
    }

    return { ok: false, error: `不支持的播报类型：${kind}`, latencyMs: this.now() - t0 }
  }

  async runTts({
    text = '',
    profileId = '',
    stageOverride = null,
    voice = '',
    speed = null,
    credOverride = null,
    outputFormat = 'auto',
    sampleRate = 24000,
  } = {}) {
    const t0 = this.now()
    const cleanText = String(text || '').trim()
    if (!cleanText) {
      return { ok: false, error: '合成文本为空', latencyMs: 0 }
    }
    const wantPcm16 = String(outputFormat || 'auto').toLowerCase() === 'pcm16'
    const targetSampleRate = wantPcm16
      ? Math.max(8000, Math.min(24000, Math.round(Number(sampleRate) || 16000)))
      : 24000
    const profile = this._resolveEffectiveProfile(profileId, stageOverride ? { tts: stageOverride } : null)
    const stageCfg = profile.tts || {}
    const provider = String(stageCfg.provider || 'native').toLowerCase()

    // Skip pure-punctuation / symbol-only chunks cleanly so cloud TTS (e.g. Volcengine Seed-TTS 3.0)
    // never returns 502 "no audio" mid-stream and causes awkward gaps or fallbacks.
    if (!/[\p{L}\p{N}]/u.test(cleanText)) {
      return {
        ok: true,
        skippedEmpty: true,
        provider,
        audioBase64: '',
        mimeType: 'audio/mpeg',
        byteLength: 0,
        latencyMs: 0,
      }
    }

    if (provider === 'native') {
      return {
        ok: true,
        provider: 'native',
        model: 'browser-speech-synthesis',
        useBrowserSpeech: true,
        text: cleanText,
        latencyMs: this.now() - t0,
      }
    }

    const cred = credOverride || this.vault.resolveCredential({ provider, credId: stageCfg.credId })
    if (!cred) {
      return {
        ok: false,
        provider,
        error: `未找到可用的 ${provider} 语音合成密钥，请先在「密钥池 (BYOK)」中添加`,
        latencyMs: this.now() - t0,
      }
    }

    const effectiveSpeed = Number(speed || stageCfg.speed || this.vault.state.prefs.speechRate || 1.0)

    if (provider === 'volcengine_tts') {
      const resourceId = String(stageCfg.model || cred.resourceId || cred.defaultModel || 'seed-tts-2.0').trim() || 'seed-tts-2.0'
      const isSeedTts3 =
        /3\.0/i.test(resourceId)
        || /voice\.cn-beijing\.volces\.com|\/text-to-speech/i.test(cred.baseUrl || '')

      if (isSeedTts3) {
        if (!cred.apiKey) {
          return {
            ok: false,
            provider,
            model: resourceId,
            credId: cred.id,
            latencyMs: this.now() - t0,
            error: '火山「语音合成 3.0」仅支持 API Key（X-Api-Key）鉴权，请填新版控制台的 API Key',
          }
        }
        const modelId3 = /^seed-tts-3\.0$/i.test(resourceId) ? 'doubao-seed-tts-3.0' : (resourceId || 'doubao-seed-tts-3.0')
        const speaker3 = String(voice || stageCfg.voice || cred.defaultVoice || 'multi_female_tuanzi_v3_uranus_bigtts').trim() || 'multi_female_tuanzi_v3_uranus_bigtts'
        const rawBase3 = String(cred.baseUrl || '').trim().replace(/\/+$/, '')
        let url3 = ''
        if (rawBase3 && /\/streaming$/i.test(rawBase3)) {
          url3 = rawBase3.replace(/\{voice_id\}/gi, encodeURIComponent(speaker3))
        } else if (rawBase3 && /\/text-to-speech$/i.test(rawBase3)) {
          url3 = `${rawBase3}/${encodeURIComponent(speaker3)}/streaming`
        } else if (rawBase3 && !/openspeech\.bytedance\.com/i.test(rawBase3)) {
          url3 = `${rawBase3}/api/v3/text-to-speech/${encodeURIComponent(speaker3)}/streaming`
        } else {
          url3 = `https://voice.cn-beijing.volces.com/api/v3/text-to-speech/${encodeURIComponent(speaker3)}/streaming`
        }
        const volc3Rate = wantPcm16
          ? (targetSampleRate <= 8000 ? 8000 : targetSampleRate <= 16000 ? 16000 : 24000)
          : 24000
        const reqBody3 = {
          text: cleanText,
          model_id: modelId3,
          enable_subtitle: false,
          output_format: {
            format: wantPcm16 ? 'pcm' : 'mp3',
            sample_rate: volc3Rate,
          },
          ...(effectiveSpeed !== 1.0 ? { voice_settings: { speed: effectiveSpeed } } : {}),
        }
        let lastSeedTts3Err = null
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 350))
          }
          let resp3
          try {
            resp3 = await fetchWithTimeout(this.fetch, url3, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Api-Key': cred.apiKey,
                'X-Request-Id': randomUUID(),
              },
              body: JSON.stringify(reqBody3),
            })
          } catch (err) {
            lastSeedTts3Err = {
              ok: false,
              provider,
              model: modelId3,
              voice: speaker3,
              credId: cred.id,
              latencyMs: this.now() - t0,
              error: this._explainVoiceError(formatFetchError(err), 'volcengine_tts_v3'),
            }
            continue
          }
          const latencyMs = this.now() - t0
          const contentType = String(resp3.headers?.get?.('content-type') || '').toLowerCase()
          if (!resp3.ok) {
            const errText = await resp3.text().catch(() => '')
            let cleanErr = ''
            try {
              const parsed = JSON.parse(errText)
              const pMsg = parsed?.error?.message || parsed?.header?.message || parsed?.message || ''
              const pCode = parsed?.error?.code || parsed?.header?.code || parsed?.code || ''
              if (pMsg) cleanErr = pCode ? `${pMsg} (${pCode})` : String(pMsg)
            } catch {
              // non-json error body
            }
            const rawErr = cleanErr || errText.slice(0, 180) || `Volcengine Seed-TTS 3.0 HTTP ${resp3.status}`
            lastSeedTts3Err = {
              ok: false,
              provider,
              model: modelId3,
              voice: speaker3,
              credId: cred.id,
              latencyMs,
              error: this._explainVoiceError(rawErr, 'volcengine_tts_v3'),
            }
            // Retry once on transient rate limit / upstream 5xx errors
            if (attempt === 0 && (resp3.status === 429 || resp3.status >= 500)) {
              continue
            }
            return lastSeedTts3Err
          }
          if (contentType.startsWith('audio/')) {
            const rawAudioBuf = Buffer.from(await resp3.arrayBuffer())
            if (rawAudioBuf.length > 0) {
              const audioBuf = wantPcm16
                ? resamplePcm16Mono(rawAudioBuf, volc3Rate, targetSampleRate)
                : rawAudioBuf
              return {
                ok: true,
                provider,
                model: modelId3,
                voice: speaker3,
                credId: cred.id,
                mimeType: wantPcm16
                  ? `audio/pcm; rate=${targetSampleRate}; bits=16; channels=1`
                  : (contentType.split(';')[0] || 'audio/mpeg'),
                ...(wantPcm16 ? { sampleRate: targetSampleRate, pcmBuffer: audioBuf } : {}),
                audioBase64: audioBuf.toString('base64'),
                byteLength: audioBuf.length,
                latencyMs,
              }
            }
            lastSeedTts3Err = {
              ok: false,
              provider,
              model: modelId3,
              voice: speaker3,
              credId: cred.id,
              latencyMs,
              error: '火山语音合成 3.0 返回空音频流',
            }
            continue
          }
          const rawBody3 = await resp3.text()
          const audioParts3 = []
          let apiError3 = ''
          for (const line of rawBody3.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const obj = JSON.parse(trimmed)
              if (obj.event === 'error') {
                const eMsg = obj?.error?.message || obj?.message || 'Seed-TTS 3.0 error'
                const eCode = obj?.error?.code || obj?.code || ''
                apiError3 = eCode ? `${eMsg} (${eCode})` : String(eMsg)
              }
              if (obj.event === 'audio' && typeof obj.audio === 'string' && obj.audio.length > 0) {
                audioParts3.push(Buffer.from(obj.audio, 'base64'))
              } else if (typeof obj.data === 'string' && obj.data.length > 0) {
                audioParts3.push(Buffer.from(obj.data, 'base64'))
              }
            } catch {
              // ignore non-json fragment
            }
          }
          if (audioParts3.length === 0) {
            const rawErr = apiError3 || '火山语音合成 3.0 未返回音频数据'
            lastSeedTts3Err = {
              ok: false,
              provider,
              model: modelId3,
              voice: speaker3,
              credId: cred.id,
              latencyMs,
              error: apiError3
                ? this._explainVoiceError(rawErr, 'volcengine_tts_v3')
                : '火山语音合成 3.0 未返回音频数据（请检查音色 ID 与账号开通状态）',
            }
            continue
          }
          const rawMerged3 = Buffer.concat(audioParts3)
          const merged3 = wantPcm16
            ? resamplePcm16Mono(rawMerged3, volc3Rate, targetSampleRate)
            : rawMerged3
          return {
            ok: true,
            provider,
            model: modelId3,
            voice: speaker3,
            credId: cred.id,
            mimeType: wantPcm16
              ? `audio/pcm; rate=${targetSampleRate}; bits=16; channels=1`
              : 'audio/mpeg',
            ...(wantPcm16 ? { sampleRate: targetSampleRate, pcmBuffer: merged3 } : {}),
            audioBase64: merged3.toString('base64'),
            byteLength: merged3.length,
            latencyMs,
          }
        }
        return lastSeedTts3Err || {
          ok: false,
          provider,
          model: modelId3,
          voice: speaker3,
          credId: cred.id,
          latencyMs: this.now() - t0,
          error: '火山语音合成 3.0 暂时不可用',
        }
      }

      const url = cred.baseUrl || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
      const speaker = voice || stageCfg.voice || cred.defaultVoice || 'zh_female_vv_uranus_bigtts'
      const headers = buildVolcHeaders(cred, resourceId, 'volcengine_tts')
      const speechRate = Math.max(-50, Math.min(100, Math.round((effectiveSpeed - 1) * 50)))
      const volcRate = wantPcm16 ? (targetSampleRate <= 8000 ? 8000 : targetSampleRate <= 16000 ? 16000 : 24000) : 24000
      const reqBody = {
        user: { uid: 'pocketagents-walk' },
        req_params: {
          text: cleanText,
          speaker,
          audio_params: {
            format: wantPcm16 ? 'pcm' : 'mp3',
            sample_rate: volcRate,
            ...(speechRate !== 0 ? { speech_rate: speechRate } : {}),
          },
        },
      }
      const resp = await fetchWithTimeout(this.fetch, url, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
      })
      const latencyMs = this.now() - t0
      const contentType = String(resp.headers?.get?.('content-type') || '').toLowerCase()
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        let cleanErr = ''
        try {
          const parsed = JSON.parse(errText)
          const pMsg = parsed?.header?.message || parsed?.message || parsed?.error || ''
          const pCode = parsed?.header?.code || parsed?.code || ''
          if (pMsg) cleanErr = pCode ? `${pMsg} (${pCode})` : String(pMsg)
        } catch {
          // non-json error body
        }
        const rawErr = cleanErr || errText.slice(0, 180) || `Volcengine TTS HTTP ${resp.status}`
        return {
          ok: false,
          provider,
          model: resourceId,
          voice: speaker,
          credId: cred.id,
          latencyMs,
          error: this._explainVoiceError(rawErr, provider),
        }
      }
      if (contentType.startsWith('audio/')) {
        const rawBuf = Buffer.from(await resp.arrayBuffer())
        const audioBuf = wantPcm16 ? resamplePcm16Mono(rawBuf, volcRate, targetSampleRate) : rawBuf
        return {
          ok: true,
          provider,
          model: resourceId,
          voice: speaker,
          credId: cred.id,
          mimeType: wantPcm16
            ? `audio/pcm; rate=${targetSampleRate}; bits=16; channels=1`
            : contentType.split(';')[0] || 'audio/mpeg',
          ...(wantPcm16 ? { sampleRate: targetSampleRate, pcmBuffer: audioBuf } : {}),
          audioBase64: audioBuf.toString('base64'),
          byteLength: audioBuf.length,
          latencyMs,
        }
      }
      const rawBody = await resp.text()
      const audioParts = []
      let apiError = ''
      for (const line of rawBody.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const obj = JSON.parse(trimmed)
          if (obj.code && obj.code !== 0 && obj.code !== 20000000) {
            apiError = obj.message || `Volcengine TTS code ${obj.code}`
          }
          if (typeof obj.data === 'string' && obj.data.length > 0) {
            audioParts.push(Buffer.from(obj.data, 'base64'))
          }
        } catch {
          // ignore non-json fragment
        }
      }
      if (audioParts.length === 0) {
        const rawErr = apiError || '火山 TTS 未返回音频数据'
        return {
          ok: false,
          provider,
          model: resourceId,
          voice: speaker,
          credId: cred.id,
          latencyMs,
          error: apiError
            ? this._explainVoiceError(rawErr, provider)
            : '火山 TTS 未返回音频数据（请检查该账号是否已开通 Seed-TTS 2.0 权限，或播报先改用手机自带免费）',
        }
      }
      const rawMerged = Buffer.concat(audioParts)
      const merged = wantPcm16 ? resamplePcm16Mono(rawMerged, volcRate, targetSampleRate) : rawMerged
      return {
        ok: true,
        provider,
        model: resourceId,
        voice: speaker,
        credId: cred.id,
        mimeType: wantPcm16
          ? `audio/pcm; rate=${targetSampleRate}; bits=16; channels=1`
          : 'audio/mpeg',
        ...(wantPcm16 ? { sampleRate: targetSampleRate, pcmBuffer: merged } : {}),
        audioBase64: merged.toString('base64'),
        byteLength: merged.length,
        latencyMs,
      }
    }

    if (provider === 'gemini') {
      const model = stageCfg.model || cred.defaultModel || 'gemini-2.5-flash-preview-tts'
      const voiceName = voice || stageCfg.voice || cred.defaultVoice || 'Kore'
      const base = cred.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'
      const url = `${base}/models/${encodeURIComponent(model)}:generateContent`
      const payload = {
        contents: [{ role: 'user', parts: [{ text: cleanText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      }
      const resp = await fetchWithTimeout(this.fetch, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cred.apiKey,
        },
        body: JSON.stringify(payload),
      })
      const latencyMs = this.now() - t0
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        return {
          ok: false,
          provider,
          model,
          voice: voiceName,
          credId: cred.id,
          latencyMs,
          error: data?.error?.message || `Gemini TTS HTTP ${resp.status}`,
        }
      }
      const parts = data?.candidates?.[0]?.content?.parts || []
      const audioPart = parts.find(p => p?.inlineData?.data)
      if (!audioPart) {
        return { ok: false, provider, model, voice: voiceName, credId: cred.id, latencyMs, error: 'Gemini TTS 未返回音频数据' }
      }
      const rawMime = String(audioPart.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000')
      const rawBuf = Buffer.from(audioPart.inlineData.data, 'base64')
      const isPcm = /pcm|l16/i.test(rawMime)
      const rateMatch = /rate=(\d+)/i.exec(rawMime)
      const sourceRate = rateMatch ? Number(rateMatch[1]) : 24000
      if (wantPcm16 && isPcm) {
        const resampled = resamplePcm16Mono(rawBuf, sourceRate, targetSampleRate)
        return {
          ok: true,
          provider,
          model,
          voice: voiceName,
          credId: cred.id,
          mimeType: `audio/pcm; rate=${targetSampleRate}; bits=16; channels=1`,
          sampleRate: targetSampleRate,
          pcmBuffer: resampled,
          audioBase64: resampled.toString('base64'),
          byteLength: resampled.length,
          latencyMs,
        }
      }
      const finalBuf = isPcm ? encodePcm16ToWav(rawBuf, sourceRate, 1) : rawBuf
      const finalMime = isPcm ? 'audio/wav' : rawMime.split(';')[0]
      return {
        ok: true,
        provider,
        model,
        voice: voiceName,
        credId: cred.id,
        mimeType: finalMime,
        audioBase64: finalBuf.toString('base64'),
        byteLength: finalBuf.length,
        latencyMs,
      }
    }

    if (provider === 'openai_compat') {
      const model = stageCfg.model || cred.defaultModel || 'gpt-4o-mini-tts'
      const chosenVoice = voice || stageCfg.voice || cred.defaultVoice || 'alloy'
      const base = cred.baseUrl || 'https://api.openai.com/v1'
      const url = `${base}/audio/speech`
      const resp = await fetchWithTimeout(this.fetch, url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cred.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: cleanText,
          voice: chosenVoice,
          response_format: wantPcm16 ? 'pcm' : 'mp3',
          speed: effectiveSpeed,
        }),
      })
      const latencyMs = this.now() - t0
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        return {
          ok: false,
          provider,
          model,
          voice: chosenVoice,
          credId: cred.id,
          latencyMs,
          error: errData?.error?.message || `OpenAI-compat TTS HTTP ${resp.status}`,
        }
      }
      const ct = String(resp.headers?.get?.('content-type') || '').toLowerCase()
      if (ct && !ct.startsWith('audio/') && !ct.startsWith('application/octet-stream')) {
        return {
          ok: false,
          provider,
          model,
          voice: chosenVoice,
          credId: cred.id,
          latencyMs,
          error: `OpenAI-compat TTS 返回非音频类型 (${ct.split(';')[0]})`,
        }
      }
      const rawBuf = Buffer.from(await resp.arrayBuffer())
      if (rawBuf.length > MAX_TTS_AUDIO_BYTES) {
        return {
          ok: false,
          provider,
          model,
          voice: chosenVoice,
          credId: cred.id,
          latencyMs,
          error: 'TTS 音频响应体积超限',
        }
      }
      const buf = wantPcm16 ? resamplePcm16Mono(rawBuf, 24000, targetSampleRate) : rawBuf
      return {
        ok: true,
        provider,
        model,
        voice: chosenVoice,
        credId: cred.id,
        mimeType: wantPcm16
          ? `audio/pcm; rate=${targetSampleRate}; bits=16; channels=1`
          : ct.startsWith('audio/')
            ? ct.split(';')[0]
            : 'audio/mpeg',
        ...(wantPcm16 ? { sampleRate: targetSampleRate, pcmBuffer: buf } : {}),
        audioBase64: buf.toString('base64'),
        byteLength: buf.length,
        latencyMs,
      }
    }

    return { ok: false, provider, error: `不支持的 TTS 服务商：${provider}`, latencyMs: this.now() - t0 }
  }

  _explainVoiceError(rawErr = '', provider = '') {
    const raw = String(rawErr || '').trim()
    if (!raw) return '调用失败，请检查接口地址、密钥与模型名'
    if (raw.includes('（') && raw.includes('）')) return raw
    const msg = raw.replace(/\s*Request id:\s*[A-Za-z0-9_-]+/gi, '').trim().slice(0, 140) || raw.slice(0, 140)
    const lower = msg.toLowerCase()
    if (/401|unauthorized|invalid.*api.?key|incorrect api key|api.?key.*(incorrect|invalid|format|malformed|missing|wrong)|authentication|access denied|auth/i.test(lower)) {
      if (provider === 'volcengine_tts_v3') {
        return `密钥无效或未授权：请确认填的是火山「语音合成 3.0」新版控制台里的 API Key，而不是火山方舟大模型密钥（${msg}）`
      }
      if (provider.startsWith('volcengine_')) {
        return `密钥无效或未授权：请确认填的是火山「语音技术」密钥，不是「火山方舟」大模型密钥；旧版应用请切到 AppID + Token（${msg}）`
      }
      return `密钥格式不对或未授权：请检查 API Key 是否复制完整（${msg}）`
    }
    if (/resourceid.*not allowed/i.test(lower) && provider === 'volcengine_asr') {
      return `Resource ID 不正确（不要填控制台里的「实例 ID」）：豆包 2.0 标准版请填 volc.seedasr.auc，极速版请填 volc.bigasr.auc_turbo（${msg}）`
    }
    if (/403|forbidden|permission|not granted|not enabled|resource.*not|45000000|55000000|requested resource/i.test(lower)) {
      if (provider === 'volcengine_tts_v3') {
        return `无权限调用「语音合成 3.0」或当前音色 ID 未开通：请在火山新版控制台确认已开通语音合成 3.0 且音色 ID 匹配（${msg}）`
      }
      if (provider === 'volcengine_tts') {
        return `该火山密钥可能尚未开通「语音合成 Seed-TTS 2.0」权限：可在火山控制台开通，或播报先改用手机自带免费（${msg}）`
      }
      if (provider === 'volcengine_asr') {
        return `该火山密钥未开通当前 Resource ID 的权限：如果你开通的是「2.0 标准版」，请把 Resource ID 改为 volc.seedasr.auc；如果是「极速版」，请填 volc.bigasr.auc_turbo（${msg}）`
      }
      return `无权限访问该接口或模型：请检查账号权限与余额（${msg}）`
    }
    if (/404|not found/i.test(lower)) {
      if (provider === 'openai_compat') {
        return `接口地址或模型 ID 不存在：请检查 Base URL 是否漏了 /v1 或模型名是否拼错（${msg}）`
      }
      return `接口地址或模型不存在（${msg}）`
    }
    if (/429|rate limit|quota|insufficient|balance/i.test(lower)) {
      return `额度不足或触发限流：请检查账户余额（${msg}）`
    }
    if (/timeout|etimedout|aborted|econnrefused|econnreset|enetunreach|enotfound|err_invalid_url|redirect|fetch failed/i.test(lower)) {
      return `连接超时或地址不可达：请检查接口地址（Base URL）是否以 https:// 开头且拼写正确（${msg}）`
    }
    return msg
  }

  _resolveDraftTestCred(draft = {}) {
    const provider = String(draft?.provider || '').trim().toLowerCase()
    if (!['openai_compat', 'gemini', 'volcengine_asr', 'volcengine_tts'].includes(provider)) {
      return { ok: false, error: `不支持的协议类型：${provider || '(空)'}` }
    }
    const existingId = String(draft?.id || '').trim()
    const existing = existingId ? this.vault.resolveCredential({ credId: existingId }) : null

    const draftResId = String(draft?.resourceId || existing?.resourceId || '').trim()
    const isVolcTts3Draft = provider === 'volcengine_tts' && (/3\.0/i.test(draftResId) || /voice\.cn-beijing\.volces\.com|text-to-speech/i.test(String(draft?.baseUrl || '')))
    const defaultBaseUrlMap = {
      openai_compat: '',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
      volcengine_asr: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      volcengine_tts: isVolcTts3Draft
        ? 'https://voice.cn-beijing.volces.com/api/v3/text-to-speech'
        : 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    }
    const baseUrlRaw = String(draft?.baseUrl ?? '').trim() || existing?.baseUrl || defaultBaseUrlMap[provider] || ''
    if (provider === 'openai_compat' && !baseUrlRaw) {
      return { ok: false, error: '请先填写接口地址（Base URL），例如 https://ark.cn-beijing.volces.com/api/v3' }
    }
    if (baseUrlRaw && isBlockedVoiceBaseUrl(baseUrlRaw)) {
      return { ok: false, error: '安全策略拦截：不支持指向云内网元数据或非法地址' }
    }
    const cleanBaseUrl = baseUrlRaw.replace(/\/+$/, '')

    // Security invariant: only reuse existing stored secret if editing the SAME host (zero secret exfiltration)
    let canReuseStoredSecret = false
    if (existing && existing.provider === provider) {
      try {
        const oldHost = existing.baseUrl ? new URL(existing.baseUrl).host.toLowerCase() : ''
        const newHost = cleanBaseUrl ? new URL(cleanBaseUrl).host.toLowerCase() : ''
        canReuseStoredSecret = Boolean(oldHost && newHost && oldHost === newHost)
      } catch {
        canReuseStoredSecret = false
      }
    }

    const rawApiKey = String(draft?.apiKey || '').trim()
    const rawAppId = String(draft?.appId || '').trim()
    const rawAccessToken = String(draft?.accessToken || '').trim()
    const volcAuthMode = String(draft?.authMode || '').trim().toLowerCase()
    const isVolc = provider === 'volcengine_asr' || provider === 'volcengine_tts'

    let apiKey = ''
    let appId = ''
    let accessToken = ''
    if (isVolc && volcAuthMode === 'apptoken') {
      // Explicit AppID + Access Token mode: NEVER fall back to stale stored apiKey!
      appId = rawAppId || (canReuseStoredSecret ? existing.appId : '')
      accessToken = rawAccessToken || (canReuseStoredSecret ? existing.accessToken : '')
    } else if (isVolc && volcAuthMode === 'apikey') {
      apiKey = rawApiKey || (canReuseStoredSecret ? existing.apiKey : '')
    } else {
      apiKey = rawApiKey || (canReuseStoredSecret ? existing.apiKey : '')
      appId = rawAppId || (canReuseStoredSecret ? existing.appId : '')
      accessToken = rawAccessToken || (canReuseStoredSecret ? existing.accessToken : '')
    }

    if (provider === 'volcengine_asr' || provider === 'volcengine_tts') {
      if (!apiKey && !(appId && accessToken)) {
        return {
          ok: false,
          error: existing && !canReuseStoredSecret
            ? '修改接口地址后，请重新填写密钥再测试'
            : '请先填写 API Key，或切换并填写 AppID 与 Access Token',
        }
      }
    } else if (!apiKey) {
      return {
        ok: false,
        error: existing && !canReuseStoredSecret
          ? '修改接口地址后，请重新填写 API Key 再测试'
          : '请先填写 API Key 再测试连通性',
      }
    }

    return {
      ok: true,
      cred: {
        id: existing?.id || `draft_${provider}`,
        provider,
        label: String(draft?.label || provider).trim().slice(0, 80),
        baseUrl: cleanBaseUrl,
        apiKey,
        appId,
        accessToken,
        resourceId: String(draft?.resourceId || existing?.resourceId || '').trim().slice(0, 80),
        defaultModel: String(draft?.defaultModel || '').trim().slice(0, 120),
        defaultVoice: String(draft?.defaultVoice || '').trim().slice(0, 120),
        enabled: true,
        active: true,
      },
    }
  }

  async testCredential({ credId = '', stage = '', draft = null } = {}) {
    let cred = null
    if (draft && typeof draft === 'object') {
      const resolved = this._resolveDraftTestCred(draft)
      if (!resolved.ok) return { ok: false, error: resolved.error, summary: resolved.error }
      cred = resolved.cred
    } else {
      cred = this.vault.resolveCredential({ credId })
    }
    if (!cred) {
      return { ok: false, error: '未找到要测试的密钥', summary: '未找到要测试的密钥' }
    }
    const provider = cred.provider
    try {
      return await this._runTestCredentialInner(cred, { stage, draft })
    } catch (err) {
      const detail = formatFetchError(err)
      const niceErr = this._explainVoiceError(detail, provider)
      return {
        ok: false,
        provider,
        model: cred.defaultModel || cred.resourceId || '',
        latencyMs: 0,
        error: niceErr,
        summary: niceErr,
      }
    }
  }

  async _runTestCredentialInner(cred, { stage = '', draft = null } = {}) {
    const provider = cred.provider

    if (provider === 'volcengine_asr') {
      const silentWav = encodePcm16ToWav(Buffer.alloc(16000 * 2 * 0.3), 16000, 1)
      const asrRes = await this.runSingleStt(
        { provider, credId: cred.id, model: cred.resourceId || 'volc.bigasr.auc_turbo' },
        { audioBase64: silentWav.toString('base64'), mimeType: 'audio/wav', credOverride: cred },
      )
      const asrErr = asrRes.ok ? '' : this._explainVoiceError(asrRes.error, 'volcengine_asr')

      // Optional paired TTS check when configuring Volcengine ASR + TTS together in the editor
      if (draft && draft.alsoTestTts) {
        const ttsCred = {
          ...cred,
          id: `${cred.id}_tts`,
          provider: 'volcengine_tts',
          baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
          resourceId: String(draft.pairedTtsResourceId || 'seed-tts-2.0').trim() || 'seed-tts-2.0',
          defaultVoice: String(draft.pairedTtsVoice || 'zh_female_vv_uranus_bigtts').trim() || 'zh_female_vv_uranus_bigtts',
        }
        const ttsRes = await this.runTts({
          text: '测试成功',
          stageOverride: {
            provider: 'volcengine_tts',
            credId: ttsCred.id,
            model: ttsCred.resourceId,
            voice: ttsCred.defaultVoice,
          },
          credOverride: ttsCred,
        })
        const ttsErr = ttsRes.ok ? '' : this._explainVoiceError(ttsRes.error, 'volcengine_tts')
        if (asrRes.ok && ttsRes.ok) {
          return {
            ok: true,
            provider,
            latencyMs: asrRes.latencyMs,
            audioBase64: ttsRes.audioBase64 || '',
            mimeType: ttsRes.mimeType || 'audio/mpeg',
            asrOk: true,
            ttsOk: true,
            summary: `听写连通 (${asrRes.latencyMs}ms) · 播报连通 (${ttsRes.latencyMs}ms)`,
          }
        }
        if (asrRes.ok && !ttsRes.ok) {
          return {
            ok: false,
            partialOk: true,
            provider,
            latencyMs: asrRes.latencyMs,
            asrOk: true,
            ttsOk: false,
            error: ttsErr,
            summary: `听写连通 (${asrRes.latencyMs}ms)，但播报失败：${ttsErr}`,
          }
        }
        return {
          ok: false,
          provider,
          latencyMs: asrRes.latencyMs,
          asrOk: false,
          ttsOk: Boolean(ttsRes.ok),
          error: asrErr,
          summary: ttsRes.ok
            ? `播报连通 (${ttsRes.latencyMs}ms)，但听写失败：${asrErr}`
            : `听写失败：${asrErr}`,
        }
      }

      return {
        ...asrRes,
        error: asrErr || undefined,
        summary: asrRes.ok
          ? `听写连通正常 (${asrRes.latencyMs}ms${asrRes.silence ? ' · 静音校验通过' : ''})`
          : asrErr,
      }
    }

    if (provider === 'volcengine_tts') {
      const ttsModel = cred.resourceId || 'seed-tts-2.0'
      const isV3 = /3\.0/i.test(ttsModel) || /voice\.cn-beijing\.volces\.com|text-to-speech/i.test(cred.baseUrl || '')
      const res = await this.runTts({
        text: '测试成功',
        stageOverride: {
          provider,
          credId: cred.id,
          model: ttsModel,
          voice: cred.defaultVoice || (isV3 ? 'multi_female_tuanzi_v3_uranus_bigtts' : 'zh_female_vv_uranus_bigtts'),
        },
        credOverride: cred,
      })
      const niceErr = res.ok ? '' : this._explainVoiceError(res.error, isV3 ? 'volcengine_tts_v3' : 'volcengine_tts')
      return {
        ok: res.ok,
        provider,
        model: res.model,
        latencyMs: res.latencyMs,
        byteLength: res.byteLength || 0,
        audioBase64: res.audioBase64 || '',
        mimeType: res.mimeType || 'audio/mpeg',
        error: niceErr || undefined,
        summary: res.ok
          ? `播报连通正常 (${res.latencyMs}ms · ${Math.max(1, Math.round((res.byteLength || 0) / 1024))} KB)`
          : niceErr,
      }
    }

    if (stage === 'tts') {
      const res = await this.runTts({
        text: '测试成功',
        stageOverride: {
          provider,
          credId: cred.id,
          model: cred.defaultModel || (provider === 'gemini' ? 'gemini-2.5-flash-preview-tts' : 'gpt-4o-mini-tts'),
          voice: cred.defaultVoice || (provider === 'gemini' ? 'Kore' : 'alloy'),
        },
        credOverride: cred,
      })
      const niceErr = res.ok ? '' : this._explainVoiceError(res.error, provider)
      return {
        ok: res.ok,
        provider,
        model: res.model,
        latencyMs: res.latencyMs,
        byteLength: res.byteLength || 0,
        audioBase64: res.audioBase64 || '',
        mimeType: res.mimeType || 'audio/mpeg',
        error: niceErr || undefined,
        summary: res.ok ? `播报连通正常 (${res.latencyMs}ms)` : niceErr,
      }
    }

    // Brain / general connectivity probe (Gemini or OpenAI-compatible)
    const model = cred.defaultModel || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini')
    const res = await this._callBrainModel(
      { provider, credId: cred.id, model, thinkingLevel: 'off', maxTokens: 48 },
      {
        systemPrompt: '只返回 JSON：{"ok":true,"spokenReply":"ok"}',
        userText: 'ping',
        credOverride: cred,
      },
    )
    const niceErr = res.ok ? '' : this._explainVoiceError(res.error, provider)
    return {
      ok: res.ok,
      provider,
      model: res.model || model,
      latencyMs: res.latencyMs,
      error: niceErr || undefined,
      summary: res.ok ? `连通正常 (${res.latencyMs}ms · ${res.model || model})` : niceErr,
    }
  }

  resolveDeviceBrainStage(profileId = '') {
    const profile = this._resolveEffectiveProfile(profileId, null)
    const brain = profile?.brain || {}
    const provider = String(brain.provider || '').toLowerCase()
    if (provider === 'gemini' || provider === 'openai_compat') {
      const cred = this.vault.resolveCredential({ provider, credId: brain.credId })
      if (cred) {
        return {
          provider,
          credId: cred.id,
          model: brain.model || cred.defaultModel || (provider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini'),
          thinkingLevel: 'off',
          maxTokens: 180,
        }
      }
    }
    // Fallback: reuse any configured Gemini or OpenAI-compat credential in BYOK vault
    for (const fallbackProvider of ['gemini', 'openai_compat']) {
      const cred = this.vault.resolveCredential({ provider: fallbackProvider })
      if (cred) {
        return {
          provider: fallbackProvider,
          credId: cred.id,
          model: cred.defaultModel || (fallbackProvider === 'gemini' ? 'gemini-2.5-flash' : 'gpt-4o-mini'),
          thinkingLevel: 'off',
          maxTokens: 180,
        }
      }
    }
    return null
  }

  /**
   * Compact, non-hallucinating Chinese summary & option translation for tiny
   * edge-device displays (FoloToy AI Passport, Watch, E-ink). Never modifies raw commands.
   */
  async summarizeDeviceApprovalZh({
    title = '',
    cmd = '',
    tool = '',
    kind = 'approval',
    risk = 'L1',
    options = [],
    profileId = '',
  } = {}) {
    const stageCfg = this.resolveDeviceBrainStage(profileId)
    if (!stageCfg) {
      return { ok: false, skipped: true, reason: 'no_cloud_brain' }
    }
    const cleanOptions = Array.isArray(options) ? options.slice(0, 4).map(s => String(s || '').trim()) : []
    const systemPrompt = [
      '你是 240x320 极小硬件屏幕的中文审批翻译助手。',
      '请把 AI 编程工具弹出的英文审批或英文多选题浓缩成一眼能看懂的中文大白话。',
      '只返回严格 JSON：{"title":"<=14字中文意图","options":["<=10字中文选项",...]}。',
      '规则：',
      '1) options 数量必须与输入完全一致（输入为空数组则返回 []），顺序不可调换；',
      '2) 若为 L2 高危命令，title 必须直白点出危险动作（如删除、强推、清空库），严禁弱化风险；',
      '3) 禁止输出任何 Markdown 代码块或多余解释。',
    ].join('\n')
    const userPayload = JSON.stringify({
      kind,
      risk,
      tool,
      title: String(title || '').slice(0, 120),
      cmd: String(cmd || '').slice(0, 160),
      options: cleanOptions,
    })
    const res = await this._callBrainModel(stageCfg, {
      systemPrompt,
      userText: userPayload,
    })
    if (!res.ok || !res.rawText) {
      return { ok: false, error: res.error || 'empty_brain_reply' }
    }
    const cleaned = String(res.rawText)
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()
    try {
      const parsed = JSON.parse(cleaned)
      const outTitle = String(parsed?.title || '').replace(/\s+/g, ' ').trim().slice(0, 28)
      const rawOutOpts = Array.isArray(parsed?.options) ? parsed.options : []
      const outOptions =
        cleanOptions.length > 0 && rawOutOpts.length === cleanOptions.length
          ? rawOutOpts.map((o, i) => String(o || cleanOptions[i]).replace(/\s+/g, ' ').trim().slice(0, 18))
          : cleanOptions
      if (!outTitle && outOptions.length === 0) {
        return { ok: false, error: 'empty_parsed_summary' }
      }
      return {
        ok: true,
        title: outTitle,
        options: outOptions,
        provider: res.provider,
        model: res.model,
        latencyMs: res.latencyMs,
      }
    } catch {
      return { ok: false, error: 'invalid_json_summary' }
    }
  }
}
