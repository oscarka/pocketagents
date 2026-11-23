const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi
const CREDENTIALED_URL = /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|https?):\/\/[^:\s/@"'`]+:)[^@\s/"'`]+@/gi
const SK_KEY = /(?:^|[^A-Za-z0-9_])((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9_-]{8,})/g
const ARK_KEY = /(?:^|[^A-Za-z0-9_])(ark-[A-Za-z0-9_-]{12,})/g
const HST_TOKEN = /\bhst_[0-9a-f]{32,}\b/gi
const DEV_TOKEN = /\bdev_[0-9a-f]{32,}\b/gi
const GEMINI_AIZA = /\bAIza[0-9A-Za-z_-]{20,}/g
const GEMINI_AQ = /\bAQ\.Ab[0-9A-Za-z_-]{16,}/g
const GOOGLE_OAUTH = /\b(?:ya29\.[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{16,})\b/g
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g
const SLACK_TOKEN = /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{20,}\b/g
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
const MEDIA_TICKET = /\bmt1\.\d+\.[A-Za-z0-9_-]{16,}/g
const SENSITIVE_HEADER = /\b(x-hub-token|x-api-key|x-goog-api-key|x-codeium-csrf-token|set-cookie|cookie)(\s*:\s*)([^\r\n;]{6,})/gi
// Matches both env vars with prefixes (FEISHU_HUB_TOKEN=..., AWS_SECRET_ACCESS_KEY=...) and JSON pairs ("api_key": "...")
const ASSIGNMENT = /([A-Za-z0-9_-]*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|hub[_-]?token|vault[_-]?secret|vapid[_-]?secret|password|secret))(["']?\s*[:=]\s*)(["']?)[^\s"',;}{]{6,}\3/gi

/** Best-effort redaction for chat output and audit fields. Never a substitute for not sending secrets. */
export function redactText(value) {
  let text = String(value ?? '')
  text = text.replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
  text = text.replace(BEARER, 'Bearer [REDACTED]')
  text = text.replace(BASIC_AUTH, 'Basic [REDACTED]')
  text = text.replace(CREDENTIALED_URL, '$1[REDACTED]@')
  text = text.replace(SK_KEY, (m, tok) => m.slice(0, m.length - tok.length) + 'sk-[REDACTED]')
  text = text.replace(ARK_KEY, (m, tok) => m.slice(0, m.length - tok.length) + 'ark-[REDACTED]')
  text = text.replace(HST_TOKEN, 'hst_[REDACTED]')
  text = text.replace(DEV_TOKEN, 'dev_[REDACTED]')
  text = text.replace(GEMINI_AIZA, 'AIza[REDACTED]')
  text = text.replace(GEMINI_AQ, 'AQ.Ab[REDACTED]')
  text = text.replace(GOOGLE_OAUTH, '[REDACTED_OAUTH]')
  text = text.replace(AWS_ACCESS_KEY, 'AKIA[REDACTED]')
  text = text.replace(GITHUB_TOKEN, 'gh_[REDACTED]')
  text = text.replace(SLACK_TOKEN, 'xox-[REDACTED]')
  text = text.replace(NPM_TOKEN, 'npm_[REDACTED]')
  text = text.replace(JWT_TOKEN, 'eyJ[REDACTED_JWT]')
  text = text.replace(MEDIA_TICKET, 'mt1.[REDACTED]')
  text = text.replace(SENSITIVE_HEADER, '$1$2[REDACTED]')
  text = text.replace(ASSIGNMENT, (_match, key, separator, quote) => `${key}${separator}${quote}[REDACTED]${quote}`)
  return text
}

export function truncateText(value, maxChars) {
  const text = String(value ?? '')
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n…（已截断）`
}

export function cleanForChat(value, maxChars) {
  return truncateText(redactText(value), maxChars)
}

/** Keep the first line of an error and avoid leaking headers/stacks into Feishu. */
export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return redactText(message.split('\n')[0]).slice(0, 500)
}
