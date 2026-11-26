import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import {
  buildApnsPayload,
  createApnsProviderJwt,
  resetApnsJwtCache,
  resolveApnsAuthority,
  resolveApnsConfig,
  sendApnsNotification,
} from '../../hub/apns-push.js'
import { HubCore } from '../../hub/hub-core.js'
import { translateZhStringToEn } from '../../hub/web/src/utils/i18n.js'

test('v0.9.35 APNs provider JWT (ES256), sandbox/prod routing, payload, and HTTP/2 send + 410 expiry', async () => {
  resetApnsJwtCache()
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

  const cfg = resolveApnsConfig({
    keyId: 'ABCD123456',
    teamId: 'H7Y6N5S3Q3',
    bundleId: 'vip.agentrun.pocketagents.shell',
    privateKey: privateKeyPem,
  })
  assert.equal(cfg.configured, true)

  const jwt = createApnsProviderJwt(cfg, { nowSec: 1_800_000_000 })
  const [h, p, s] = jwt.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), {
    alg: 'ES256',
    kid: 'ABCD123456',
  })
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString('utf8')), {
    iss: 'H7Y6N5S3Q3',
    iat: 1_800_000_000,
  })
  const sigValid = verify('sha256', Buffer.from(`${h}.${p}`, 'utf8'), {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, Buffer.from(s, 'base64url'))
  assert.equal(sigValid, true)

  assert.equal(resolveApnsAuthority('sandbox', 'auto'), 'https://api.sandbox.push.apple.com')
  assert.equal(resolveApnsAuthority('production', 'auto'), 'https://api.push.apple.com')

  const payload = buildApnsPayload({
    title: '⏳ 待审批',
    body: 'run_command: npm test',
    badgeCount: 2,
    tag: 'approval-123',
    data: { type: 'approval', hostId: 'mini', agentId: 'agy-ide:abc', code: 'AGY-1' },
  })
  assert.equal(payload.aps['interruption-level'], 'time-sensitive')
  assert.equal(payload.aps['content-available'], 1)
  assert.equal(payload.aps.badge, 2)
  assert.equal(payload.dsh.agentId, 'agy-ide:abc')

  const completedPayload = buildApnsPayload({
    title: '✅ 任务已完成',
    body: 'minihealth 测试完成',
    data: { type: 'completed', hostId: 'air', agentId: 'agy-ide:xyz' },
  })
  assert.equal(completedPayload.aps['interruption-level'], 'active')
  assert.equal(completedPayload.aps['content-available'], 1)

  const infoPayload = buildApnsPayload({
    title: '测试推送',
    body: 'hello',
    data: { type: 'test' },
  })
  assert.equal('content-available' in infoPayload.aps, false)

  // Mock HTTP/2 200 OK
  let capturedAuthority = ''
  let capturedHeaders = null
  const mockConnect = (status, respBody = '') => authority => {
    capturedAuthority = authority
    const client = new EventEmitter()
    client.close = () => {}
    client.request = headers => {
      capturedHeaders = headers
      const req = new EventEmitter()
      req.setEncoding = () => {}
      req.end = () => {
        setImmediate(() => {
          req.emit('response', { ':status': status, 'apns-id': 'test-apns-id' })
          if (respBody) req.emit('data', respBody)
          req.emit('end')
        })
      }
      return req
    }
    return client
  }

  const okRes = await sendApnsNotification(
    { deviceToken: 'a'.repeat(64), apnsEnv: 'sandbox', bundleId: 'vip.agentrun.pocketagents.shell' },
    { title: 'Hello', body: 'World', tag: 't1' },
    { apnsConfig: cfg, http2Connect: mockConnect(200) },
  )
  assert.equal(okRes.ok, true)
  assert.equal(okRes.env, 'sandbox')
  assert.equal(capturedAuthority, 'https://api.sandbox.push.apple.com')
  assert.equal(capturedHeaders['apns-topic'], 'vip.agentrun.pocketagents.shell')
  assert.equal(capturedHeaders[':path'], `/3/device/${'a'.repeat(64)}`)

  const goneRes = await sendApnsNotification(
    { deviceToken: 'b'.repeat(64), apnsEnv: 'production' },
    { title: 'Hello', body: 'World' },
    { apnsConfig: cfg, http2Connect: mockConnect(410, '{"reason":"Unregistered"}') },
  )
  assert.equal(goneRes.ok, false)
  assert.equal(goneRes.expired, true)
  assert.equal(goneRes.reason, 'Unregistered')
})

test('v0.9.35 HubCore keeps Safari Web Push 100% isolated from Native iOS APNs and fans out safely to both', async () => {
  const webPushCalls = []
  const apnsCalls = []

  const hub = new HubCore({
    pushFetch: async (url, init) => {
      webPushCalls.push({ url, init })
      return { ok: true, status: 201, text: async () => '' }
    },
    apnsSender: async (dev, payload) => {
      apnsCalls.push({ token: dev.deviceToken, title: payload.title })
      if (dev.deviceToken.startsWith('dead')) {
        return { ok: false, expired: true, status: 410, reason: 'Unregistered' }
      }
      return { ok: true, status: 200 }
    },
  })

  // 1) Add a Safari Web Push subscription
  const p256dh = Buffer.alloc(65, 4).toString('base64url')
  const auth = Buffer.alloc(16, 7).toString('base64url')
  const webRes = hub.addPushSubscription({
    subscription: {
      endpoint: 'https://web.push.apple.com/mock-safari-endpoint',
      keys: { p256dh, auth },
    },
    deviceName: 'iPhone 主屏幕 App',
  })
  assert.equal(webRes.ok, true)

  // 2) Add two Native iOS APNs devices (one live, one dead)
  const apnsLive = hub.addApnsDevice({
    deviceToken: '1'.repeat(64),
    deviceName: 'iPhone 15 Pro Max (原生 App)',
    apnsEnv: 'sandbox',
  })
  assert.equal(apnsLive.ok, true)
  const apnsDead = hub.addApnsDevice({
    deviceToken: 'dead' + '2'.repeat(60),
    deviceName: 'Old iPhone',
    apnsEnv: 'sandbox',
  })
  assert.equal(apnsDead.ok, true)

  // Confirm completely separate stores in getFullState()
  const stateBefore = hub.getFullState()
  assert.equal(stateBefore.pushSubscriptions.length, 1)
  assert.equal(stateBefore.apnsDevices.length, 2)

  // 3) Broadcast fans out to BOTH channels independently (and prunes dead APNs token without touching Safari Web Push!)
  const broadcast = await hub.broadcastWebPush({
    title: '⏳ 待审批',
    body: 'git push',
    data: { type: 'approval', agentId: 'agy-ide:123' },
  })
  assert.equal(broadcast.webPushTotal, 1)
  assert.equal(broadcast.apnsTotal, 2)
  assert.equal(broadcast.apnsSent, 1)
  assert.equal(apnsCalls.length, 2)
  assert.equal(hub.listPushSubscriptions().length, 1) // Safari Web Push completely untouched!
  assert.equal(hub.listApnsDevices().length, 1) // Dead APNs token pruned cleanly

  // 4) Removing APNs device NEVER removes Safari Web Push
  const remRes = hub.removeApnsDevice('1'.repeat(64))
  assert.equal(remRes.ok, true)
  assert.equal(hub.listApnsDevices().length, 0)
  assert.equal(hub.listPushSubscriptions().length, 1)
})

test('v0.9.35 Web UI isolates native APNs route from Safari Web Push and translates all new strings to EN', async () => {
  const [controllerSrc, serverSrc, walkSheetsSrc, walkAudioSrc] = await Promise.all([
    readFile(resolve(process.cwd(), 'hub/web/src/controller.js'), 'utf8'),
    readFile(resolve(process.cwd(), 'hub/server.js'), 'utf8'),
    readFile(resolve(process.cwd(), 'hub/web/src/components/VoiceCopilotSheets.tsx'), 'utf8'),
    readFile(resolve(process.cwd(), 'hub/web/src/voice/walkAudio.ts'), 'utf8'),
  ])
  assert.match(serverSrc, /\/api\/push\/apns\/subscribe/)
  assert.match(serverSrc, /\/api\/push\/apns\/unsubscribe/)
  assert.match(serverSrc, /\/api\/push\/apns\/test/)
  assert.match(controllerSrc, /isNativeIosApnsBridge/)
  assert.match(controllerSrc, /__dshHandleNativePushTap/)
  assert.match(controllerSrc, /__dshWalkStartReplyForPush/)
  assert.match(walkSheetsSrc, /__dshOnBackgroundPushWake/)
  assert.match(walkSheetsSrc, /__dshWalkStartReplyForPush/)
  assert.match(walkSheetsSrc, /canNativeAutoListenNow/)
  assert.match(walkAudioSrc, /canNativeAutoListenNow/)
  assert.match(walkAudioSrc, /notifyNativeBackgroundWakeDone/)

  const zhStrings = [
    '当前运行在 PocketAgents iOS 原生 App 中，使用独立 Apple APNs 通道，与 Safari 网页推送完全隔离互不影响。',
    '本机 (iOS 原生 App)：✅ 已开启 APNs 锁屏推送',
    '本机 (iOS 原生 App)：🟡 已登记设备令牌（云端待配置 .p8 密钥）',
    '🔕 已关闭本机原生 App 推送（不影响 Safari 网页推送）',
  ]
  for (const s of zhStrings) {
    const en = translateZhStringToEn(s)
    assert.equal(/[\u4e00-\u9fa5]/.test(en), false, `Leftover Chinese in EN for "${s}" -> "${en}"`)
  }
})
