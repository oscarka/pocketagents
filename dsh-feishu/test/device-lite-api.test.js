import test from 'node:test'
import assert from 'node:assert/strict'

import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'
import { resamplePcm16Mono } from '../../hub/voice-copilot.js'

function seedDeviceHub(hub, nowMs) {
  hub.handleHeartbeat({
    hostId: 'macbook-pro',
    hostName: 'MacBook Pro',
    bridgeState: {
      tasks: [
        {
          id: 'claude:test-1',
          harness: 'claude',
          title: '修复支付单测',
          cwd: '/Users/dev/pocketagents',
          status: 'approval',
          updatedAt: nowMs - 1000,
          lastOutput: '正在等待执行 npm test 验证修复。',
          pendingApproval: true,
        },
        {
          id: 'agy:deploy-2',
          harness: 'antigravity',
          title: '发布策略选择',
          cwd: '/Users/dev/pocketagents',
          status: 'approval',
          updatedAt: nowMs - 2000,
          lastOutput: '请选择本次上线方式。',
          pendingApproval: true,
        },
        {
          id: 'codex:cleanup-3',
          harness: 'codex',
          title: '清理旧缓存',
          cwd: '/Users/dev/pocketagents',
          status: 'approval',
          updatedAt: nowMs - 3000,
          pendingApproval: true,
        },
        {
          id: 'dsh:build-4',
          harness: 'dsh',
          title: '构建前端产物',
          cwd: '/Users/dev/pocketagents',
          status: 'running',
          updatedAt: nowMs - 500,
        },
      ],
      approvals: [
        {
          code: 'CLD-101',
          agentId: 'claude:test-1',
          kind: 'approval',
          toolName: 'Bash',
          promptTitle: 'Allow running unit test suite',
          commandLine: 'npm test -- dsh-feishu/test/device-lite-api.test.js',
          createdAt: nowMs - 30_000,
          options: [
            { index: 1, label: 'Allow once' },
            { index: 2, label: 'Always allow' },
            { index: 3, label: 'Deny' },
          ],
        },
        {
          code: 'AGY-202',
          agentId: 'agy:deploy-2',
          kind: 'question',
          toolName: 'ask_question',
          promptTitle: '请选择本次部署策略',
          createdAt: nowMs - 20_000,
          questions: [
            {
              id: 'q_strategy',
              question: '你想采用哪个发布策略？',
              options: [
                { label: '仅部署灰度服' },
                { label: '直接全量上线' },
                { label: '暂缓发布' },
              ],
            },
          ],
        },
        {
          code: 'CDX-303',
          agentId: 'codex:cleanup-3',
          kind: 'approval',
          toolName: 'Bash',
          promptTitle: 'Remove legacy build artifacts',
          commandLine: 'rm -rf /tmp/old-build && git push --force origin main',
          createdAt: nowMs - 10_000,
          options: [
            { index: 1, label: 'Allow' },
            { index: 2, label: 'Deny' },
          ],
        },
      ],
    },
  })
}

test('Generic Edge Device API: compact < 3KB digest, since=<rev> unchanged fast-path, and zero-trust auth', async () => {
  let nowMs = 1_796_000_000_000
  const hub = new HubCore({ now: () => nowMs })
  seedDeviceHub(hub, nowMs)

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'edge-device-token',
    requireToken: true,
    voiceVaultFile: '',
  })

  // Unauthenticated request MUST be rejected
  const unauth = await dispatchRequest({
    method: 'GET',
    url: '/api/device/digest',
    headers: {},
  })
  assert.equal(unauth.status, 401)

  // Paired device token via /api/pairing/exchange works cleanly
  const adminHeaders = { 'x-hub-token': 'edge-device-token' }
  const pairCreate = await dispatchRequest({
    method: 'POST',
    url: '/api/pairing/create',
    headers: adminHeaders,
    body: {},
  })
  assert.equal(pairCreate.status, 200)
  const pairEx = await dispatchRequest({
    method: 'POST',
    url: '/api/pairing/exchange',
    headers: {},
    body: {
      code: pairCreate.json.code,
      deviceId: 'folotoy-passport-01',
      deviceName: 'FoloToy AI Passport',
    },
  })
  assert.equal(pairEx.status, 200)
  const devHeaders = { 'x-hub-token': pairEx.json.deviceToken }

  const res = await dispatchRequest({
    method: 'GET',
    url: '/api/device/digest',
    headers: devHeaders,
  })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.unchanged, false)
  assert.equal(res.json.summary.hostsOnline, 1)
  assert.equal(res.json.summary.running, 1)
  assert.equal(res.json.summary.pending, 3)
  assert.equal(res.json.approvals.length, 3)
  assert.equal(res.json.approvals[0].slot, 1)
  assert.equal(res.json.approvals[0].risk, 'L1')
  assert.equal(res.json.approvals[1].kind, 'question')
  assert.deepEqual(res.json.approvals[1].options, ['仅部署灰度服', '直接全量上线', '暂缓发布'])
  assert.equal(res.json.approvals[2].risk, 'L2')

  // Must remain well under MCU JSON budget (3 KB)
  const serializedBytes = Buffer.byteLength(JSON.stringify(res.json), 'utf8')
  assert.ok(serializedBytes < 3072, `Expected digest < 3072 bytes, got ${serializedBytes}`)

  // Polling with since=<rev> returns tiny unchanged response
  const unchanged = await dispatchRequest({
    method: 'GET',
    url: `/api/device/digest?since=${encodeURIComponent(res.json.rev)}`,
    headers: devHeaders,
  })
  assert.equal(unchanged.status, 200)
  assert.equal(unchanged.json.unchanged, true)
  assert.equal(unchanged.json.rev, res.json.rev)
  assert.equal(unchanged.json.approvals, undefined)
})

test('Generic Edge Device API: approve L1, answer multi-choice, deny dynamic index, and enforce L2 3-digit PIN guard', async () => {
  let nowMs = 1_796_000_000_000
  const hub = new HubCore({ now: () => nowMs })
  seedDeviceHub(hub, nowMs)

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'edge-action-token',
    requireToken: true,
    voiceVaultFile: '',
  })
  const headers = { 'x-hub-token': 'edge-action-token' }

  // 1. Approve L1 slot #1 immediately
  const r1 = await dispatchRequest({
    method: 'POST',
    url: '/api/device/action',
    headers,
    body: { type: 'approve', slot: 1 },
  })
  assert.equal(r1.status, 200)
  assert.equal(r1.json.ok, true)
  assert.equal(r1.json.code, 'CLD-101')

  // 2. Answer multi-choice question slot #2 with option 2 ("直接全量上线")
  const r2 = await dispatchRequest({
    method: 'POST',
    url: '/api/device/action',
    headers,
    body: { type: 'answer', slot: 2, optionIndex: 2 },
  })
  assert.equal(r2.status, 200)
  assert.equal(r2.json.ok, true)
  assert.equal(r2.json.code, 'AGY-202')

  // 3. Bare tap approve on L2 slot #3 MUST be blocked (409) and issue a 3-digit PIN
  const r3Blocked = await dispatchRequest({
    method: 'POST',
    url: '/api/device/action',
    headers,
    body: { type: 'approve', slot: 3 },
  })
  assert.equal(r3Blocked.status, 409)
  assert.equal(r3Blocked.json.ok, false)
  assert.equal(r3Blocked.json.requiresPin, true)
  assert.match(r3Blocked.json.confirmPin, /^\d{3}$/)

  // Wrong PIN MUST be rejected (403)
  const wrongPin = r3Blocked.json.confirmPin === '999' ? '888' : '999'
  const r3Wrong = await dispatchRequest({
    method: 'POST',
    url: '/api/device/action',
    headers,
    body: { type: 'approve', slot: 3, confirmPin: wrongPin },
  })
  assert.equal(r3Wrong.status, 403)
  assert.equal(r3Wrong.json.ok, false)

  // Correct PIN unlocks & queues L2 approval
  const r3Ok = await dispatchRequest({
    method: 'POST',
    url: '/api/device/action',
    headers,
    body: { type: 'approve', slot: 3, confirmPin: r3Blocked.json.confirmPin },
  })
  assert.equal(r3Ok.status, 200)
  assert.equal(r3Ok.json.ok, true)
  assert.equal(r3Ok.json.code, 'CDX-303')

  // Verify commands actually queued on host
  const hbOut = hub.handleHeartbeat({ hostId: 'macbook-pro' })
  const queued = hbOut.commands || []
  assert.equal(queued.length, 3)
  assert.equal(queued[0].type, 'approve')
  assert.equal(queued[0].code, 'CLD-101')
  assert.equal(queued[1].type, 'approve')
  assert.equal(queued[1].code, 'AGY-202')
  assert.equal(queued[1].optionIndex, 2)
  assert.deepEqual(queued[1].answers[0].selected, ['直接全量上线'])
  assert.equal(queued[2].type, 'approve')
  assert.equal(queued[2].code, 'CDX-303')
})

test('Generic Edge Device API: raw PCM16 voice-turn + 16kHz PCM TTS output & resampling', async () => {
  // Check linear PCM16 resampler 24kHz -> 16kHz
  const pcm24 = Buffer.alloc(2400 * 2)
  for (let i = 0; i < 2400; i += 1) {
    pcm24.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 16000), i * 2)
  }
  const pcm16 = resamplePcm16Mono(pcm24, 24000, 16000)
  assert.equal(pcm16.length, 1600 * 2)

  let nowMs = 1_796_000_000_000
  const hub = new HubCore({ now: () => nowMs })
  seedDeviceHub(hub, nowMs)

  // Mock BYOK OpenAI-compat STT + TTS
  const fakePcm24 = Buffer.alloc(480 * 2, 0x12)
  const mockFetch = async (url) => {
    if (String(url).includes('/audio/transcriptions')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ text: '放行一号' }),
        text: async () => JSON.stringify({ text: '放行一号' }),
      }
    }
    if (String(url).includes('/audio/speech')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream' }),
        arrayBuffer: async () => fakePcm24.buffer.slice(fakePcm24.byteOffset, fakePcm24.byteOffset + fakePcm24.byteLength),
      }
    }
    throw new Error(`Unexpected fetch URL: ${url}`)
  }

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'edge-voice-token',
    requireToken: true,
    voiceVaultFile: '',
    voiceFetch: mockFetch,
  })
  const headers = { 'x-hub-token': 'edge-voice-token' }

  // Configure mock OpenAI-compat key + active profile using it for STT + TTS + native rule router brain
  const credRes = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'openai_compat',
      name: 'Mock Edge Voice',
      apiKey: 'sk-test-edge-voice-1234',
      baseUrl: 'https://api.openai.com/v1',
    },
  })
  assert.equal(credRes.status, 200)
  const credId = credRes.json.credential.id

  const profRes = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/profiles',
    headers,
    body: {
      id: 'edge-pcm-profile',
      name: 'Edge PCM',
      activate: true,
      stt: { provider: 'openai_compat', credId, model: 'whisper-1' },
      brain: { provider: 'native' },
      tts: { provider: 'openai_compat', credId, model: 'gpt-4o-mini-tts', voice: 'alloy' },
    },
  })
  assert.equal(profRes.status, 200)

  // Upload raw 16kHz PCM buffer (no base64) to /api/device/voice-turn
  const rawClip = Buffer.alloc(1600 * 2) // 0.1s 16kHz PCM16
  const turnRes = await dispatchRequest({
    method: 'POST',
    url: '/api/device/voice-turn?rate=16000',
    headers: {
      ...headers,
      'content-type': 'audio/pcm; rate=16000',
    },
    rawBuffer: rawClip,
  })
  assert.equal(turnRes.status, 200)
  assert.equal(turnRes.json.ok, true)
  assert.equal(turnRes.json.transcript, '放行一号')
  assert.equal(turnRes.json.executed, true)
  assert.equal(turnRes.json.actionType, 'approve')

  // Request raw 16kHz PCM audio stream from /api/device/tts-pcm
  const ttsRes = await dispatchRequest({
    method: 'GET',
    url: '/api/device/tts-pcm?text=%E5%B7%B2%E6%94%BE%E8%A1%8C%E4%B8%80%E5%8F%B7&rate=16000',
    headers,
  })
  assert.equal(ttsRes.status, 200)
  assert.ok(Buffer.isBuffer(ttsRes.buffer))
  assert.equal(ttsRes.buffer.length, 320 * 2) // 480 samples @24kHz -> 320 samples @16kHz
  assert.match(ttsRes.headers['content-type'], /audio\/pcm; rate=16000/)
})
