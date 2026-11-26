import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http2 from 'node:http2'

const APNS_HOST_PRODUCTION = 'https://api.push.apple.com'
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com'

let cachedJwt = {
  token: '',
  cacheKey: '',
  issuedAtSec: 0,
}

export function resetApnsJwtCache() {
  cachedJwt = { token: '', cacheKey: '', issuedAtSec: 0 }
}

/**
 * Resolve APNs token-based auth configuration from env vars (or explicit override).
 * Requires Apple Developer `.p8` AuthKey (ES256), Key ID, Team ID, and App Bundle ID.
 */
export function resolveApnsConfig(override = null) {
  const src = override && typeof override === 'object' ? override : {}
  const keyId = String(src.keyId ?? process.env.APNS_KEY_ID ?? '').trim()
  const teamId = String(src.teamId ?? process.env.APNS_TEAM_ID ?? '').trim()
  const bundleId = String(
    src.bundleId ?? process.env.APNS_BUNDLE_ID ?? 'vip.agentrun.pocketagents.shell',
  ).trim()
  const defaultEnv = String(src.env ?? process.env.APNS_ENV ?? 'auto').trim().toLowerCase()

  let privateKeyPem = String(src.privateKeyPem ?? src.privateKey ?? process.env.APNS_PRIVATE_KEY ?? '').trim()
  const privateKeyPath = String(src.privateKeyPath ?? process.env.APNS_PRIVATE_KEY_PATH ?? '').trim()
  if (!privateKeyPem && privateKeyPath) {
    try {
      privateKeyPem = readFileSync(privateKeyPath, 'utf8').trim()
    } catch {
      privateKeyPem = ''
    }
  }
  if (privateKeyPem && !privateKeyPem.includes('BEGIN PRIVATE KEY')) {
    try {
      const decoded = Buffer.from(privateKeyPem, 'base64').toString('utf8').trim()
      if (decoded.includes('BEGIN PRIVATE KEY')) {
        privateKeyPem = decoded
      }
    } catch {
      // keep raw
    }
  }
  if (privateKeyPem && privateKeyPem.includes('\\n')) {
    privateKeyPem = privateKeyPem.replace(/\\n/g, '\n')
  }

  let keyValid = false
  if (privateKeyPem) {
    try {
      createPrivateKey({ key: privateKeyPem, format: 'pem' })
      keyValid = true
    } catch {
      keyValid = false
    }
  }

  const configured = Boolean(keyId && teamId && bundleId && keyValid)
  return {
    configured,
    keyId,
    teamId,
    bundleId,
    defaultEnv,
    privateKeyPem: keyValid ? privateKeyPem : '',
  }
}

export function getApnsPublicStatus(override = null) {
  const cfg = resolveApnsConfig(override)
  return {
    configured: cfg.configured,
    bundleId: cfg.bundleId,
    teamId: cfg.teamId,
    keyIdPreview: cfg.keyId ? `${cfg.keyId.slice(0, 4)}…${cfg.keyId.slice(-2)}` : '',
    defaultEnv: cfg.defaultEnv,
  }
}

/**
 * Create (and cache for 45 min) an ES256 APNs Provider Authentication JWT (RFC 7519).
 */
export function createApnsProviderJwt(cfg, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const cacheKey = `${cfg.teamId}:${cfg.keyId}`
  if (
    cachedJwt.token &&
    cachedJwt.cacheKey === cacheKey &&
    nowSec - cachedJwt.issuedAtSec < 45 * 60
  ) {
    return cachedJwt.token
  }

  const headerB64 = Buffer.from(
    JSON.stringify({ alg: 'ES256', kid: cfg.keyId }),
  ).toString('base64url')
  const claimsB64 = Buffer.from(
    JSON.stringify({ iss: cfg.teamId, iat: nowSec }),
  ).toString('base64url')
  const signingInput = `${headerB64}.${claimsB64}`

  const privKey = createPrivateKey({ key: cfg.privateKeyPem, format: 'pem' })
  const sig = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privKey,
    dsaEncoding: 'ieee-p1363',
  })
  const jwt = `${signingInput}.${sig.toString('base64url')}`
  cachedJwt = { token: jwt, cacheKey, issuedAtSec: nowSec }
  return jwt
}

export function resolveApnsAuthority(deviceEnv = '', configDefaultEnv = 'auto') {
  const dev = String(deviceEnv || '').trim().toLowerCase()
  const def = String(configDefaultEnv || 'auto').trim().toLowerCase()
  if (def === 'production') return APNS_HOST_PRODUCTION
  if (def === 'sandbox' || def === 'development') return APNS_HOST_SANDBOX
  if (dev === 'production') return APNS_HOST_PRODUCTION
  if (dev === 'sandbox' || dev === 'development') return APNS_HOST_SANDBOX
  return APNS_HOST_PRODUCTION
}

export function buildApnsPayload(payloadObj = {}) {
  const title = String(payloadObj.title || 'PocketAgents 通知').slice(0, 120)
  const body = String(payloadObj.body || '').slice(0, 320)
  const badgeNum = Number(payloadObj.badgeCount)
  const isUrgent = Boolean(
    payloadObj.requireInteraction
    || payloadObj.data?.type === 'approval'
    || payloadObj.data?.type === 'security',
  )
  const aps = {
    alert: { title, body },
    sound: 'default',
    ...(Number.isFinite(badgeNum) && badgeNum >= 0 ? { badge: Math.min(99, Math.floor(badgeNum)) } : {}),
    'interruption-level': isUrgent ? 'time-sensitive' : 'active',
  }
  return {
    aps,
    dsh: {
      type: String(payloadObj.data?.type || 'info'),
      hostId: String(payloadObj.data?.hostId || ''),
      agentId: String(payloadObj.data?.agentId || ''),
      code: String(payloadObj.data?.code || ''),
      url: String(payloadObj.data?.url || '/'),
      tag: String(payloadObj.tag || 'dsh-notify'),
    },
  }
}

/**
 * Send a single APNs HTTP/2 notification to an iOS native device token.
 * Completely independent from W3C Web Push (VAPID).
 */
export async function sendApnsNotification(
  deviceRecord,
  payloadObj = {},
  { apnsConfig = null, http2Connect = http2.connect, timeoutMs = 10_000 } = {},
) {
  const cfg = resolveApnsConfig(apnsConfig)
  if (!cfg.configured) {
    return {
      ok: false,
      configured: false,
      error: '云端 Hub 尚未配置 Apple APNs (.p8 密钥 / Key ID / Team ID)',
    }
  }
  const cleanToken = String(deviceRecord?.deviceToken || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (cleanToken.length < 32) {
    return { ok: false, expired: true, error: 'Invalid APNs device token' }
  }

  const topic = String(deviceRecord?.bundleId || cfg.bundleId).trim() || cfg.bundleId
  const authority = resolveApnsAuthority(deviceRecord?.apnsEnv, cfg.defaultEnv)
  const jwt = createApnsProviderJwt(cfg)
  const bodyJson = JSON.stringify(buildApnsPayload(payloadObj))
  const collapseId = String(payloadObj.tag || '').trim().slice(0, 64)

  const reqHeaders = {
    ':method': 'POST',
    ':path': `/3/device/${cleanToken}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(bodyJson, 'utf8'),
    ...(collapseId ? { 'apns-collapse-id': collapseId } : {}),
  }

  return await new Promise(resolve => {
    let settled = false
    let client = null
    const finish = out => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client?.close?.() } catch { }
      resolve(out)
    }
    const timer = setTimeout(() => {
      finish({ ok: false, error: 'APNs HTTP/2 请求超时' })
    }, timeoutMs)
    timer.unref?.()

    try {
      client = http2Connect(authority)
      client.on('error', err => {
        finish({ ok: false, error: err?.message || 'APNs HTTP/2 连接失败' })
      })
      const req = client.request(reqHeaders)
      let status = 0
      let apnsId = ''
      const chunks = []
      req.on('response', headers => {
        status = Number(headers[':status'] || 0)
        apnsId = String(headers['apns-id'] || '')
      })
      req.setEncoding('utf8')
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        const raw = chunks.join('').trim()
        let reason = ''
        try {
          reason = String(JSON.parse(raw || '{}')?.reason || '')
        } catch {
          reason = raw.slice(0, 120)
        }
        if (status >= 200 && status < 300) {
          finish({ ok: true, status, apnsId, env: authority === APNS_HOST_SANDBOX ? 'sandbox' : 'production' })
          return
        }
        const expired =
          status === 410
          || (status === 400 && /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/i.test(reason))
        finish({
          ok: false,
          status,
          expired,
          reason,
          error: reason ? `APNs ${status}: ${reason}` : `APNs HTTP ${status}`,
        })
      })
      req.on('error', err => {
        finish({ ok: false, error: err?.message || 'APNs 请求失败' })
      })
      req.end(bodyJson)
    } catch (err) {
      finish({ ok: false, error: err?.message || 'APNs 初始化失败' })
    }
  })
}
