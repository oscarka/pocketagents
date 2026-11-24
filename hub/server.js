import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isIP } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join, posix as posixPath } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { brotliCompressSync, createGzip, gunzipSync, gzip, gzipSync, constants as zlibConstants } from 'node:zlib'
import { HubCore } from './hub-core.js'
import { captureStateDigest, buildStateDelta } from './delta-state.js'
import { VoiceVault } from './voice-vault.js'
import { VoiceCopilotEngine } from './voice-copilot.js'

const gzipAsync = promisify(gzip)
const HUB_MEDIA_CACHE_MAX_ITEM_BYTES = 1.5 * 1024 * 1024

function normalizeFsSecurityPath(raw = '') {
  let s = String(raw ?? '').trim().replace(/^file:\/\//i, '').replace(/#L\d+(?:-L?\d+)?$/i, '')
  for (let i = 0; i < 2; i += 1) {
    if (!s.includes('%')) break
    try {
      const dec = decodeURIComponent(s)
      if (dec === s) break
      s = dec
    } catch {
      break
    }
  }
  const cleaned = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (!cleaned) return ''
  let norm = posixPath.normalize(cleaned)
  // Strip macOS APFS firmlink prefix so /System/Volumes/Data/Users/... cannot bypass path rules
  norm = norm.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '') || '/'
  return norm === '/' ? '/' : norm.replace(/\/+$/, '')
}

const HOME_ROOT_RE = /^(?:~|\/(?:Users|home)\/[^/]+|\/root)$/i
const SENSITIVE_SYSTEM_ROOT_RE = /^(?:\/(?:private\/)?etc|\/proc|\/sys|\/(?:private\/)?var\/lib\/dsh-hub)(?:\/|$)/i
const SENSITIVE_DIR_SEGMENT_RE =
  /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|Library\/Keychains|Library\/LaunchAgents|Library\/Cookies|\.config\/(?:gcloud|gh|op|1password|stripe|vercel|railway|rclone)|\.docker\/config\.json|\.cargo\/credentials\.toml|\.codex\/auth\.json|\.claude\/\.credentials\.json|\.gemini\/oauth_creds\.json|CodeBuddyExtension\/.*\/workbuddy-cli\.info)(?:\/|$)/i
const SENSITIVE_DSH_PATH_RE = /(?:^|\/)\.dsh(?:\/|$)/i
const SENSITIVE_BASENAME_RE =
  /^(?:\.credentials\.yaml|\.credentials\.json|feishu\.env|feishu-host\.json|local-hub\.token|local-hub-info\.json|hub-state\.json|dsh-hub-state\.json|voice-vault\.enc\.json|\.voice-vault\.key|\.claude\.json|oauth_creds\.json|workbuddy-cli\.info|session\.v\d+\.jsonl\.zstd|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|id_ecdsa(?:\.pub)?|id_dsa(?:\.pub)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.pgpass|\.my\.cnf)$/i
const HOME_DOTFILE_SECRET_RE =
  /^(?:~|\/(?:Users|home)\/[^/]+|\/root)\/\.(?:zshenv|zshrc|zprofile|zlogin|zlogout|zsh_history|bashrc|bash_profile|bash_history|profile|local\/bin\/env)$/i
const RAW_STREAM_SECRET_BASENAME_RE =
  /^(?:\.env(?:\.(?!example$|sample$|template$|dist$)[^/]+)?|\.envrc|[^/]+\.env|.*\.(?:pem|key|p8|p12|pfx|ppk|kdbx|ovpn|jks|keystore)|credentials\.json|service-account[^/]*\.json|auth\.json)$/i

export function isBlockedHubFsPath({ cwd = '', path = '', op = 'read', isAdmin = true } = {}) {
  const normCwd = normalizeFsSecurityPath(cwd)
  const normPath = normalizeFsSecurityPath(path)
  const rawCombined =
    normPath.startsWith('/') || normPath === '~' || normPath.startsWith('~/')
      ? normPath
      : normCwd && normPath
        ? `${normCwd}/${normPath.replace(/^\/+/, '')}`
        : normPath || normCwd
  let combined = rawCombined ? posixPath.normalize(rawCombined).replace(/\/+$/, '') || '/' : ''
  combined = combined.replace(/^\/System\/Volumes\/Data(?=\/|$)/i, '') || '/'

  if (
    SENSITIVE_SYSTEM_ROOT_RE.test(combined) ||
    SENSITIVE_DIR_SEGMENT_RE.test(combined) ||
    SENSITIVE_DSH_PATH_RE.test(combined)
  ) {
    return true
  }
  if (HOME_DOTFILE_SECRET_RE.test(combined)) {
    return true
  }
  const base = combined.split('/').pop() || ''
  if (base && SENSITIVE_BASENAME_RE.test(base)) {
    return true
  }
  if (base && RAW_STREAM_SECRET_BASENAME_RE.test(base)) {
    return true
  }
  if (op === 'stream') {
    if (!isAdmin && (HOME_ROOT_RE.test(normCwd) || normCwd === '/') && normPath.replace(/^\.\/+/, '').startsWith('.')) {
      return true
    }
  }
  return false
}

function createImageCacheTransform(expectedBytes, maxBytes, onComplete) {
  const chunks = []
  let collected = 0
  let overflow = false
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!overflow) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        collected += buf.length
        if (collected <= maxBytes) {
          chunks.push(buf)
        } else {
          overflow = true
          chunks.length = 0
        }
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (!overflow && collected > 0 && (!expectedBytes || collected === expectedBytes)) {
        try {
          onComplete(Buffer.concat(chunks, collected))
        } catch {
          // ignore cache populate failure
        }
      }
      callback()
    },
  })
}

const staticAssetMemCache = new Map()

async function readStaticTextPrecompressed(filePath) {
  const st = await stat(filePath)
  const cached = staticAssetMemCache.get(filePath)
  if (cached && cached.mtimeMs === st.mtimeMs) {
    return cached
  }
  const rawBuf = await readFile(filePath)
  const text = rawBuf.toString('utf8')
  const gzBuf = rawBuf.length > 512 ? gzipSync(rawBuf, { level: 9 }) : null
  const brBuf =
    rawBuf.length > 512
      ? brotliCompressSync(rawBuf, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 },
      })
      : null
  const entry = { mtimeMs: st.mtimeMs, rawBuf, gzBuf, brBuf, text }
  if (staticAssetMemCache.size > 32) {
    const oldestKey = staticAssetMemCache.keys().next().value
    if (oldestKey) staticAssetMemCache.delete(oldestKey)
  }
  staticAssetMemCache.set(filePath, entry)
  return entry
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML_PATH = join(__dirname, 'public', 'index.html')
const PACKAGE_JSON_PATH = join(__dirname, '..', 'package.json')
const CONNECT_SCRIPT_PATH = join(__dirname, '..', 'connect-host.sh')
const MAX_BODY_BYTES = 50 * 1024 * 1024 // 50 MiB for snapshot uploads

function getRouteMaxBodyBytes(pathname = '') {
  const isLargeBodyRoute =
    pathname === '/api/heartbeat'
    || pathname === '/api/snapshots'
    || pathname === '/api/shares'
    || pathname === '/api/voice/stt'
    || /^\/api\/hosts\/[^/]+\/command$/.test(pathname)
  return isLargeBodyRoute ? MAX_BODY_BYTES : 256 * 1024
}

export function resolveClientIp(
  headers = {},
  remoteAddress = '',
  {
    trustProxy = process.env.TRUST_PROXY === '1' ||
    process.env.TRUST_PROXY === 'true' ||
    Boolean(process.env.K_SERVICE) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT),
    trustedHops = Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1),
  } = {},
) {
  const cleanSocket = String(remoteAddress || '')
    .trim()
    .replace(/^::ffff:/i, '')
  if (!trustProxy) {
    return cleanSocket || 'socket-local'
  }
  const xffRaw = String(headers['x-forwarded-for'] ?? headers['X-Forwarded-For'] ?? '').trim()
  if (xffRaw) {
    const hops = xffRaw
      .split(',')
      .map(s => s.trim().replace(/^::ffff:/i, ''))
      .filter(ip => ip && isIP(ip) !== 0)
    if (hops.length > 0) {
      const idx = Math.max(0, hops.length - trustedHops)
      return hops[idx]
    }
  }
  const realIp = String(headers['x-real-ip'] ?? headers['X-Real-IP'] ?? '')
    .trim()
    .replace(/^::ffff:/i, '')
  if (realIp && isIP(realIp) !== 0) {
    return realIp
  }
  return cleanSocket || 'socket-local'
}

export function validateHubStartupToken(token, { allowInsecureNoToken = false } = {}) {
  const clean = String(token ?? '').trim()
  if (!clean && !allowInsecureNoToken) {
    return {
      ok: false,
      error:
        '❌ 拒绝无密码启动：未设置 HUB_TOKEN 环境变量。\n' +
        '   为了防止控制台在公网裸奔，启动时必须指定管理员密码，例如：\n' +
        '   HUB_TOKEN="$(openssl rand -hex 16)" node hub/server.js\n' +
        '   docker run -d -p 8080:8080 -v dsh-data:/data -e HUB_TOKEN="你的密码" ghcr.io/oscarka/pocketagents:latest',
    }
  }
  return { ok: true, token: clean }
}

export function resolveDefaultStateFile(
  envStateFile = process.env.HUB_STATE_FILE,
  { dataDir = '/data', homeDir = homedir() } = {},
) {
  const explicit = String(envStateFile ?? '').trim()
  if (explicit) return explicit
  try {
    if (existsSync(dataDir)) {
      accessSync(dataDir, constants.W_OK)
      return join(dataDir, 'dsh-hub-state.json')
    }
  } catch {
    // /data is missing or not writable (e.g. local macOS / Linux npm start outside Docker)
  }
  return join(homeDir, '.dsh', 'hub-state.json')
}

export function detectLanOrigins(
  port = 8080,
  { scheme = 'http', interfaces = networkInterfaces() } = {},
) {
  const cleanPort = Number(port) || 8080
  const portSuffix =
    (scheme === 'http' && cleanPort === 80) || (scheme === 'https' && cleanPort === 443)
      ? ''
      : `:${cleanPort}`
  const preferred = []
  const others = []
  try {
    for (const [ifName, list] of Object.entries(interfaces || {})) {
      if (/^(lo|docker|br-|veth|utun|tun|tap|awdl|llw)/i.test(ifName)) continue
      for (const addr of list || []) {
        const family = addr?.family === 4 ? 'IPv4' : String(addr?.family || '')
        if (family !== 'IPv4' || addr?.internal) continue
        const ip = String(addr?.address || '').trim()
        if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue
        const url = `${scheme}://${ip}${portSuffix}`
        if (
          ip.startsWith('192.168.') ||
          ip.startsWith('10.') ||
          /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
        ) {
          if (!preferred.includes(url)) preferred.push(url)
        } else if (!others.includes(url)) {
          others.push(url)
        }
      }
    }
  } catch {
    // ignore networkInterfaces errors in restricted sandboxes
  }
  return [...preferred, ...others]
}

export function formatStartupBanner({
  host = '0.0.0.0',
  port = 8080,
  publicUrl = process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '',
  token = '',
  stateFile = resolveDefaultStateFile(),
  lanOrigins = detectLanOrigins(port),
} = {}) {
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host
  const normalizedPublic = publicUrl
    ? publicUrl.startsWith('http')
      ? publicUrl
      : `https://${publicUrl}`
    : `http://${displayHost}:${port}`
  const lines = [
    '============================================================',
    '🚀 DSH Remote Control 控制台已启动',
    `🌐 本机访问: ${normalizedPublic}`,
  ]
  if (!publicUrl && Array.isArray(lanOrigins) && lanOrigins.length > 0) {
    lines.push(`📡 局域网地址: ${lanOrigins.join(' / ')} （手机连同一 Wi-Fi 可直接访问/扫码）`)
  }
  const isProdLog = process.env.NODE_ENV === 'production'
  const displayToken = !token
    ? '(未设置)'
    : isProdLog
      ? `${String(token).slice(0, 4)}••••${String(token).slice(-4)} (已脱敏)`
      : token
  lines.push(
    `🔑 管理密码: ${displayToken}`,
    `💾 数据存储: ${stateFile}`,
    '------------------------------------------------------------',
    '👉 首次使用 3 步闭环：',
    `   ① 在电脑浏览器打开 ${normalizedPublic} ，输入上方管理密码登录`,
    '   ② 复制页面上的「添加电脑」一行安装命令到终端执行（自动接入并刷新）',
    '   ③ 点页面上的「📱 手机扫码登录」，用手机相机扫码即可免输密码遥控',
    '============================================================',
  )
  return lines.join('\n')
}

function resolveBuildInfo(startedAt = Date.now()) {
  let version = '0.2.0'
  let uiBuild = 'dev'
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'))
    if (pkg?.version) version = String(pkg.version)
  } catch {
    // ignore missing package.json
  }
  try {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8')
    const m = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(html)
    if (m?.[1]) uiBuild = m[1]
  } catch {
    // ignore missing index.html
  }
  return { version, uiBuild, startedAt }
}

export function createHubServer({
  hub = new HubCore({ stateFile: process.env.HUB_STATE_FILE || '' }),
  token = process.env.HUB_TOKEN || process.env.FEISHU_HUB_TOKEN || '',
  requireToken = false,
  trustProxy,
  logger = console,
  voiceVaultFile,
  voiceVaultSecret = process.env.VOICE_VAULT_SECRET || '',
  voiceFetch = globalThis.fetch,
  sseMaxLifetimeMs = Number(process.env.HUB_SSE_MAX_LIFETIME_MS) || 240_000,
  sseMinIntervalMs = Number.isFinite(Number(process.env.HUB_SSE_MIN_INTERVAL_MS))
    ? Number(process.env.HUB_SSE_MIN_INTERVAL_MS)
    : 80,
} = {}) {
  let expectedToken = String(token ?? '').trim()
  if (requireToken) {
    const check = validateHubStartupToken(expectedToken)
    if (!check.ok) {
      throw new Error(check.error)
    }
  }
  const buildInfo = resolveBuildInfo(hub.now ? hub.now() : Date.now())
  hub.buildInfo = buildInfo
  hub.setTokenSecret?.(expectedToken)

  const resolvedVoiceVaultFile =
    voiceVaultFile !== undefined
      ? String(voiceVaultFile || '').trim()
      : String(process.env.VOICE_VAULT_FILE || '').trim() ||
      (hub.stateFile ? join(dirname(hub.stateFile), 'voice-vault.enc.json') : '')
  const voiceVault = new VoiceVault({
    vaultFile: resolvedVoiceVaultFile,
    secret: voiceVaultSecret,
    now: hub.now,
  })
  void voiceVault.init()
  const voiceCopilot = new VoiceCopilotEngine({
    hub,
    vault: voiceVault,
    fetchImpl: voiceFetch,
    now: hub.now,
  })

  const authVerifyFailBuckets = new Map()
  const AUTH_VERIFY_WINDOW_MS = 60_000
  const AUTH_VERIFY_MAX_FAILS = 10
  const apiAuthFailBuckets = new Map()
  const API_AUTH_FAIL_WINDOW_MS = 60_000
  const API_AUTH_MAX_FAILS = 30
  let activeAdminSseCount = 0
  const activeHostSseCounts = new Map()

  function checkApiAuthRateLimited(clientIp, nowMs = hub.now ? hub.now() : Date.now()) {
    const key = String(clientIp || 'unknown')
    const prev = (apiAuthFailBuckets.get(key) || []).filter(ts => nowMs - ts < API_AUTH_FAIL_WINDOW_MS)
    if (prev.length >= API_AUTH_MAX_FAILS) {
      apiAuthFailBuckets.set(key, prev)
      return true
    }
    return false
  }

  function recordApiAuthFailure(clientIp, nowMs = hub.now ? hub.now() : Date.now()) {
    const key = String(clientIp || 'unknown')
    const prev = (apiAuthFailBuckets.get(key) || []).filter(ts => nowMs - ts < API_AUTH_FAIL_WINDOW_MS)
    prev.push(nowMs)
    apiAuthFailBuckets.set(key, prev)
    if (apiAuthFailBuckets.size > 2000) {
      const oldestKey = apiAuthFailBuckets.keys().next().value
      apiAuthFailBuckets.delete(oldestKey)
    }
    return prev.length
  }

  function resolveHostOrAdminIdentity(headers = {}, urlObj, hostId = '', { allowPending = false } = {}) {
    if (checkAuth(headers, urlObj)) {
      return { ok: true, isAdmin: true, authHostId: String(hostId || '').trim() }
    }
    const candidate = extractCandidateToken(headers, urlObj)
    if (!candidate) return { ok: false, isAdmin: false, authHostId: '' }
    const cleanClaimed = String(hostId || '').trim()
    if (cleanClaimed) {
      if (hub.verifyHostCredential(cleanClaimed, candidate, { allowPending })) {
        return { ok: true, isAdmin: false, authHostId: cleanClaimed }
      }
      return { ok: false, isAdmin: false, authHostId: '' }
    }
    const resolvedId = hub.resolveAuthenticatedHostId(candidate, '')
    if (resolvedId) {
      return { ok: true, isAdmin: false, authHostId: resolvedId }
    }
    return { ok: false, isAdmin: false, authHostId: '' }
  }

  function extractCandidateToken(headers = {}, urlObj) {
    const authHeader = String(headers.authorization ?? headers.Authorization ?? '').trim()
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : ''
    const headerToken = String(headers['x-hub-token'] ?? headers['X-Hub-Token'] ?? '').trim()
    const queryToken = urlObj ? String(urlObj.searchParams.get('token') ?? '').trim() : ''
    return bearer || headerToken || queryToken
  }

  function checkMasterToken(headers = {}, urlObj) {
    if (!expectedToken) return !requireToken
    const candidate = extractCandidateToken(headers, urlObj)
    if (!candidate) return false
    const a = Buffer.from(candidate)
    const b = Buffer.from(expectedToken)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  function getAuthenticatedDevice(headers = {}, urlObj) {
    const candidate = extractCandidateToken(headers, urlObj)
    if (!candidate || !candidate.startsWith('dev_')) return null
    return hub.verifyTrustedDeviceToken?.(candidate) || null
  }

  function checkAuth(headers = {}, urlObj) {
    if (!expectedToken) return !requireToken
    if (getAuthenticatedDevice(headers, urlObj)) return true
    if (hub.deviceApprovalEnabled && hub.trustedDevices?.size > 0) {
      return false
    }
    return checkMasterToken(headers, urlObj)
  }

  function checkHostOrAdminAuth(headers = {}, urlObj, hostId = '', { allowPending = false } = {}) {
    const isAdminAllowed = hub.deviceApprovalEnabled
      ? Boolean(getAuthenticatedDevice(headers, urlObj))
      : checkAuth(headers, urlObj)
    if (isAdminAllowed) return true
    const candidate = extractCandidateToken(headers, urlObj)
    if (!candidate) return false
    if (hostId) {
      return hub.verifyHostCredential(hostId, candidate, { allowPending })
    }
    for (const h of hub.hosts.values()) {
      if (hub.verifyHostCredential(h.hostId, candidate, { allowPending })) {
        return true
      }
    }
    return false
  }

  function checkMediaOrAdminAuth(headers = {}, urlObj) {
    if (checkAuth(headers, urlObj)) return true
    const mt = urlObj ? String(urlObj.searchParams.get('mt') ?? '').trim() : ''
    if (mt && hub.verifyMediaTicket(mt)) return true
    return false
  }

  async function dispatchRequest({
    method = 'GET',
    url = '/',
    headers = {},
    body = {},
    rawBuffer = null,
    rawStream = null,
    remoteAddress = '',
    signal = null,
  }) {
    const protoHeader = String(headers['x-forwarded-proto'] ?? headers['X-Forwarded-Proto'] ?? '')
      .split(',')[0]
      .trim()
    const scheme = protoHeader === 'https' ? 'https' : 'http'
    const urlObj = new URL(url || '/', `${scheme}://${headers.host || 'localhost'}`)
    const pathname = urlObj.pathname

    const readMethod = method === 'HEAD' ? 'GET' : method

    if (method === 'OPTIONS') {
      return { status: 204, headers: { 'cache-control': 'no-store' }, body: '' }
    }

    if (readMethod === 'GET' && (pathname === '/healthz' || pathname === '/ready' || pathname === '/api/health')) {
      const cleanClient = resolveClientIp(headers, remoteAddress, {
        ...(trustProxy !== undefined ? { trustProxy } : {}),
      })
      const hasProxyHeaders = Boolean(headers['x-forwarded-for'] || headers['x-real-ip'] || headers['cf-connecting-ip'])
      const isLocalProbe = !hasProxyHeaders && (cleanClient === '127.0.0.1' || cleanClient === '::1')
      const showExtended = isLocalProbe || checkAuth(headers, urlObj)
      return {
        status: 200,
        json: showExtended
          ? {
            ok: true,
            status: 'ok',
            build: buildInfo,
            activeHostId: hub.activeHostId,
            hostsCount: hub.hosts.size,
            snapshotsCount: hub.snapshots.size,
            sharesCount: hub.shares.size,
          }
          : {
            ok: true,
            status: 'ok',
            build: buildInfo,
          },
      }
    }

    if (readMethod === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const entry = await readStaticTextPrecompressed(INDEX_HTML_PATH)
      const m = /assets\/index-([A-Za-z0-9_-]+)\.js/.exec(entry.text)
      if (m?.[1]) buildInfo.uiBuild = m[1]
      return {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          vary: 'Accept-Encoding',
        },
        body: entry.text,
        precompressed: entry,
      }
    }

    if (readMethod === 'GET' && pathname.startsWith('/assets/')) {
      const rel = pathname.slice('/assets/'.length)
      if (!rel || rel.includes('..') || rel.includes('/')) {
        return {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          body: 'Not found',
        }
      }
      const assetsDir = join(__dirname, 'public', 'assets')
      const contentType = rel.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : rel.endsWith('.js')
          ? 'application/javascript; charset=utf-8'
          : rel.endsWith('.svg')
            ? 'image/svg+xml; charset=utf-8'
            : rel.endsWith('.png')
              ? 'image/png'
              : rel.endsWith('.ico')
                ? 'image/x-icon'
                : rel.endsWith('.woff2')
                  ? 'font/woff2'
                  : 'application/octet-stream'
      const isTextAsset = rel.endsWith('.css') || rel.endsWith('.js') || rel.endsWith('.svg')
      try {
        const assetPath = join(assetsDir, rel)
        if (isTextAsset) {
          const entry = await readStaticTextPrecompressed(assetPath)
          return {
            status: 200,
            headers: {
              'content-type': contentType,
              'cache-control': 'public, max-age=31536000, immutable',
              vary: 'Accept-Encoding',
            },
            body: entry.text,
            precompressed: entry,
          }
        }
        const buf = await readFile(assetPath)
        return {
          status: 200,
          headers: {
            'content-type': contentType,
            'content-length': String(buf.length),
            'cache-control': 'public, max-age=31536000, immutable',
          },
          buffer: method === 'HEAD' ? Buffer.alloc(0) : buf,
        }
      } catch {
        // Zero-white-screen deploy fallback: if an open mobile tab requests a just-rotated
        // `/assets/index-<oldHash>.js` or `.css`, serve the active bundle with `no-store`
        // so neither browser nor CDN caches the mismatched hash while keeping the tab alive.
        const staleIndexMatch = /^index-[A-Za-z0-9_-]+\.(js|css)$/.exec(rel)
        if (staleIndexMatch) {
          try {
            const ext = `.${staleIndexMatch[1]}`
            const files = await readdir(assetsDir)
            const currentName = files.find(f => f.startsWith('index-') && f.endsWith(ext))
            if (currentName) {
              const body = await readFile(join(assetsDir, currentName), 'utf8')
              return {
                status: 200,
                headers: {
                  'content-type': contentType,
                  'cache-control': 'no-store',
                },
                body,
              }
            }
          } catch { }
        }
        return {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          body: 'Asset not found',
        }
      }
    }

    // PWA Web App Manifest for iPhone / Android Home Screen installation
    if (readMethod === 'GET' && pathname === '/manifest.json') {
      return {
        status: 200,
        headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' },
        body: JSON.stringify({
          name: 'DSH 远控 · 全功能总控中心',
          short_name: 'DSH 远控',
          description: 'DeepSeek Harness 飞书多机切换、远程对话、文件浏览与 iPhone 锁屏推送总控 App',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#f8fafc',
          theme_color: '#ffffff',
          icons: [
            {
              src: '/icon-192.png?v=0.8.0',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icon-512.png?v=0.8.0',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
            {
              src: '/apple-touch-icon.png?v=0.8.0',
              sizes: '180x180',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: '/icon.svg?v=0.8.0',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any',
            },
          ],
        }, null, 2),
      }
    }

    // Native Raster PNG Icons for iOS Home Screen (`apple-touch-icon.png` MUST be real PNG, never SVG)
    const PNG_ICON_ROUTES = {
      '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
      '/apple-touch-icon-precomposed.png': { file: 'apple-touch-icon.png', type: 'image/png' },
      '/apple-touch-icon-180x180.png': { file: 'apple-touch-icon.png', type: 'image/png' },
      '/icon-192.png': { file: 'icon-192.png', type: 'image/png' },
      '/icon-512.png': { file: 'icon-512.png', type: 'image/png' },
      '/favicon-32x32.png': { file: 'favicon-32x32.png', type: 'image/png' },
      '/favicon.ico': { file: 'favicon.ico', type: 'image/x-icon' },
    }
    if (readMethod === 'GET' && Object.prototype.hasOwnProperty.call(PNG_ICON_ROUTES, pathname)) {
      const spec = PNG_ICON_ROUTES[pathname]
      for (const candidateDir of [join(__dirname, 'public'), join(__dirname, 'web', 'public')]) {
        try {
          const buf = await readFile(join(candidateDir, spec.file))
          return {
            status: 200,
            headers: {
              'content-type': spec.type,
              'content-length': String(buf.length),
              'cache-control': 'public, max-age=86400',
            },
            buffer: method === 'HEAD' ? Buffer.alloc(0) : buf,
          }
        } catch { }
      }
    }

    // Crisp Vector SVG App Icon
    if (readMethod === 'GET' && pathname === '/icon.svg') {
      for (const candidateSvg of [
        join(__dirname, 'public', 'icon.svg'),
        join(__dirname, '..', 'icon.svg'),
      ]) {
        try {
          const svgBody = await readFile(candidateSvg, 'utf8')
          return {
            status: 200,
            headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
            body: svgBody,
          }
        } catch { }
      }
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="#1d4ed8"/><rect x="36" y="64" width="160" height="136" rx="32" fill="#ffffff"/><path d="M72 108 L108 134 L72 160" stroke="#2563eb" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" fill="none"/><line x1="124" y1="160" x2="168" y2="160" stroke="#10b981" stroke-width="18" stroke-linecap="round"/></svg>`
      return {
        status: 200,
        headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' },
        body: fallbackSvg,
      }
    }

    // Service Worker for iOS 16.4+ / Android Web Push lock-screen notifications & deep-link click routing
    if (method === 'GET' && pathname === '/sw.js') {
      return {
        status: 200,
        headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' },
        body: renderServiceWorkerJs(buildInfo),
      }
    }

    // Standalone E2EE Encrypted Conversation Share & Replay Page (replaces go.dshtui.com/c/:id)
    const sharePageMatch = /^\/(?:share|c)\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && sharePageMatch) {
      const shareId = decodeURIComponent(sharePageMatch[1])
      const share = hub.getShare(shareId)
      if (!share) {
        return {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: '<h1>404 - 加密分享不存在或已删除</h1>',
        }
      }
      return {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        },
        body: renderShareReplayHtml(share),
      }
    }

    // Public encrypted blob endpoint for the browser E2EE replay page (contains only ciphertext + IV, never the key)
    const publicShareBlobMatch = /^\/api\/shares\/([^/]+)\/public$/.exec(pathname)
    if (method === 'GET' && publicShareBlobMatch) {
      const shareId = decodeURIComponent(publicShareBlobMatch[1])
      const share = hub.getShare(shareId)
      if (!share) return { status: 404, json: { ok: false, error: 'Share not found' } }
      return {
        status: 200,
        json: {
          ok: true,
          share: {
            id: share.id,
            title: share.title,
            hostName: share.hostName,
            messageCount: share.messageCount,
            createdAt: share.createdAt,
            ivBase64: share.ivBase64,
            ciphertextBase64: share.ciphertextBase64,
          },
        },
      }
    }

    // Self-hosted Plugin Market Catalog & Telemetry (replaces go.dshtui.com/market/index.json & /api/usage/v1)
    if (method === 'GET' && pathname === '/market/index.json') {
      return { status: 200, json: hub.getMarketCatalog() }
    }
    if (method === 'POST' && pathname === '/api/usage/v1') {
      return { status: 200, json: { ok: true, selfHosted: true } }
    }

    // One-line Host Install Script served directly from the Hub (pre-fills this Hub's origin URL)
    if (method === 'GET' && (pathname === '/install.sh' || pathname === '/connect-host.sh')) {
      const configuredPublicUrl = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
      const safeHost = /^[a-zA-Z0-9._:-]+$/.test(urlObj.host) ? urlObj.host : 'localhost:8080'
      const originUrl = /^https?:\/\/[a-zA-Z0-9._:/-]+$/.test(configuredPublicUrl)
        ? configuredPublicUrl
        : `${urlObj.protocol}//${safeHost}`
      try {
        const rawScript = await readFile(CONNECT_SCRIPT_PATH, 'utf8')
        const injected = rawScript.replace(
          'DEFAULT_HUB_URL=""',
          `DEFAULT_HUB_URL="${originUrl}"`,
        )
        return {
          status: 200,
          headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' },
          body: injected,
        }
      } catch {
        return { status: 404, body: '#!/usr/bin/env bash\necho "install script not found"\nexit 1\n' }
      }
    }

    const reqClientIp = resolveClientIp(headers, remoteAddress, {
      ...(trustProxy !== undefined ? { trustProxy } : {}),
    })
    const noteSecurityIncident = ({ kind = '', status = 401, detail = '' } = {}) => {
      const candidate = extractCandidateToken(headers, urlObj)
      const isForgedHostToken = /^hst_/i.test(candidate)
      const resolvedKind = kind || (isForgedHostToken ? 'forged_host_token' : 'unauth_api_scan')
      hub.recordSecurityEvent?.({
        kind: resolvedKind,
        ip: reqClientIp,
        method,
        path: `${pathname}${urlObj.search || ''}`,
        status,
        detail: detail || (isForgedHostToken ? '携带伪造或已吊销的 hst_ 主机令牌' : ''),
      })
    }

    // One-Time Pairing Code Exchange (allows mobile QR scan / 6-digit code login without typing HUB_TOKEN)
    if (method === 'POST' && pathname === '/api/pairing/exchange') {
      const clientKey = reqClientIp
      const outcome = hub.exchangePairingCode(body.code, { clientKey })
      if (!outcome.ok) return { status: outcome.rateLimited ? 429 : 401, json: outcome }
      // Pairing codes are generated on an already-trusted phone, so mint an approved device token when device approval is enabled (or client passes deviceId)
      if (hub.deviceApprovalEnabled || body?.deviceId) {
        const reg = hub.registerTrustedDevice({
          deviceId: body?.deviceId || '',
          name: body?.deviceName || '扫码配对设备',
          userAgent: headers['user-agent'] || '',
          ip: reqClientIp,
        })
        return {
          status: 200,
          json: {
            ...outcome,
            token: hub.deviceApprovalEnabled ? reg.deviceToken : expectedToken,
            deviceToken: reg.deviceToken,
            deviceId: reg.device.id,
          },
        }
      }
      return {
        status: 200,
        json: {
          ...outcome,
          token: expectedToken,
        },
      }
    }

    // Pending Device Login Poll (unauthenticated by design; 128-bit random requestId; one-time token delivery after phone approval)
    const devReqPollMatch = /^\/api\/auth\/device-request\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && devReqPollMatch) {
      const reqId = decodeURIComponent(devReqPollMatch[1])
      const outcome = hub.getPendingDeviceLoginStatus(reqId)
      return { status: outcome.status === 'rejected' ? 403 : outcome.status === 'expired' ? 410 : 200, json: outcome }
    }

    // Host Join by Multi-Use Time-Limited Enrollment Code (issues independent per-host token, never master HUB_TOKEN)
    if (method === 'POST' && (pathname === '/api/hosts/join' || pathname === '/api/pairing/join-host')) {
      const clientKey = resolveClientIp(headers, remoteAddress, {
        ...(trustProxy !== undefined ? { trustProxy } : {}),
      })
      const outcome = hub.joinHostWithCode({
        ...body,
        clientKey,
      })
      if (!outcome.ok) {
        return { status: outcome.statusCode || (outcome.rateLimited ? 429 : 401), json: outcome }
      }
      return {
        status: 200,
        json: outcome,
      }
    }

    if (pathname === '/api/auth/verify' && method === 'POST') {
      const clientKey = reqClientIp
      const nowMs = hub.now ? hub.now() : Date.now()
      const recentFails = (authVerifyFailBuckets.get(clientKey) || []).filter(ts => nowMs - ts < AUTH_VERIFY_WINDOW_MS)
      if (recentFails.length >= AUTH_VERIFY_MAX_FAILS) {
        authVerifyFailBuckets.set(clientKey, recentFails)
        noteSecurityIncident({ kind: 'auth_bruteforce', status: 429, detail: '登录密码爆破触发 429 限流' })
        return {
          status: 429,
          json: { ok: false, rateLimited: true, error: '尝试次数过多，请 1 分钟后再试', authRequired: Boolean(expectedToken) },
        }
      }
      const existingDev = getAuthenticatedDevice(headers, urlObj)
      if (existingDev) {
        authVerifyFailBuckets.delete(clientKey)
        return {
          status: 200,
          json: {
            ok: true,
            authRequired: Boolean(expectedToken),
            deviceApproved: true,
            deviceId: existingDev.id,
            deviceApprovalEnabled: Boolean(hub.deviceApprovalEnabled),
          },
        }
      }
      const masterOk = checkMasterToken(headers, urlObj)
      if (masterOk) {
        authVerifyFailBuckets.delete(clientKey)
        if (hub.deviceApprovalEnabled && hub.trustedDevices.size > 0) {
          const pending = hub.createPendingDeviceLogin({
            deviceId: body?.deviceId || headers['x-device-id'] || '',
            name: body?.deviceName || headers['x-device-name'] || '新浏览器设备',
            userAgent: headers['user-agent'] || '',
            ip: reqClientIp,
          })
          return {
            status: 202,
            json: {
              ok: false,
              pendingApproval: true,
              requestId: pending.requestId,
              verifyCode: pending.verifyCode,
              expiresAt: pending.expiresAt,
              authRequired: Boolean(expectedToken),
              error: '已向你的已信任手机发送登录审批请求，请核对码后在手机点击「允许登录」',
            },
          }
        }
        const reqDevId = String(body?.deviceId || headers['x-device-id'] || '').trim()
        if (reqDevId) {
          const reg = hub.registerTrustedDevice({
            deviceId: reqDevId,
            name: body?.deviceName || headers['x-device-name'] || '我的设备',
            userAgent: headers['user-agent'] || '',
            ip: reqClientIp,
          })
          return {
            status: 200,
            json: {
              ok: true,
              authRequired: Boolean(expectedToken),
              deviceToken: reg.deviceToken,
              deviceId: reg.device.id,
              deviceApprovalEnabled: Boolean(hub.deviceApprovalEnabled),
            },
          }
        }
        return {
          status: 200,
          json: { ok: true, authRequired: Boolean(expectedToken), deviceApprovalEnabled: Boolean(hub.deviceApprovalEnabled) },
        }
      }
      recentFails.push(nowMs)
      authVerifyFailBuckets.set(clientKey, recentFails)
      if (recentFails.length >= 3) {
        noteSecurityIncident({ kind: 'auth_bruteforce', status: 401, detail: `1 分钟内连续猜错密码 ${recentFails.length} 次` })
      }
      if (authVerifyFailBuckets.size > 1000) {
        const oldestKey = authVerifyFailBuckets.keys().next().value
        authVerifyFailBuckets.delete(oldestKey)
      }
      return {
        status: 401,
        json: { ok: false, authRequired: Boolean(expectedToken) },
      }
    }

    if (pathname.startsWith('/api/')) {
      if (checkApiAuthRateLimited(reqClientIp)) {
        return {
          status: 429,
          json: { ok: false, error: '请求失败次数过多，请 1 分钟后再试', rateLimited: true },
        }
      }

      // Host-level reporting endpoints accept either an authenticated Admin (dev_ token when device approval is ON)
      // or that specific host's dedicated signed hostToken (NEVER bare master HUB_TOKEN when device approval is enabled).
      if (method === 'POST' && pathname === '/api/heartbeat') {
        const targetHostId = String(body?.hostId ?? '').trim()
        const isAdminDevice = Boolean(getAuthenticatedDevice(headers, urlObj))
        const isAdminReq = hub.deviceApprovalEnabled ? isAdminDevice : checkAuth(headers, urlObj)
        if (!isAdminReq && (!targetHostId || !checkHostOrAdminAuth(headers, urlObj, targetHostId, { allowPending: true }))) {
          recordApiAuthFailure(reqClientIp)
          if (hub.deviceApprovalEnabled && checkMasterToken(headers, urlObj)) {
            hub.recordSecurityEvent?.({
              kind: 'unauth_api_scan',
              severity: 'high',
              ip: reqClientIp,
              method,
              path: pathname,
              status: 403,
              detail: `未审批设备尝试持主密码伪造心跳 hostId=${targetHostId || 'unknown'}`,
              pushImmediately: true,
            })
            return {
              status: 403,
              json: {
                ok: false,
                code: 'DEVICE_APPROVAL_REQUIRED',
                error: '已开启手机审批保护：电脑端必须使用专属独立主机凭证（hst_...）发送心跳',
                authRequired: true,
              },
            }
          }
          noteSecurityIncident({ status: 401, detail: targetHostId ? `未授权心跳 hostId=${targetHostId}` : '未授权心跳' })
          return {
            status: 401,
            json: {
              ok: false,
              error: 'Unauthorized: valid HUB_TOKEN or active Host Token required',
              authRequired: true,
            },
          }
        }
        const candidateToken = extractCandidateToken(headers, urlObj)
        const outcome = hub.handleHeartbeat({
          ...body,
          _strictIdentityCheck: !isAdminReq,
          ...(candidateToken && targetHostId && hub.verifySignedHostToken(targetHostId, candidateToken)
            ? { presentedHostToken: candidateToken }
            : {}),
        })
        const status = outcome.ok ? 200 : outcome.code === 'DEVICE_REVOKED' || outcome.code === 'PEER_IDENTITY_MISMATCH' ? 403 : 400
        return { status, json: outcome }
      }

      const fsTunnelMatch = /^\/api\/fs-tunnel\/([^/]+)$/.exec(pathname)
      if (method === 'POST' && fsTunnelMatch) {
        const reqId = decodeURIComponent(fsTunnelMatch[1])
        let meta = {}
        const rawMetaHeader = String(headers['x-fs-meta'] ?? headers['X-Fs-Meta'] ?? '').trim()
        if (rawMetaHeader) {
          try {
            meta = JSON.parse(Buffer.from(rawMetaHeader, 'base64url').toString('utf8'))
          } catch {
            rawStream?.resume?.()
            return { status: 400, json: { ok: false, error: 'Invalid x-fs-meta header' } }
          }
        } else if (body && typeof body === 'object') {
          meta = body.meta && typeof body.meta === 'object' ? body.meta : body
        }
        const targetHostId = String(meta?.hostId ?? '').trim()
        const isAdminReq = checkAuth(headers, urlObj)
        if (!isAdminReq && (!targetHostId || !checkHostOrAdminAuth(headers, urlObj, targetHostId))) {
          recordApiAuthFailure(reqClientIp)
          rawStream?.destroy?.()
          return {
            status: 401,
            json: {
              ok: false,
              error: 'Unauthorized: valid HUB_TOKEN or active Host Token required',
              authRequired: true,
            },
          }
        }
        const isZeroBody = meta?.ok === false || Number(meta?.status) === 304
        if (isZeroBody && rawStream) {
          rawStream.resume?.()
        }
        const outcome = hub.fulfillFastFsRequest(
          reqId,
          meta,
          isZeroBody ? Buffer.alloc(0) : rawBuffer,
          isZeroBody ? null : rawStream,
        )
        if (!outcome.ok) {
          rawStream?.destroy?.()
          return { status: outcome.status || 404, json: outcome }
        }
        if (outcome.streamDone) {
          await outcome.streamDone
        }
        return { status: 200, json: { ok: true, reqId: outcome.reqId, hostId: outcome.hostId } }
      }

      const isSharedHostEndpoint =
        (method === 'POST' && pathname === '/api/shares') ||
        (method === 'POST' && pathname === '/api/snapshots') ||
        (method === 'GET' && /^\/api\/snapshots\/([^/]+)\/download$/.test(pathname)) ||
        (method === 'POST' && /^\/api\/hosts\/([^/]+)\/activate$/.test(pathname)) ||
        pathname === '/api/v1/signaling' ||
        /^\/api\/v1\/signaling\/([^/]+)$/.test(pathname) ||
        pathname === '/api/v1/turn/credentials'

      // mediaTicket is strictly limited to read-only media/preview streaming endpoints;
      // directory listing (/fs/list), text/meta reads (/fs/read), and WebRTC P2P (/fs/rtc-offer) always require Admin auth.
      const isReadOnlyMediaEndpoint =
        method === 'GET' &&
        (/^\/api\/hosts\/([^/]+)\/file-preview$/.test(pathname) ||
          /^\/api\/hosts\/([^/]+)\/fs\/stream$/.test(pathname) ||
          /^\/api\/hosts\/([^/]+)\/fs\/hls\/(?:index\.m3u8|seg_\d{5}\.ts)$/.test(pathname))

      let sharedAuth = { ok: false, isAdmin: false, authHostId: '' }
      if (isSharedHostEndpoint) {
        const claimedHostId = String(body?.hostId || body?.fromHostId || body?.meta?.hostId || '').trim()
        sharedAuth = resolveHostOrAdminIdentity(headers, urlObj, claimedHostId)
        if (!sharedAuth.ok) {
          recordApiAuthFailure(reqClientIp)
          noteSecurityIncident({ status: 401 })
          return {
            status: 401,
            json: {
              ok: false,
              error: 'Unauthorized: valid HUB_TOKEN or active Host Token required',
              authRequired: true,
            },
          }
        }
      } else if (isReadOnlyMediaEndpoint) {
        if (!checkMediaOrAdminAuth(headers, urlObj)) {
          recordApiAuthFailure(reqClientIp)
          noteSecurityIncident({ status: 401 })
          return {
            status: 401,
            json: {
              ok: false,
              error: 'Unauthorized: valid HUB_TOKEN or mediaTicket required',
              authRequired: true,
            },
          }
        }
      } else if (!checkAuth(headers, urlObj)) {
        recordApiAuthFailure(reqClientIp)
        const usedMasterWithoutApproval = Boolean(hub.deviceApprovalEnabled && checkMasterToken(headers, urlObj))
        if (usedMasterWithoutApproval) {
          hub.recordSecurityEvent?.({
            kind: 'unauth_api_scan',
            severity: 'high',
            ip: reqClientIp,
            method,
            path: pathname,
            status: 403,
            detail: '未审批设备尝试直接持管理员密码访问接口，已拦截',
            pushImmediately: true,
          })
          return {
            status: 403,
            json: {
              ok: false,
              code: 'DEVICE_APPROVAL_REQUIRED',
              error: '已开启新设备手机审批保护：请先通过登录页发起请求并在已信任手机上点击批准',
              authRequired: true,
            },
          }
        }
        noteSecurityIncident({ status: 401 })
        return {
          status: 401,
          json: {
            ok: false,
            error: 'Unauthorized: valid HUB_TOKEN required',
            authRequired: true,
          },
        }
      }

      if ((method === 'GET' || method === 'POST') && pathname === '/api/hosts/enrollment') {
        const forceNew = method === 'POST' && Boolean(body?.forceNew ?? true)
        const enrollment = hub.getOrCreateEnrollmentCode({
          forceNew,
          ...(Number(body?.ttlMs) > 0 ? { ttlMs: Number(body.ttlMs) } : {}),
        })
        return { status: 200, json: { ok: true, enrollment } }
      }

      if (method === 'POST' && pathname === '/api/auth/change-token') {
        const nextToken = String(body.newToken ?? '').trim()
        if (!nextToken || nextToken.length < 6) {
          return { status: 400, json: { ok: false, error: '新密码长度不能少于 6 位' } }
        }
        expectedToken = nextToken
        hub.setTokenSecret?.(expectedToken, { rotateSeed: true })
        return { status: 200, json: { ok: true } }
      }

      if (method === 'POST' && pathname === '/api/sessions/read') {
        const outcome = hub.markSessionRead(body || {})
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/sessions/pin') {
        const outcome = hub.setSessionPinned(body || {})
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      if (method === 'GET' && pathname === '/api/state') {
        const reqPort = Number(urlObj.port || process.env.PORT || process.env.HUB_PORT || 8080)
        const lite = urlObj.searchParams.get('lite') === '1'
        const curDev = getAuthenticatedDevice(headers, urlObj)
        const fullState = hub.getFullState({ lite })
        return {
          status: 200,
          json: {
            ok: true,
            authRequired: Boolean(expectedToken),
            currentDeviceId: curDev?.id || '',
            lanOrigins: detectLanOrigins(reqPort, { scheme }),
            ...fullState,
            accessControl: hub.getAccessControlState(curDev?.id || ''),
          },
        }
      }

      if (method === 'GET' && pathname === '/api/stats') {
        return {
          status: 200,
          json: {
            ok: true,
            stats: hub.getUsageStats(),
          },
        }
      }

      const activateMatch = /^\/api\/hosts\/([^/]+)\/activate$/.exec(pathname)
      if (method === 'POST' && activateMatch) {
        const hostId = decodeURIComponent(activateMatch[1])
        if (!sharedAuth.isAdmin) {
          const fromHostId = String(body?.fromHostId ?? '').trim()
          const isSelfActivate = sharedAuth.authHostId === hostId
          const isActiveHostHandoff =
            Boolean(fromHostId && fromHostId === sharedAuth.authHostId) &&
            (!hub.activeHostId || hub.activeHostId === sharedAuth.authHostId)
          if (!isSelfActivate && !isActiveHostHandoff) {
            return {
              status: 403,
              json: { ok: false, error: 'Forbidden: host can only activate itself or hand off active Feishu ownership' },
            }
          }
        }
        const outcome = hub.activateHost(hostId)
        return { status: outcome.ok ? 200 : 404, json: outcome }
      }

      const hostTrustMatch = /^\/api\/hosts\/([^/]+)\/trust$/.exec(pathname)
      if (method === 'POST' && hostTrustMatch) {
        const hostId = decodeURIComponent(hostTrustMatch[1])
        const outcome = hub.manageHostTrust(hostId, body)
        return { status: outcome.ok ? 200 : 404, json: outcome }
      }

      const hostCommandMatch = /^\/api\/hosts\/([^/]+)\/command$/.exec(pathname)
      if (method === 'POST' && hostCommandMatch) {
        const hostId = decodeURIComponent(hostCommandMatch[1])
        const outcome = hub.queueCommand(hostId, body)
        const status = outcome.ok ? 200 : outcome.statusCode || 404
        return { status, json: outcome }
      }

      const hostPreviewMatch = /^\/api\/hosts\/([^/]+)\/file-preview$/.exec(pathname)
      if (hostPreviewMatch) {
        const hostId = decodeURIComponent(hostPreviewMatch[1])
        if (method === 'DELETE') {
          return { status: 200, json: hub.clearFilePreview(hostId) }
        }
        if (method === 'GET') {
          const expectedAt = urlObj.searchParams.get('at')
          const expectedPath = urlObj.searchParams.get('path')
          const format = urlObj.searchParams.get('format')
          const blob = hub.getFilePreviewBlob(hostId, expectedAt, expectedPath)
          if (!blob) {
            return { status: 404, json: { ok: false, error: '文件预览已过期或不存在，请重新点击文件加载' } }
          }
          if (format === 'json') {
            return { status: 200, json: { ok: true, preview: blob } }
          }
          if (blob.dataBase64) {
            const buf = Buffer.from(blob.dataBase64, 'base64')
            const rawPreviewMime = String(blob.mime || 'application/octet-stream').toLowerCase()
            const safePreviewMime = /^(?:text\/html|application\/xhtml\+xml|text\/javascript|application\/javascript)\b/.test(rawPreviewMime)
              ? 'text/plain; charset=utf-8'
              : (blob.mime || 'application/octet-stream')
            return {
              status: 200,
              headers: {
                'content-type': safePreviewMime,
                'content-length': String(buf.length),
                'cache-control': 'private, max-age=300',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
              },
              buffer: buf,
            }
          }
          return {
            status: 200,
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'private, max-age=300',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            },
            body: String(blob.content ?? ''),
          }
        }
      }

      const hostRtcOfferMatch = /^\/api\/hosts\/([^/]+)\/fs\/rtc-offer$/.exec(pathname)
      if (method === 'POST' && hostRtcOfferMatch) {
        const hostId = decodeURIComponent(hostRtcOfferMatch[1])
        const sdp = String(body?.sdp ?? '').trim()
        if (!sdp) {
          return { status: 400, json: { ok: false, error: 'Missing SDP offer' } }
        }
        const out = await hub.dispatchFastFsRequest(
          hostId,
          {
            op: 'rtc_offer',
            sdp,
            cwd: String(body?.cwd || urlObj.searchParams.get('cwd') || ''),
            agentId: String(body?.agentId || urlObj.searchParams.get('agentId') || ''),
          },
          { timeoutMs: 8_000, signal },
        )
        return {
          status: out.ok ? 200 : out.status || 502,
          json: out.meta || { ok: false, error: 'WebRTC signaling failed' },
        }
      }

      const hostHlsMatch = /^\/api\/hosts\/([^/]+)\/fs\/hls\/(index\.m3u8|seg_\d{5}\.ts)$/.exec(pathname)
      if (method === 'GET' && hostHlsMatch) {
        const hostId = decodeURIComponent(hostHlsMatch[1])
        const hlsItem = hostHlsMatch[2]
        const reqPath = urlObj.searchParams.get('path') || ''
        const cwd = urlObj.searchParams.get('cwd') || ''
        const agentId = urlObj.searchParams.get('agentId') || ''
        const raw = urlObj.searchParams.get('raw') === '1'
        const isAdminReq = checkAuth(headers, urlObj)
        if (isBlockedHubFsPath({ cwd, path: reqPath, op: 'stream', isAdmin: isAdminReq })) {
          noteSecurityIncident({ kind: 'sensitive_path_probe', status: 403, detail: `HLS 探测敏感路径 ${cwd}/${reqPath}` })
          return {
            status: 403,
            json: { ok: false, error: '安全策略拦截：禁止远程读取敏感凭证或系统密钥路径' },
          }
        }
        const mtParam = String(urlObj.searchParams.get('mt') ?? '').trim()
        const tokenParam = String(urlObj.searchParams.get('token') ?? '').trim()
        const effectiveMt = (mtParam && hub.verifyMediaTicket(mtParam)) ? mtParam : hub.issueMediaTicket()

        if (hlsItem === 'index.m3u8') {
          const out = await hub.dispatchFastFsRequest(
            hostId,
            {
              op: 'hls_playlist',
              path: reqPath,
              cwd,
              agentId,
              raw,
            },
            { timeoutMs: 18_000, signal },
          )
          if (!out.ok || !out.meta?.m3u8) {
            return {
              status: out.status || 404,
              json: out.meta || { ok: false, error: 'HLS playlist unavailable' },
            }
          }
          const segQuery = new URLSearchParams({
            path: reqPath,
            ...(cwd ? { cwd } : {}),
            ...(agentId ? { agentId } : {}),
            ...(raw ? { raw: '1' } : {}),
            ...(effectiveMt ? { mt: effectiveMt } : tokenParam ? { token: tokenParam } : {}),
          }).toString()
          const rewrittenM3u8 = String(out.meta.m3u8).replace(
            /^(seg_\d{5}\.ts)[ \t\r]*$/gm,
            `/api/hosts/${encodeURIComponent(hostId)}/fs/hls/$1?${segQuery}`,
          )
          return {
            status: 200,
            headers: {
              'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
              ...(out.meta.mode ? { 'x-dsh-hls-mode': String(out.meta.mode) } : {}),
            },
            body: rewrittenM3u8,
          }
        }

        const out = await hub.dispatchFastFsRequest(
          hostId,
          {
            op: 'hls_segment',
            segment: hlsItem,
            path: reqPath,
            cwd,
            agentId,
            raw,
          },
          { timeoutMs: 25_000, signal },
        )
        if (!out.ok) {
          out.stream?.resume?.()
          out.onStreamDone?.()
          return {
            status: out.status || 404,
            json: out.meta || { ok: false, error: 'HLS segment failed' },
          }
        }
        const segHeaders = {
          'content-type': 'video/mp2t',
          'cache-control': 'private, max-age=3600',
          'x-accel-buffering': 'no',
          ...(out.meta?.variant ? { 'x-dsh-media-variant': String(out.meta.variant) } : {}),
        }
        if (out.stream) {
          const declaredByteLen = Number(out.meta?.byteLength)
          return {
            status: 200,
            headers: {
              ...segHeaders,
              ...(Number.isFinite(declaredByteLen) && declaredByteLen >= 0
                ? { 'content-length': String(declaredByteLen) }
                : {}),
            },
            stream: out.stream,
            onStreamDone: out.onStreamDone,
          }
        }
        const buf = out.buffer ?? Buffer.alloc(0)
        return {
          status: 200,
          headers: {
            ...segHeaders,
            'content-length': String(buf.length),
          },
          buffer: buf,
        }
      }

      const hostFsMatch = /^\/api\/hosts\/([^/]+)\/fs\/(list|read|stream)$/.exec(pathname)
      if (method === 'GET' && hostFsMatch) {
        const hostId = decodeURIComponent(hostFsMatch[1])
        const fsOp = hostFsMatch[2]
        const reqPath = urlObj.searchParams.get('path') || ''
        const cwd = urlObj.searchParams.get('cwd') || ''
        const agentId = urlObj.searchParams.get('agentId') || ''
        const isAdminReq = checkAuth(headers, urlObj)
        if (isBlockedHubFsPath({ cwd, path: reqPath, op: fsOp, isAdmin: isAdminReq })) {
          noteSecurityIncident({ kind: 'sensitive_path_probe', status: 403, detail: `FS/${fsOp} 探测敏感路径 ${cwd}/${reqPath}` })
          return {
            status: 403,
            json: { ok: false, error: '安全策略拦截：禁止远程读取敏感凭证或系统密钥路径' },
          }
        }
        const streamQuery = new URLSearchParams({
          path: reqPath,
          ...(cwd ? { cwd } : {}),
          ...(agentId ? { agentId } : {}),
        }).toString()
        const baseStreamUrl = `/api/hosts/${encodeURIComponent(hostId)}/fs/stream?${streamQuery}`

        if (fsOp === 'list') {
          const out = await hub.dispatchFastFsRequest(
            hostId,
            {
              op: 'list',
              path: reqPath,
              cwd,
              agentId,
            },
            { signal },
          )
          return {
            status: out.ok ? 200 : out.status || 502,
            json: out.meta || { ok: false, error: 'Directory list failed' },
          }
        }

        if (fsOp === 'read') {
          const cached = hub.getFsHotCache(hostId, reqPath)
          if (cached) {
            return {
              status: 200,
              json: {
                ...cached,
                hotCache: true,
                streamUrl: baseStreamUrl,
              },
            }
          }
          const out = await hub.dispatchFastFsRequest(
            hostId,
            {
              op: 'read',
              path: reqPath,
              cwd,
              agentId,
            },
            { timeoutMs: 20_000, signal },
          )
          if (
            out.ok &&
            out.meta?.kind === 'text' &&
            typeof out.meta.content === 'string' &&
            Buffer.byteLength(out.meta.content, 'utf8') <= 256 * 1024
          ) {
            hub.storeFsHotCache(hostId, reqPath, out.meta)
          }
          return {
            status: out.ok ? 200 : out.status || 404,
            json: out.meta
              ? { ...out.meta, ...(out.ok ? { streamUrl: baseStreamUrl } : {}) }
              : { ok: false, error: 'File read failed' },
          }
        }

        const thumb = urlObj.searchParams.get('thumb') === '1'
        const transcode = urlObj.searchParams.get('transcode') === '1'
        const fastPreview = urlObj.searchParams.get('preview') === '1'
        const download = urlObj.searchParams.get('download') === '1'
        const raw = urlObj.searchParams.get('raw') === '1'
        const bypassCache = Boolean(urlObj.searchParams.get('_r') || urlObj.searchParams.get('_rt'))
        const rangeHeader = String(headers.range ?? headers.Range ?? '').trim()
        const ifNoneMatch = String(headers['if-none-match'] ?? headers['If-None-Match'] ?? '').trim()
        const isVideoPath = /\.(mp4|m4v|mov|webm|ogv|mkv|avi)$/i.test(reqPath)
        const isImagePath = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif|heic|heif)$/i.test(reqPath)
        const mtParam = String(urlObj.searchParams.get('mt') ?? '').trim()
        const hasMediaTicket = Boolean(mtParam && hub.verifyMediaTicket(mtParam))
        const allowSandboxCors = hasMediaTicket && !download
        const exposeHeaders =
          'content-range, content-length, accept-ranges, etag, x-dsh-media-variant, x-dsh-thumb, x-dsh-orig-size, x-dsh-hub-cache, x-dsh-remuxed, x-dsh-transcoded, x-dsh-transcode-unavailable'
        const mediaCacheEligible = isImagePath && !rangeHeader && !download && !transcode && !fastPreview
        const mediaCacheKey = mediaCacheEligible
          ? hub.buildMediaStreamCacheKey(hostId, { cwd, path: reqPath, thumb, raw })
          : ''
        if (mediaCacheKey && !bypassCache) {
          const cachedMedia = hub.getMediaStreamCache(mediaCacheKey)
          if (cachedMedia) {
            if (ifNoneMatch && cachedMedia.etag && ifNoneMatch === cachedMedia.etag) {
              return {
                status: 304,
                headers: {
                  etag: cachedMedia.etag,
                  'accept-ranges': 'bytes',
                  'cache-control': 'private, max-age=300',
                  'x-dsh-hub-cache': '1',
                },
                body: '',
              }
            }
            return {
              status: 200,
              headers: {
                'content-type': cachedMedia.mime || 'application/octet-stream',
                'content-length': String(cachedMedia.buffer.length),
                'accept-ranges': 'bytes',
                'cache-control': 'private, max-age=300',
                'access-control-expose-headers': exposeHeaders,
                ...(allowSandboxCors ? { 'access-control-allow-origin': '*' } : {}),
                'x-dsh-hub-cache': '1',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
                ...(cachedMedia.etag ? { etag: cachedMedia.etag } : {}),
                ...(cachedMedia.variant ? { 'x-dsh-media-variant': cachedMedia.variant } : {}),
                ...(cachedMedia.isThumb ? { 'x-dsh-thumb': '1' } : {}),
                ...(cachedMedia.origSize > 0 ? { 'x-dsh-orig-size': String(cachedMedia.origSize) } : {}),
              },
              buffer: cachedMedia.buffer,
            }
          }
        }
        const out = await hub.dispatchFastFsRequest(
          hostId,
          {
            op: 'stream',
            path: reqPath,
            cwd,
            agentId,
            rangeHeader,
            ifNoneMatch,
            thumb,
            transcode,
            fastPreview,
            download,
            raw,
          },
          { timeoutMs: transcode || fastPreview || download || isVideoPath ? 60_000 : 30_000, signal },
        )
        if (out.status === 304) {
          out.stream?.resume?.()
          out.onStreamDone?.()
          return {
            status: 304,
            headers: {
              ...(out.meta?.etag ? { etag: out.meta.etag } : {}),
              'accept-ranges': 'bytes',
              'cache-control': 'private, max-age=300',
            },
            body: '',
          }
        }
        if (!out.ok) {
          out.stream?.resume?.()
          out.onStreamDone?.()
          return {
            status: out.status || 404,
            headers: {
              ...(out.meta?.contentRange ? { 'content-range': out.meta.contentRange } : {}),
              'accept-ranges': 'bytes',
            },
            json: out.meta || { ok: false, error: 'File stream failed' },
          }
        }
        const rawStreamMime = String(out.meta?.mime || 'application/octet-stream')
        const isActiveHtmlMime = /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)\b/i.test(rawStreamMime)
        const safeStreamMime = !download && isActiveHtmlMime ? 'text/plain; charset=utf-8' : rawStreamMime
        const commonMediaHeaders = {
          'content-type': safeStreamMime,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=300',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
          'access-control-expose-headers': exposeHeaders,
          ...(allowSandboxCors ? { 'access-control-allow-origin': '*' } : {}),
          ...(out.meta?.etag ? { etag: out.meta.etag } : {}),
          ...(out.meta?.contentRange ? { 'content-range': out.meta.contentRange } : {}),
          ...(out.meta?.variant ? { 'x-dsh-media-variant': String(out.meta.variant) } : {}),
          ...(out.meta?.isThumb ? { 'x-dsh-thumb': '1' } : {}),
          ...(Number(out.meta?.origSize) > 0 ? { 'x-dsh-orig-size': String(Number(out.meta.origSize)) } : {}),
          ...(out.meta?.remuxed ? { 'x-dsh-remuxed': '1' } : {}),
          ...(out.meta?.transcoded ? { 'x-dsh-transcoded': '1' } : {}),
          ...(out.meta?.transcodeUnavailable ? { 'x-dsh-transcode-unavailable': '1' } : {}),
          ...(download && out.meta?.name
            ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.meta.name)}` }
            : {}),
        }
        const shouldCacheImageResponse =
          Boolean(mediaCacheKey) &&
          (out.status || 200) === 200 &&
          String(out.meta?.mime || '').toLowerCase().startsWith('image/')
        if (out.stream) {
          const declaredByteLen = Number(out.meta?.byteLength)
          const canTeeCache =
            shouldCacheImageResponse &&
            Number.isFinite(declaredByteLen) &&
            declaredByteLen > 0 &&
            declaredByteLen <= HUB_MEDIA_CACHE_MAX_ITEM_BYTES
          return {
            status: out.status || 200,
            headers: {
              ...commonMediaHeaders,
              ...(Number.isFinite(declaredByteLen) && declaredByteLen >= 0
                ? { 'content-length': String(declaredByteLen) }
                : {}),
            },
            stream: out.stream,
            onStreamDone: out.onStreamDone,
            ...(canTeeCache
              ? {
                expectedBytes: declaredByteLen,
                onCompleteBuffer: fullBuf => {
                  hub.storeMediaStreamCache(mediaCacheKey, {
                    buffer: fullBuf,
                    mime: out.meta?.mime || 'image/jpeg',
                    etag: out.meta?.etag || '',
                    name: out.meta?.name || '',
                    variant: out.meta?.variant || '',
                    isThumb: Boolean(out.meta?.isThumb),
                    origSize: Number(out.meta?.origSize) || 0,
                  })
                },
              }
              : {}),
          }
        }
        const buf = out.buffer ?? Buffer.from(out.meta?.content ?? '', 'utf8')
        if (shouldCacheImageResponse && buf.length > 0 && buf.length <= HUB_MEDIA_CACHE_MAX_ITEM_BYTES) {
          hub.storeMediaStreamCache(mediaCacheKey, {
            buffer: buf,
            mime: out.meta?.mime || 'image/jpeg',
            etag: out.meta?.etag || '',
            name: out.meta?.name || '',
            variant: out.meta?.variant || '',
            isThumb: Boolean(out.meta?.isThumb),
            origSize: Number(out.meta?.origSize) || 0,
          })
        }
        return {
          status: out.status || 200,
          headers: {
            ...commonMediaHeaders,
            'content-length': String(buf.length),
          },
          buffer: buf,
        }
      }

      const sessTranscriptMatch = /^\/api\/hosts\/([^/]+)\/sessions\/([^/]+)\/transcript$/.exec(pathname)
      if (method === 'GET' && sessTranscriptMatch) {
        const hostId = decodeURIComponent(sessTranscriptMatch[1])
        const agentId = decodeURIComponent(sessTranscriptMatch[2])
        const compact = urlObj.searchParams.get('compact') === '1'
        const full = hub.getSessionFullTranscript(hostId, agentId, { compact })
        if (!full) {
          return { status: 404, json: { ok: false, error: 'Session transcript not found' } }
        }
        return { status: 200, json: full }
      }

      const cmdCancelMatch = /^\/api\/commands\/([^/]+)\/cancel$/.exec(pathname)
      if (method === 'POST' && cmdCancelMatch) {
        const cmdId = decodeURIComponent(cmdCancelMatch[1])
        const outcome = hub.cancelCommand(cmdId)
        return { status: outcome.ok ? 200 : 404, json: outcome }
      }

      const cmdResultMatch = /^\/api\/commands\/([^/]+)$/.exec(pathname)
      if (method === 'DELETE' && cmdResultMatch) {
        const cmdId = decodeURIComponent(cmdResultMatch[1])
        const outcome = hub.cancelCommand(cmdId)
        return { status: outcome.ok ? 200 : 404, json: outcome }
      }
      if (method === 'GET' && cmdResultMatch) {
        const cmdId = decodeURIComponent(cmdResultMatch[1])
        const result = hub.getCommandResult(cmdId)
        return { status: 200, json: { ok: true, ready: Boolean(result), result } }
      }

      const hostDeleteMatch = /^\/api\/hosts\/([^/]+)$/.exec(pathname)
      if (method === 'DELETE' && hostDeleteMatch) {
        const hostId = decodeURIComponent(hostDeleteMatch[1])
        const outcome = hub.removeHost(hostId)
        return { status: 200, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/pairing/create') {
        const pairing = hub.createPairingCode(body)
        const reqPort = Number(urlObj.port || process.env.PORT || process.env.HUB_PORT || 8080)
        return {
          status: 200,
          json: {
            ok: true,
            pairing,
            code: pairing.code,
            expiresAt: pairing.expiresAt,
            lanOrigins: detectLanOrigins(reqPort, { scheme }),
          },
        }
      }

      // W3C Web Push + VAPID Endpoints for iPhone (iOS 16.4+) / Android Home Screen App
      if (method === 'GET' && pathname === '/api/push/vapid-public-key') {
        return {
          status: 200,
          json: {
            ok: true,
            publicKey: hub.getVapidPublicKey(),
          },
        }
      }

      if (method === 'POST' && pathname === '/api/push/subscribe') {
        const outcome = hub.addPushSubscription({
          subscription: body.subscription || body,
          deviceName: body.deviceName || 'iPhone 主屏幕 App',
          userAgent: headers['user-agent'] || '',
        })
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/push/unsubscribe') {
        const outcome = hub.removePushSubscription(body.id || body.endpoint)
        return { status: 200, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/push/test') {
        const outcome = await hub.broadcastWebPush({
          title: body.title || '🔔 DSH iPhone 锁屏推送已激活！',
          body: body.body || '当任意电脑有工具待审批、任务完成或异常时，你会立即收到这样的系统级锁屏通知。',
          tag: 'dsh-push-test',
          badgeCount: 1,
          data: {
            type: 'test',
            hostId: hub.activeHostId || '',
            url: '/',
          },
        })
        return { status: 200, json: outcome }
      }

      // BYOK Voice Copilot & Walking Headphones Mode APIs (strictly behind admin HUB_TOKEN)
      if (pathname.startsWith('/api/voice/')) {
        await voiceVault.init()

        if (method === 'GET' && pathname === '/api/voice/config') {
          const voiceSessionId = urlObj.searchParams.get('sessionId') || 'default'
          return {
            status: 200,
            json: {
              ok: true,
              ...voiceVault.toPublicState(),
              activePin: voiceCopilot.getActivePinChallenge(voiceSessionId),
            },
          }
        }

        if (method === 'POST' && pathname === '/api/voice/credentials') {
          const outcome = await voiceVault.upsertCredential(body || {})
          return { status: outcome.ok ? 200 : 400, json: outcome }
        }

        const voiceCredDeleteMatch = /^\/api\/voice\/credentials\/([^/]+)$/.exec(pathname)
        if (method === 'DELETE' && (pathname === '/api/voice/credentials' || voiceCredDeleteMatch)) {
          const targetId = voiceCredDeleteMatch
            ? decodeURIComponent(voiceCredDeleteMatch[1])
            : String(body?.id || urlObj.searchParams.get('id') || '').trim()
          const outcome = await voiceVault.deleteCredential(targetId)
          return { status: outcome.ok ? 200 : 404, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/credentials/activate') {
          const outcome = await voiceVault.activateCredential(body?.id || '')
          return { status: outcome.ok ? 200 : 404, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/profiles') {
          const outcome = await voiceVault.upsertProfile(body || {})
          return { status: outcome.ok ? 200 : 400, json: outcome }
        }

        const voiceProfileDeleteMatch = /^\/api\/voice\/profiles\/([^/]+)$/.exec(pathname)
        if (method === 'DELETE' && (pathname === '/api/voice/profiles' || voiceProfileDeleteMatch)) {
          const targetId = voiceProfileDeleteMatch
            ? decodeURIComponent(voiceProfileDeleteMatch[1])
            : String(body?.id || urlObj.searchParams.get('id') || '').trim()
          const outcome = await voiceVault.deleteProfile(targetId)
          return { status: outcome.ok ? 200 : 400, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/prefs') {
          const outcome = await voiceVault.updatePrefs(body || {})
          return { status: outcome.ok ? 200 : 400, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/test') {
          const outcome = await voiceCopilot.testCredential(body || {})
          return { status: outcome.ok ? 200 : 502, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/stt') {
          const outcome = await voiceCopilot.runStt(body || {})
          return { status: outcome.ok ? 200 : 502, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/turn') {
          const outcome = await voiceCopilot.runBrainTurn(body || {})
          return { status: outcome.ok ? 200 : 502, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/tts') {
          const outcome = await voiceCopilot.runTts(body || {})
          return { status: outcome.ok ? 200 : 502, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/briefing') {
          const outcome = await voiceCopilot.buildProactiveBriefing(body || {})
          return { status: outcome.ok ? 200 : 404, json: outcome }
        }

        if (method === 'POST' && pathname === '/api/voice/pin/clear') {
          voiceCopilot.pinStore.clear(body?.sessionId || 'default')
          return { status: 200, json: { ok: true } }
        }
      }

      // Real-time Security & Intrusion Monitor endpoints (strictly behind admin HUB_TOKEN)
      if (method === 'GET' && pathname === '/api/security/events') {
        return {
          status: 200,
          json: {
            ok: true,
            securitySummary: hub.getSecuritySummary(),
          },
        }
      }

      if (method === 'POST' && pathname === '/api/security/clear') {
        return {
          status: 200,
          json: hub.clearSecurityEvents(),
        }
      }

      if (method === 'POST' && pathname === '/api/security/test-alert') {
        const out = hub.recordSecurityEvent({
          kind: 'forged_host_token',
          severity: 'high',
          ip: reqClientIp,
          method: 'POST',
          path: '/api/security/test-alert',
          status: 401,
          detail: '手动触发的安全入侵告警演练',
          pushImmediately: true,
        })
        return {
          status: 200,
          json: { ok: true, ...out, securitySummary: hub.getSecuritySummary() },
        }
      }

      if (method === 'POST' && pathname === '/api/security/device-approval') {
        const curDev = getAuthenticatedDevice(headers, urlObj)
        const outcome = hub.setDeviceApprovalEnabled(Boolean(body?.enabled), {
          deviceId: curDev?.id || body?.deviceId || headers['x-device-id'] || '',
          name: body?.deviceName || headers['x-device-name'] || curDev?.name || '我的信任手机',
          userAgent: headers['user-agent'] || '',
          ip: reqClientIp,
        })
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/security/device-login/decide') {
        const outcome = hub.decidePendingDeviceLogin(body?.requestId || '', body?.allow !== false)
        return { status: outcome.ok ? 200 : 404, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/security/devices/revoke') {
        const outcome = hub.revokeTrustedDevice(body?.deviceId || '')
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/security/host-join/decide') {
        const outcome = hub.decidePendingHostJoin(body?.hostId || '', body?.allow !== false)
        return { status: outcome.ok ? 200 : 404, json: outcome }
      }

      // SSE fallback for in-memory fetchAdapter testing
      if (method === 'GET' && pathname === '/api/events') {
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
          body: `event: state\ndata: ${JSON.stringify({ ok: true, ...hub.getFullState() })}\n\n`,
        }
      }

      // Self-hosted WebRTC Signaling & TURN Credentials (strictly scoped by authenticated host identity)
      if (method === 'POST' && pathname === '/api/v1/signaling') {
        const safePayload = sharedAuth.isAdmin
          ? body
          : { ...body, fromId: sharedAuth.authHostId }
        const outcome = hub.postSignalingMessage(safePayload)
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      const sigPullMatch = /^\/api\/v1\/signaling\/([^/]+)$/.exec(pathname)
      if (method === 'GET' && sigPullMatch) {
        const targetId = decodeURIComponent(sigPullMatch[1])
        if (!sharedAuth.isAdmin && targetId !== sharedAuth.authHostId) {
          return { status: 403, json: { ok: false, error: 'Forbidden: host can only read its own signaling mailbox' } }
        }
        return { status: 200, json: hub.pullSignalingMessages(targetId) }
      }

      if ((method === 'GET' || method === 'POST') && pathname === '/api/v1/turn/credentials') {
        const ttlOverride = body && typeof body === 'object' && body.ttlSeconds !== undefined
          ? { ttlSeconds: body.ttlSeconds }
          : {}
        return { status: 200, json: hub.getTurnCredentials(ttlOverride) }
      }

      // Self-hosted E2EE Conversation Share API (replaces go.dshtui.com/api/shares)
      if (method === 'POST' && pathname === '/api/shares') {
        const safeShareBody = sharedAuth.isAdmin
          ? body
          : { ...body, hostId: sharedAuth.authHostId }
        const share = hub.createShare(safeShareBody)
        return { status: 200, json: { ok: true, share } }
      }

      if (method === 'GET' && pathname === '/api/shares') {
        return { status: 200, json: { ok: true, shares: hub.listShares() } }
      }

      const shareItemMatch = /^\/api\/shares\/([^/]+)$/.exec(pathname)
      if (method === 'GET' && shareItemMatch) {
        const shareId = decodeURIComponent(shareItemMatch[1])
        const share = hub.getShare(shareId)
        if (!share) return { status: 404, json: { ok: false, error: 'Share not found' } }
        return { status: 200, json: { ok: true, share } }
      }
      if (method === 'DELETE' && shareItemMatch) {
        const shareId = decodeURIComponent(shareItemMatch[1])
        return { status: 200, json: hub.deleteShare(shareId) }
      }

      if (method === 'POST' && pathname === '/api/migrate') {
        const outcome = hub.startMigration(body)
        return { status: outcome.ok ? 200 : 400, json: outcome }
      }

      if (method === 'POST' && pathname === '/api/snapshots') {
        const snapshot = hub.addSnapshot({
          ...body,
          authHostId: sharedAuth.isAdmin ? '' : sharedAuth.authHostId,
        })
        return { status: 200, json: { ok: true, snapshot } }
      }

      const snapDownloadMatch = /^\/api\/snapshots\/([^/]+)\/download$/.exec(pathname)
      if (method === 'GET' && snapDownloadMatch) {
        const snapshotId = decodeURIComponent(snapDownloadMatch[1])
        const snap = hub.getSnapshot(snapshotId)
        if (!snap) return { status: 404, json: { ok: false, error: 'Snapshot not found' } }
        if (!sharedAuth.isAdmin) {
          const isOwner = snap.meta?.hostId && snap.meta.hostId === sharedAuth.authHostId
          const isMigrationTarget = [...(hub.migrations?.values?.() || [])].some(
            job => job?.snapshotId === snapshotId && job?.targetHostId === sharedAuth.authHostId,
          )
          if (!isOwner && !isMigrationTarget) {
            return { status: 403, json: { ok: false, error: 'Forbidden: snapshot belongs to another host' } }
          }
        }
        const buf = Buffer.from(snap.dataBase64, 'base64')
        return {
          status: 200,
          headers: {
            'content-type': 'application/gzip',
            'content-length': String(buf.length),
            'content-disposition': `attachment; filename="${snapshotId}.dshsnap.gz"`,
            'x-content-type-options': 'nosniff',
          },
          buffer: buf,
        }
      }

      const snapDeleteMatch = /^\/api\/snapshots\/([^/]+)$/.exec(pathname)
      if (method === 'DELETE' && snapDeleteMatch) {
        const snapshotId = decodeURIComponent(snapDeleteMatch[1])
        return { status: 200, json: hub.deleteSnapshot(snapshotId) }
      }

      return { status: 404, json: { ok: false, error: 'Not found' } }
    }

    return { status: 404, json: { ok: false, error: 'Not found' } }
  }

  const server = createServer(async (req, res) => {
    req.on('error', () => { })
    res.on('error', () => { })
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (req.method === 'GET' && urlObj.pathname === '/api/events') {
        const isAdminReq = checkAuth(req.headers, urlObj)
        const requestedHostId = String(urlObj.searchParams.get('hostId') || '').trim()
        const isHostModeRequested =
          urlObj.searchParams.get('mode') === 'host' ||
          /^node\b/i.test(String(req.headers['user-agent'] || ''))

        let isHostMode = isHostModeRequested
        let watchHostId = requestedHostId
        if (!isAdminReq) {
          const candidateToken = extractCandidateToken(req.headers, urlObj)
          const authHostId = hub.resolveAuthenticatedHostId(candidateToken, requestedHostId)
          // Host tokens may NEVER subscribe to the admin full-state SSE stream (which includes
          // mediaTicket, enrollment code, and all connected hosts). They may ONLY open mode=host
          // strictly scoped to their own hostId.
          if (!isHostModeRequested || !authHostId) {
            const sseClientIp = resolveClientIp(req.headers, req.socket?.remoteAddress || '', {
              ...(trustProxy !== undefined ? { trustProxy } : {}),
            })
            if (checkApiAuthRateLimited(sseClientIp)) {
              await sendJson(
                res,
                429,
                { ok: false, error: '请求失败次数过多，请 1 分钟后再试', rateLimited: true },
                req.headers,
              )
              return
            }
            recordApiAuthFailure(sseClientIp)
            const isForgedHost = /^hst_/i.test(candidateToken)
            hub.recordSecurityEvent?.({
              kind: isForgedHost ? 'forged_host_token' : 'unauth_api_scan',
              ip: sseClientIp,
              method: 'GET',
              path: `${urlObj.pathname}${urlObj.search || ''}`,
              status: 401,
              detail: isForgedHost ? 'SSE 事件流收到伪造或已吊销的 hst_ 令牌' : '未授权订阅 /api/events',
            })
            await sendJson(
              res,
              401,
              {
                ok: false,
                error: 'Unauthorized: valid HUB_TOKEN required (or mode=host with matching Host Token)',
                authRequired: true,
              },
              req.headers,
            )
            return
          }
          isHostMode = true
          watchHostId = authHostId
        }

        if (isHostMode) {
          req.socket?.setNoDelay?.(true)
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-accel-buffering': 'no',
            connection: 'keep-alive',
          })
          res.flushHeaders?.()
          let closed = false
          const safeWrite = chunk => {
            if (closed || res.writableEnded || res.destroyed) return
            try {
              res.write(chunk)
            } catch { }
          }
          safeWrite('retry: 1000\n\n')
          const sendHostWake = (targetHostId = '') => {
            const hostsLite = [...hub.hosts.values()]
              .filter(h => !targetHostId || h.hostId === targetHostId)
              .map(h => ({ hostId: h.hostId, pendingCommandsCount: (h.commands || []).length }))
            safeWrite(`event: state\ndata: ${JSON.stringify({ ok: true, mode: 'host', hosts: hostsLite })}\n\n`)
          }
          sendHostWake(watchHostId)
          const unsubscribe = hub.onHostCommand(cmdHostId => {
            if (!watchHostId || cmdHostId === watchHostId) {
              sendHostWake(cmdHostId)
            }
          })
          const unsubFs = hub.onHostFsRequest((fsHostId, fsReq) => {
            if (!watchHostId || fsHostId === watchHostId) {
              safeWrite(`event: fs_req\ndata: ${JSON.stringify(fsReq)}\n\n`)
            }
          })
          const unsubFsAbort = hub.onHostFsAbort((fsHostId, abortInfo) => {
            if (!watchHostId || fsHostId === watchHostId) {
              safeWrite(`event: fs_abort\ndata: ${JSON.stringify(abortInfo)}\n\n`)
            }
          })
          const keepAlive = setInterval(() => {
            safeWrite(`event: ping\ndata: {"ts":${Date.now()}}\n\n`)
          }, 20_000)
          keepAlive.unref?.()
          const cleanupHostSse = () => {
            if (closed) return
            closed = true
            clearInterval(keepAlive)
            if (rotateTimer) clearTimeout(rotateTimer)
            unsubscribe()
            unsubFs()
            unsubFsAbort()
          }
          const rotateTimer =
            sseMaxLifetimeMs > 0
              ? setTimeout(() => {
                safeWrite(`event: rotate\ndata: {"reason":"max_lifetime","ts":${Date.now()}}\n\n`)
                cleanupHostSse()
                try {
                  res.end()
                } catch { }
              }, sseMaxLifetimeMs)
              : null
          rotateTimer?.unref?.()
          req.on('close', cleanupHostSse)
          return
        }

        req.socket?.setNoDelay?.(true)
        // Never apply content-encoding: gzip on text/event-stream: CDN / mobile HTTP/2 proxies buffer
        // small gzip-compressed SSE frames (~200B state_delta) for several seconds until more bytes arrive!
        const outStream = res
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-store, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        })
        res.flushHeaders?.()
        let closed = false
        let lastSsePushAt = 0
        let pendingSseTimer = null
        const safeWrite = chunk => {
          if (closed || res.writableEnded || res.destroyed) return
          try {
            outStream.write(chunk)
          } catch { }
        }
        safeWrite('retry: 1000\n\n')
        const wantDelta = urlObj.searchParams.get('delta') === '1'
        const wantGranularTasks = wantDelta && urlObj.searchParams.get('tp') === '1'
        const wantResyncSignal = wantDelta && urlObj.searchParams.get('resync') === '1'
        const useLite = urlObj.searchParams.get('lite') === '1'
        const clientSeq = Number(urlObj.searchParams.get('seq') || 0)
        const getEventState = () => hub.getFullState({ lite: useLite })
        let prevDigest = null
        const sendEvent = stateData => {
          lastSsePushAt = Date.now()
          if (wantDelta) {
            prevDigest = captureStateDigest(stateData)
          }
          safeWrite(`event: state\ndata: ${JSON.stringify({ ok: true, ...stateData })}\n\n`)
        }
        const sendStateOrDelta = stateData => {
          if (!wantDelta || !prevDigest) {
            sendEvent(stateData)
            return
          }
          const { hasChanges, delta, nextDigest } = buildStateDelta(prevDigest, stateData, {
            granularTasks: wantGranularTasks,
          })
          prevDigest = nextDigest
          if (!hasChanges || !delta) return
          lastSsePushAt = Date.now()
          safeWrite(`event: state_delta\ndata: ${JSON.stringify({ ok: true, ...delta })}\n\n`)
        }
        if (urlObj.searchParams.get('initial') === '0') {
          if (wantDelta) {
            const curState = getEventState()
            if (clientSeq > 0 && clientSeq !== curState.stateSeq) {
              if (wantResyncSignal) {
                // Re-anchor server digest at current stateSeq and send a ~90B resync signal so the
                // mobile client fetches gzipped `/api/state` instead of choking on a 1.6MB raw SSE frame.
                prevDigest = captureStateDigest(curState)
                safeWrite(
                  `event: resync\ndata: {"reason":"seq_gap","clientSeq":${clientSeq},"stateSeq":${Number(curState.stateSeq) || 0},"ts":${Date.now()}}\n\n`,
                )
              } else {
                sendEvent(curState)
              }
            } else {
              prevDigest = captureStateDigest(curState)
              safeWrite(
                `event: ping\ndata: {"ts":${Date.now()},"stateSeq":${Number(curState.stateSeq) || 0}}\n\n`,
              )
            }
          } else {
            safeWrite(`event: ping\ndata: {"ts":${Date.now()}}\n\n`)
          }
        } else {
          sendEvent(getEventState())
        }
        const flushLatestState = () => {
          pendingSseTimer = null
          if (closed || res.writableEnded || res.destroyed) return
          sendStateOrDelta(getEventState())
        }
        const unsubscribe = hub.onStateChange((evt, stateData) => {
          if (closed || res.writableEnded || res.destroyed) return
          const evtName = typeof evt === 'string' ? evt : String(evt?.type || '')
          const minGap =
            evtName === 'command_queued' ||
              evtName === 'command_cancelled' ||
              evtName === 'task_concluded' ||
              evtName === 'session_pinned'
              ? Math.min(30, sseMinIntervalMs)
              : sseMinIntervalMs
          const elapsed = Date.now() - lastSsePushAt
          if (minGap <= 0 || (elapsed >= minGap && !pendingSseTimer)) {
            if (pendingSseTimer) {
              clearTimeout(pendingSseTimer)
              pendingSseTimer = null
            }
            sendStateOrDelta(useLite ? getEventState() : (stateData || getEventState()))
            return
          }
          if (!pendingSseTimer) {
            const waitMs = Math.max(16, minGap - elapsed)
            pendingSseTimer = setTimeout(flushLatestState, waitMs)
            pendingSseTimer.unref?.()
          }
        })
        const keepAlive = setInterval(() => {
          hub.checkHostLivenessTransitions()
          safeWrite(`event: ping\ndata: {"ts":${Date.now()},"stateSeq":${Number(hub.stateSeq) || 0}}\n\n`)
        }, 12_000)
        keepAlive.unref?.()
        const cleanupClientSse = () => {
          if (closed) return
          closed = true
          clearInterval(keepAlive)
          if (pendingSseTimer) {
            clearTimeout(pendingSseTimer)
            pendingSseTimer = null
          }
          if (rotateTimer) clearTimeout(rotateTimer)
          unsubscribe()
          if (outStream !== res) {
            try { outStream.end() } catch { }
          }
        }
        const rotateTimer =
          sseMaxLifetimeMs > 0
            ? setTimeout(() => {
              if (pendingSseTimer) {
                clearTimeout(pendingSseTimer)
                pendingSseTimer = null
              }
              safeWrite(`event: rotate\ndata: {"reason":"max_lifetime","ts":${Date.now()}}\n\n`)
              clearInterval(keepAlive)
              unsubscribe()
              closed = true
              try {
                outStream.end()
              } catch { }
            }, sseMaxLifetimeMs)
            : null
        rotateTimer?.unref?.()
        req.on('close', cleanupClientSse)
        return
      }

      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      const fsTunnelPathMatch =
        req.method === 'POST' ? /^\/api\/fs-tunnel\/([^/]+)$/.exec(urlObj.pathname) : null
      const isBinaryFsTunnel =
        Boolean(fsTunnelPathMatch) &&
        (contentType.includes('application/octet-stream') || Boolean(req.headers['x-fs-meta']))
      if (isBinaryFsTunnel) {
        const reqId = decodeURIComponent(fsTunnelPathMatch[1])
        const rawMetaHeader = String(req.headers['x-fs-meta'] ?? '').trim()
        let meta = {}
        if (rawMetaHeader) {
          try {
            meta = JSON.parse(Buffer.from(rawMetaHeader, 'base64url').toString('utf8'))
          } catch {
            req.resume()
            await sendJson(res, 400, { ok: false, error: 'Invalid x-fs-meta header' }, req.headers)
            return
          }
        }
        const targetHostId = String(meta?.hostId ?? '').trim()
        const isAdminReq = checkAuth(req.headers, urlObj)
        if (!isAdminReq && (!targetHostId || !checkHostOrAdminAuth(req.headers, urlObj, targetHostId))) {
          req.resume()
          await sendJson(
            res,
            401,
            {
              ok: false,
              error: 'Unauthorized: valid HUB_TOKEN or active Host Token required',
              authRequired: true,
            },
            req.headers,
          )
          return
        }
        const contentLenHeader = req.headers['content-length']
        const isZeroBody =
          meta?.ok === false ||
          Number(meta?.status) === 304 ||
          (contentLenHeader !== undefined && Number(contentLenHeader) === 0)
        if (isZeroBody) {
          req.resume()
          const outcome = hub.fulfillFastFsRequest(reqId, meta, Buffer.alloc(0))
          await sendJson(res, outcome.ok ? 200 : outcome.status || 404, outcome, req.headers)
          return
        }
        const outcome = hub.fulfillFastFsRequest(reqId, meta, null, req)
        if (!outcome.ok) {
          req.resume()
          await sendJson(res, outcome.status || 404, outcome, req.headers)
          return
        }
        const settleOnClose = () => {
          if (!req.complete) {
            outcome.onStreamDone?.()
          }
        }
        const settleOnResClose = () => {
          if (!res.writableFinished) {
            outcome.onStreamDone?.()
          }
        }
        req.once('close', settleOnClose)
        res.once('close', settleOnResClose)
        try {
          await outcome.streamDone
        } finally {
          req.removeListener('close', settleOnClose)
          res.removeListener('close', settleOnResClose)
        }
        if (!res.destroyed && !res.writableEnded) {
          await sendJson(
            res,
            200,
            { ok: true, reqId: outcome.reqId, hostId: outcome.hostId },
            req.headers,
          )
        }
        return
      }
      const clientAbortController = new AbortController()
      const abortOnClientClose = () => {
        if (!res.writableFinished) {
          clientAbortController.abort()
        }
      }
      res.once('close', abortOnClientClose)
      const routeMaxBodyBytes = getRouteMaxBodyBytes(urlObj.pathname)
      let body = {}
      if (req.method === 'POST') {
        try {
          body = await readJsonBody(req, routeMaxBodyBytes)
        } catch (bodyErr) {
          res.removeListener('close', abortOnClientClose)
          const isTooLarge = /exceeds limit|too large/i.test(String(bodyErr?.message || ''))
          await sendJson(
            res,
            isTooLarge ? 413 : 400,
            { ok: false, error: isTooLarge ? 'Request body too large' : 'Invalid JSON request body' },
            req.headers,
          )
          return
        }
      }
      const result = await dispatchRequest({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        rawBuffer: null,
        remoteAddress: req.socket?.remoteAddress || '',
        signal: clientAbortController.signal,
      }).finally(() => {
        res.removeListener('close', abortOnClientClose)
      })
      const baseSecHeaders = buildSecurityResponseHeaders(req.headers)
      if (result.json !== undefined) {
        await sendJson(res, result.status, result.json, req.headers)
      } else if (result.stream) {
        if (res.destroyed || res.writableEnded) {
          result.stream.destroy?.()
          result.onStreamDone?.()
          return
        }
        res.writeHead(result.status, { ...baseSecHeaders, ...(result.headers || {}) })
        try {
          if (typeof result.onCompleteBuffer === 'function') {
            const cacheTee = createImageCacheTransform(
              Number(result.expectedBytes) || 0,
              HUB_MEDIA_CACHE_MAX_ITEM_BYTES,
              result.onCompleteBuffer,
            )
            await pipeline(result.stream, cacheTee, res)
          } else {
            await pipeline(result.stream, res)
          }
        } catch {
          result.stream.destroy?.()
          try {
            res.end()
          } catch { }
        } finally {
          result.onStreamDone?.()
        }
      } else if (result.precompressed) {
        const acceptEncoding = String(req.headers?.['accept-encoding'] ?? req.headers?.['Accept-Encoding'] ?? '')
        const isHead = req.method === 'HEAD'
        const pre = result.precompressed
        if (pre.brBuf && /\bbr\b/i.test(acceptEncoding)) {
          res.writeHead(result.status, {
            ...baseSecHeaders,
            ...(result.headers || {}),
            'content-encoding': 'br',
            'content-length': String(pre.brBuf.length),
          })
          res.end(isHead ? Buffer.alloc(0) : pre.brBuf)
        } else if (pre.gzBuf && /\bgzip\b/i.test(acceptEncoding)) {
          res.writeHead(result.status, {
            ...baseSecHeaders,
            ...(result.headers || {}),
            'content-encoding': 'gzip',
            'content-length': String(pre.gzBuf.length),
          })
          res.end(isHead ? Buffer.alloc(0) : pre.gzBuf)
        } else {
          res.writeHead(result.status, {
            ...baseSecHeaders,
            ...(result.headers || {}),
            'content-length': String(pre.rawBuf.length),
          })
          res.end(isHead ? Buffer.alloc(0) : pre.rawBuf)
        }
      } else if (result.buffer !== undefined) {
        res.writeHead(result.status, { ...baseSecHeaders, ...(result.headers || {}) })
        res.end(result.buffer)
      } else {
        const rawBody = String(result.body ?? '')
        const acceptEncoding = String(req.headers?.['accept-encoding'] ?? req.headers?.['Accept-Encoding'] ?? '')
        if (rawBody.length > 1024 && /\bgzip\b/i.test(acceptEncoding)) {
          try {
            const gz = await gzipAsync(Buffer.from(rawBody, 'utf8'))
            res.writeHead(result.status, {
              ...baseSecHeaders,
              ...(result.headers || {}),
              'content-encoding': 'gzip',
              'content-length': String(gz.length),
            })
            res.end(gz)
            return
          } catch {
            // fall back to uncompressed body
          }
        }
        res.writeHead(result.status, { ...baseSecHeaders, ...(result.headers || {}) })
        res.end(rawBody)
      }
    } catch (error) {
      logger?.warn?.(`dsh-hub error: ${error?.message ?? error}`)
      if (!res.headersSent) {
        const isClientErr = error instanceof URIError || error?.code === 'ERR_INVALID_URL'
        const status = isClientErr ? 400 : 500
        const msg = isClientErr
          ? 'Bad request'
          : process.env.NODE_ENV === 'production'
            ? 'Internal server error'
            : (error?.message ?? 'Internal server error')
        await sendJson(res, status, { ok: false, error: msg }, req.headers)
      } else {
        try {
          res.end()
        } catch { }
      }
    }
  })

  function fetchAdapter(input, init = {}) {
    return (async () => {
      const urlStr = typeof input === 'string' ? input : input.url
      const method = (init.method || 'GET').toUpperCase()
      const headers = init.headers || {}
      const contentType = String(headers['content-type'] ?? headers['Content-Type'] ?? '').toLowerCase()
      const isBinaryTunnel =
        method === 'POST' &&
        (contentType.includes('application/octet-stream') || Boolean(headers['x-fs-meta'] ?? headers['X-Fs-Meta']))
      let parsedBody = {}
      let rawBuffer = null
      let rawStream = null
      if (isBinaryTunnel) {
        if (init.body && typeof init.body.getReader === 'function') {
          rawStream = Readable.fromWeb(init.body)
        } else if (init.body && typeof init.body.pipe === 'function') {
          rawStream = init.body
        } else if (Buffer.isBuffer(init.body) || init.body instanceof Uint8Array) {
          rawBuffer = Buffer.from(init.body)
        } else if (typeof init.body === 'string') {
          rawBuffer = Buffer.from(init.body, 'utf8')
        } else {
          rawBuffer = Buffer.alloc(0)
        }
      } else if (Buffer.isBuffer(init.body) || init.body instanceof Uint8Array || (typeof init.body === 'string' && init.body.length > 0)) {
        const parsedUrl = new URL(urlStr, 'http://localhost')
        const routeLimit = getRouteMaxBodyBytes(parsedUrl.pathname)
        try {
          let rawBuf = Buffer.isBuffer(init.body) || init.body instanceof Uint8Array
            ? Buffer.from(init.body)
            : Buffer.from(init.body, 'utf8')
          if (rawBuf.length > routeLimit) {
            return {
              status: 413,
              ok: false,
              headers: new Headers(buildSecurityResponseHeaders(headers)),
              async json() { return { ok: false, error: 'Payload too large' } },
              async text() { return JSON.stringify({ ok: false, error: 'Payload too large' }) },
              async arrayBuffer() { return new ArrayBuffer(0) },
            }
          }
          if (rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b) {
            rawBuf = gunzipSync(rawBuf, { maxOutputLength: routeLimit })
          }
          const parsed = JSON.parse(rawBuf.toString('utf8'))
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
              status: 400,
              ok: false,
              headers: new Headers(buildSecurityResponseHeaders(headers)),
              async json() { return { ok: false, error: 'Invalid JSON body' } },
              async text() { return JSON.stringify({ ok: false, error: 'Invalid JSON body' }) },
              async arrayBuffer() { return new ArrayBuffer(0) },
            }
          }
          parsedBody = parsed
        } catch (err) {
          const isTooLarge = err?.code === 'ERR_BUFFER_TOO_LARGE' || /output length/i.test(String(err?.message || ''))
          const status = isTooLarge ? 413 : 400
          const msg = isTooLarge ? 'Payload too large' : 'Invalid JSON body'
          return {
            status,
            ok: false,
            headers: new Headers(buildSecurityResponseHeaders(headers)),
            async json() { return { ok: false, error: msg } },
            async text() { return JSON.stringify({ ok: false, error: msg }) },
            async arrayBuffer() { return new ArrayBuffer(0) },
          }
        }
      } else if (init.body && typeof init.body === 'object') {
        parsedBody = init.body
      }
      const out = await dispatchRequest({
        method,
        url: urlStr,
        headers,
        body: parsedBody,
        rawBuffer,
        rawStream,
        remoteAddress: init.remoteAddress || '',
      })
      if (out.stream) {
        const chunks = []
        try {
          for await (const chunk of out.stream) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
          }
        } finally {
          out.onStreamDone?.()
        }
        out.buffer = Buffer.concat(chunks)
        if (
          typeof out.onCompleteBuffer === 'function' &&
          out.buffer.length > 0 &&
          out.buffer.length <= HUB_MEDIA_CACHE_MAX_ITEM_BYTES &&
          (!out.expectedBytes || out.buffer.length === out.expectedBytes)
        ) {
          try {
            out.onCompleteBuffer(out.buffer)
          } catch {
            // ignore cache populate failure
          }
        }
      }
      return {
        status: out.status,
        ok: out.status >= 200 && out.status < 300,
        headers: new Headers({ ...buildSecurityResponseHeaders(headers), ...(out.headers || {}) }),
        async json() {
          if (out.json !== undefined) return out.json
          return JSON.parse(out.body || '{}')
        },
        async text() {
          if (out.body !== undefined) return String(out.body)
          if (out.json !== undefined) return JSON.stringify(out.json)
          return ''
        },
        async arrayBuffer() {
          const buf = out.buffer ?? Buffer.from(out.body ?? '')
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        },
      }
    })()
  }

  return { server, hub, voiceVault, voiceCopilot, dispatchRequest, fetchAdapter }
}

function renderServiceWorkerJs(buildInfo = {}) {
  const swBuildTag = String(buildInfo?.uiBuild || buildInfo?.version || 'dev').replace(/[^A-Za-z0-9_.-]/g, '') || 'dev'
  const shellCacheName = `dsh-app-shell-v1-${swBuildTag}`
  return `// DSH Self-Hosted PWA, Instant App-Shell Cache & iOS 16.4+ Web Push Service Worker (${swBuildTag})
const SHELL_CACHE = ${JSON.stringify(shellCacheName)};
const SW_UI_BUILD = ${JSON.stringify(swBuildTag)};

function extractBundleAssets(htmlText) {
  const urls = [];
  const re = /\\/(assets\\/index-[A-Za-z0-9_-]+\\.(?:js|css))/g;
  let m;
  while ((m = re.exec(htmlText)) !== null) {
    const p = '/' + m[1];
    if (!urls.includes(p)) urls.push(p);
  }
  return urls;
}

async function revalidateAppShell() {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const prevHtmlRes = await cache.match('/');
    const prevAssets = prevHtmlRes ? extractBundleAssets(await prevHtmlRes.clone().text()) : [];

    const freshRes = await fetch('/', { cache: 'no-store' });
    if (!freshRes || !freshRes.ok) return null;
    const htmlText = await freshRes.clone().text();
    const nextAssets = extractBundleAssets(htmlText);

    // Atomically pre-cache ALL new hashed JS/CSS bundles BEFORE updating '/' HTML
    // so the cached HTML never points to an uncached bundle after an upgrade.
    let allAssetsReady = true;
    for (const assetUrl of nextAssets) {
      const existing = await cache.match(assetUrl);
      if (existing) continue;
      const aRes = await fetch(assetUrl);
      const cc = (aRes.headers.get('cache-control') || '').toLowerCase();
      if (aRes.ok && !cc.includes('no-store')) {
        await cache.put(assetUrl, aRes.clone());
      } else {
        allAssetsReady = false;
      }
    }

    if (allAssetsReady && nextAssets.length > 0) {
      const shellHeaders = { 'content-type': 'text/html; charset=utf-8' };
      for (const hk of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy', 'strict-transport-security']) {
        const hv = freshRes.headers.get(hk);
        if (hv) shellHeaders[hk] = hv;
      }
      await cache.put('/', new Response(htmlText, {
        status: 200,
        headers: shellHeaders,
      }));
      // Prune superseded hashed bundles (keep previous + current generation for open tabs)
      const keepSet = new Set([...prevAssets, ...nextAssets]);
      const keys = await cache.keys();
      for (const reqKey of keys) {
        try {
          const u = new URL(reqKey.url);
          if (u.pathname.startsWith('/assets/index-') && !keepSet.has(u.pathname)) {
            await cache.delete(reqKey);
          }
        } catch {}
      }
    }
    return freshRes;
  } catch {
    return null;
  }
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(revalidateAppShell());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      let purgedOld = false;
      try {
        const names = await caches.keys();
        const stale = names.filter(n => n.startsWith('dsh-app-shell-') && n !== SHELL_CACHE);
        if (stale.length > 0) {
          purgedOld = true;
          await Promise.all(stale.map(n => caches.delete(n)));
        }
      } catch {}
      if (purgedOld) {
        try {
          const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of allClients) {
            try {
              client.postMessage({ type: 'DSH_SW_UPDATED', uiBuild: SW_UI_BUILD });
            } catch {}
          }
        } catch {}
      }
    })()
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (!req || req.method !== 'GET' || req.headers.has('range')) return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (
    p.startsWith('/api/') ||
    p === '/sw.js' ||
    p === '/manifest.json' ||
    p === '/install.sh' ||
    p === '/connect-host.sh' ||
    p === '/healthz' ||
    p === '/ready' ||
    p.startsWith('/share/') ||
    p.startsWith('/c/') ||
    p.startsWith('/market/')
  ) {
    return;
  }

  const isHtmlNav = req.mode === 'navigate' || p === '/' || p === '/index.html';
  if (isHtmlNav) {
    // Explicit recovery reload (_r=...) bypasses local shell cache and re-syncs from network
    if (url.searchParams.has('_r')) {
      event.respondWith(
        fetch(req).finally(() => {
          event.waitUntil(revalidateAppShell());
        })
      );
      return;
    }
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(SHELL_CACHE);
          const cachedHtml = await cache.match('/');
          if (cachedHtml) {
            event.waitUntil(revalidateAppShell());
            return cachedHtml;
          }
        } catch {}
        const netRes = await fetch(req);
        event.waitUntil(revalidateAppShell());
        return netRes;
      })()
    );
    return;
  }

  const isStaticAsset =
    p.startsWith('/assets/') ||
    p === '/apple-touch-icon.png' ||
    p === '/icon-192.png' ||
    p === '/icon-512.png' ||
    p === '/favicon-32x32.png' ||
    p === '/favicon.ico' ||
    p === '/icon.svg';

  if (isStaticAsset) {
    event.respondWith(
      (async () => {
        try {
          const cache = await caches.open(SHELL_CACHE);
          const hit = await cache.match(req, { ignoreSearch: p.startsWith('/assets/') });
          if (hit) return hit;
          const res = await fetch(req);
          const cc = (res.headers.get('cache-control') || '').toLowerCase();
          if (res.ok && !cc.includes('no-store')) {
            await cache.put(req, res.clone());
          }
          return res;
        } catch {
          return fetch(req);
        }
      })()
    );
  }
});

self.addEventListener('push', event => {
  let payload = {
    title: 'DSH 远控通知',
    body: '您的电脑任务有新动态，点击查看',
    tag: 'dsh-notify',
    badgeCount: 1,
    data: { url: '/' },
  };
  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch {
      payload.body = event.data.text();
    }
  }

  const tasks = [
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png?v=0.8.0',
      badge: '/icon-192.png?v=0.8.0',
      tag: payload.tag || 'dsh-notify',
      renotify: true,
      data: payload.data || { url: '/' },
    }),
  ];

  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    tasks.push(self.navigator.setAppBadge(Number(payload.badgeCount) || 1).catch(() => {}));
  }

  tasks.push(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients || []) {
        try {
          client.postMessage({ type: 'PUSH_RECEIVED', data: payload.data || {} });
        } catch {}
      }
    }).catch(() => {})
  );

  event.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const clearTasks = [];
  if (self.navigator && typeof self.navigator.clearAppBadge === 'function') {
    clearTasks.push(self.navigator.clearAppBadge().catch(() => {}));
  }
  if (self.navigator && typeof self.navigator.setAppBadge === 'function') {
    clearTasks.push(self.navigator.setAppBadge(0).catch(() => {}));
  }
  if (self.registration && typeof self.registration.getNotifications === 'function') {
    clearTasks.push(
      self.registration.getNotifications().then(list => {
        for (const n of list || []) n.close();
      }).catch(() => {})
    );
  }
  const data = event.notification.data || {};
  let targetUrl = '/';
  try {
    const parsedTarget = new URL(data.url || '/', self.location.origin);
    if (parsedTarget.origin === self.location.origin) {
      targetUrl = parsedTarget.href;
    }
  } catch {}

  event.waitUntil(
    Promise.all([
      ...clearTasks,
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
        for (const client of windowClients) {
          if ('focus' in client) {
            client.postMessage({ type: 'NOTIFICATION_CLICK', data });
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
    ])
  );
});
`
}

function renderShareReplayHtml(share) {
  const safeMeta = JSON.stringify({
    id: share.id,
    title: share.title,
    hostName: share.hostName,
    messageCount: share.messageCount,
    createdAt: share.createdAt,
    ivBase64: share.ivBase64,
    ciphertextBase64: share.ciphertextBase64,
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>🔒 E2EE 加密会话回放 · ${String(share.title || '').replace(/[<>&"]/g, '')}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --subtle: #f1f5f9;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #64748b;
      --primary: #2563eb;
      --green: #059669;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      background-image: radial-gradient(960px 340px at 50% -100px, rgba(37, 99, 235, 0.08), transparent);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", Roboto, sans-serif;
      padding: 28px 18px 60px;
      line-height: 1.6;
    }
    .wrap { max-width: 880px; margin: 0 auto; }
    .header {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 20px 24px;
      margin-bottom: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 14px;
      box-shadow: 0 4px 20px -4px rgba(15, 23, 42, 0.06);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 999px;
      background: #ecfdf5;
      color: var(--green);
      border: 1px solid #a7f3d0;
    }
    .btn {
      background: var(--primary);
      color: #fff;
      border: 1px solid transparent;
      border-radius: 10px;
      padding: 9px 16px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.15s;
      box-shadow: 0 2px 6px rgba(37, 99, 235, 0.2);
    }
    .btn:hover { background: #1d4ed8; }
    .btn.secondary {
      background: #ffffff;
      color: var(--text);
      border-color: var(--border);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .btn.secondary:hover { background: var(--subtle); }
    .msg {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px 20px;
      margin-bottom: 14px;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.03);
    }
    .msg.user {
      background: #eff6ff;
      border-color: #bfdbfe;
    }
    .msg.assistant {
      border-left: 4px solid var(--green);
    }
    .role {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--muted);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      font-size: 14px;
      line-height: 1.65;
      color: var(--text);
    }
    .thinking {
      margin-top: 10px;
      padding: 10px 14px;
      background: var(--subtle);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: #475569;
      font-size: 12.5px;
    }
    .tools { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .tool-pill {
      font-size: 11.5px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 999px;
      background: #eff6ff;
      color: var(--primary);
      border: 1px solid #bfdbfe;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="badge">🔒 AES-256-GCM 端到端加密回放（自托管，零第三方服务器）</div>
        <h2 id="title" style="margin:10px 0 4px 0; font-size:20px; letter-spacing:-0.01em;">正在浏览器本地解密...</h2>
        <div id="meta" style="font-size:13px; color:var(--muted);"></div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn" onclick="startReplay()">▶ 动画回放</button>
        <button class="btn secondary" onclick="renderAll()">展开全部</button>
      </div>
    </div>
    <div id="stream"></div>
  </div>
  <script>
    const SHARE = ${safeMeta};
    let decryptedTranscript = [];
    let replayTimer = null;

    function b64ToBytes(b64) {
      const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const bin = atob(normalized + pad);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }

    function esc(s) {
      return String(s ?? '')
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
    }

    async function decryptShare() {
      const hash = location.hash.replace(/^#/, '');
      const params = new URLSearchParams(hash);
      const keyStr = params.get('k');
      if (!keyStr) {
        document.getElementById('title').textContent = '缺少解密密钥 (#k=...)';
        document.getElementById('stream').innerHTML = '<div class="msg">URL 锚点中未包含 #k= 密钥，服务端不保存密钥，无法解密。</div>';
        return;
      }
      try {
        const keyBytes = b64ToBytes(keyStr);
        const ivBytes = b64ToBytes(SHARE.ivBase64);
        const cipherBytes = b64ToBytes(SHARE.ciphertextBase64);
        const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
        const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, cryptoKey, cipherBytes);
        const data = JSON.parse(new TextDecoder().decode(plainBuf));
        document.getElementById('title').textContent = data.title || SHARE.title;
        document.getElementById('meta').textContent = '来源主机: ' + (data.hostName || SHARE.hostName) + ' · 工作区: ' + (data.cwd || '-') + ' · 消息数: ' + (data.transcript?.length || 0);
        decryptedTranscript = data.transcript || [];
        renderAll();
      } catch (err) {
        document.getElementById('title').textContent = '解密失败：密钥不匹配或数据已损坏';
        document.getElementById('stream').innerHTML = '<div class="msg">' + esc(err.message) + '</div>';
      }
    }

    function renderStep(m, idx) {
      const safeRole = m && m.role === 'user' ? 'user' : 'assistant';
      const roleLabel = safeRole === 'user' ? '🧑 用户指令' : '🤖 DeepSeek Harness';
      const tools = (m.tools || []).map(t => '<span class="tool-pill">🔧 ' + esc(t.name) + '</span>').join('');
      const thinking = m.thinking ? '<div class="thinking">💭 思考过程：' + esc(m.thinking) + '</div>' : '';
      return '<div class="msg ' + safeRole + '">' +
        '<div class="role"><span>' + roleLabel + '</span><span>#' + (idx + 1) + '</span></div>' +
        '<pre>' + esc(m.text || '') + '</pre>' +
        thinking +
        (tools ? '<div class="tools">' + tools + '</div>' : '') +
      '</div>';
    }

    function renderAll() {
      if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
      document.getElementById('stream').innerHTML = decryptedTranscript.map((m, i) => renderStep(m, i)).join('');
    }

    function startReplay() {
      if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
      const box = document.getElementById('stream');
      box.innerHTML = '';
      let idx = 0;
      replayTimer = setInterval(() => {
        if (idx >= decryptedTranscript.length) {
          clearInterval(replayTimer);
          replayTimer = null;
          return;
        }
        box.insertAdjacentHTML('beforeend', renderStep(decryptedTranscript[idx], idx));
        idx++;
      }, 450);
    }

    decryptShare();
  </script>
</body>
</html>`
}

function buildSecurityResponseHeaders(reqHeaders = {}) {
  const proto = String(reqHeaders?.['x-forwarded-proto'] ?? reqHeaders?.['X-Forwarded-Proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    ...(proto === 'https' ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  }
}

async function sendJson(res, status, data, reqHeaders = {}) {
  const payload = JSON.stringify(data)
  const baseHeaders = buildSecurityResponseHeaders(reqHeaders)
  const acceptEncoding = String(reqHeaders?.['accept-encoding'] ?? reqHeaders?.['Accept-Encoding'] ?? '')
  if (payload.length > 1024 && /\bgzip\b/i.test(acceptEncoding)) {
    try {
      const gz = await gzipAsync(Buffer.from(payload, 'utf8'))
      res.writeHead(status, {
        ...baseHeaders,
        'content-type': 'application/json; charset=utf-8',
        'content-encoding': 'gzip',
        'content-length': String(gz.length),
        'cache-control': 'no-store',
      })
      res.end(gz)
      return
    } catch {
      // fall back to uncompressed
    }
  }
  res.writeHead(status, {
    ...baseHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readRawBodyBuffer(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        reject(new Error('Request body exceeds limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        reject(new Error('Request body exceeds limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        let rawBuf = Buffer.concat(chunks)
        const encoding = String(req.headers?.['content-encoding'] ?? req.headers?.['Content-Encoding'] ?? '').toLowerCase()
        if (encoding === 'gzip' || (rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b)) {
          rawBuf = gunzipSync(rawBuf, { maxOutputLength: maxBytes })
        }
        const text = rawBuf.toString('utf8')
        const parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new Error('Invalid JSON body'))
        }
        resolve(parsed)
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /output length/i.test(String(err?.message || ''))) {
          return reject(new Error('Request body exceeds limit'))
        }
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// Allow running directly (`node hub/server.js`) for Google Cloud Run / Docker / Railway / local usage
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const port = Number(process.env.PORT || process.env.HUB_PORT || 8080)
  const host = process.env.HOST || '0.0.0.0'
  const stateFile = resolveDefaultStateFile()
  const rawToken = process.env.HUB_TOKEN || process.env.FEISHU_HUB_TOKEN || ''
  const allowInsecure = process.env.ALLOW_INSECURE_NO_TOKEN === '1'
  const tokenCheck = validateHubStartupToken(rawToken, { allowInsecureNoToken: allowInsecure })
  if (!tokenCheck.ok) {
    console.error(tokenCheck.error)
    process.exit(1)
  }
  const hub = new HubCore({ stateFile })
  await hub.init()
  const { server } = createHubServer({ hub, token: tokenCheck.token, requireToken: !allowInsecure })
  server.listen(port, host, () => {
    console.log(
      formatStartupBanner({
        host,
        port,
        token: tokenCheck.token,
        stateFile,
      }),
    )
      // Pre-compress static HTML/JS/CSS into RAM immediately, then self-warm CDN edge (if PUBLIC_URL is HTTPS)
      // so the very first user open right after any upgrade/restart is already a 0ms RAM + CDN Edge HIT.
      ; (async () => {
        try {
          const htmlEntry = await readStaticTextPrecompressed(INDEX_HTML_PATH)
          const assetPaths = []
          const re = /\/(assets\/index-[A-Za-z0-9_-]+\.(?:js|css))/g
          let m
          while ((m = re.exec(htmlEntry.text)) !== null) {
            const rel = m[1]
            assetPaths.push(`/${rel}`)
            await readStaticTextPrecompressed(join(__dirname, 'public', rel)).catch(() => { })
          }
          const rawPub = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
          if (rawPub.startsWith('https://')) {
            const warmTimer = setTimeout(async () => {
              for (const p of ['/', ...assetPaths, '/icon-192.png?v=0.8.0', '/apple-touch-icon.png?v=0.8.0']) {
                try {
                  await fetch(`${rawPub}${p}`, {
                    headers: { 'accept-encoding': 'br, gzip', 'user-agent': 'dsh-edge-prewarm/1.0' },
                  })
                } catch { }
              }
            }, 800)
            warmTimer.unref?.()
          }
        } catch { }
      })()
  })
}
