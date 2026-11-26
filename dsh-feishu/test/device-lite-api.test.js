import test from 'node:test'
import assert from 'node:assert/strict'

import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'
import { resamplePcm16Mono } from '../../hub/voice-copilot.js'
import {
  buildDeviceSetupInfo,
  flushDeviceSummaryTasks,
  resetDeviceSummaryCache,
  resetRecentDevices,
} from '../../hub/device-api.js'

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

test('3-Tier Practical Chinese Localization: native ZH passthrough, 0ms rule map, async BYOK small-model cache, and L2 raw-cmd safety', async () => {
  resetDeviceSummaryCache()
  const nowMs = 1_796_100_000_000
  const hub = new HubCore({ now: () => nowMs })

  hub.handleHeartbeat({
    hostId: 'mac-pro',
    hostName: 'MacBook Pro',
    bridgeState: {
      tasks: [
        { id: 't1', harness: 'claude', title: '修复支付单测', status: 'approval', updatedAt: nowMs - 1000, pendingApproval: true },
        { id: 't2', harness: 'antigravity', title: '数据库迁移', status: 'approval', updatedAt: nowMs - 2000, pendingApproval: true },
        { id: 't3', harness: 'codex', title: 'Release v0.9.21', status: 'approval', updatedAt: nowMs - 3000, pendingApproval: true },
        { id: 't4', harness: 'codex', title: 'Clean Cache', status: 'approval', updatedAt: nowMs - 4000, pendingApproval: true },
      ],
      approvals: [
        // Tier 2: Common English command -> 0ms rule localized + raw cmd preserved
        {
          code: 'R1',
          agentId: 't1',
          kind: 'approval',
          toolName: 'Bash',
          promptTitle: 'Allow running unit test suite?',
          commandLine: 'npm test -- device-lite-api.test.js',
          createdAt: nowMs - 40_000,
          options: [{ index: 1, label: 'Allow once' }, { index: 2, label: 'Deny' }],
        },
        // Tier 1: Already Chinese question -> 0ms passthrough, ZERO LLM calls
        {
          code: 'ZH1',
          agentId: 't2',
          kind: 'question',
          toolName: 'ask_question',
          promptTitle: '请选择数据库迁移方式',
          createdAt: nowMs - 30_000,
          questions: [{
            id: 'q_db',
            question: '希望采用哪种迁移策略？',
            options: [{ label: '只迁移测试库' }, { label: '灰度双写' }, { label: '暂缓执行' }],
          }],
        },
        // Tier 3: Complex English multi-choice -> async BYOK small model -> cached Chinese
        {
          code: 'ENQ1',
          agentId: 't3',
          kind: 'question',
          toolName: 'ask_question',
          promptTitle: 'Select release rollout strategy for v0.9.21',
          createdAt: nowMs - 20_000,
          questions: [{
            id: 'q_rel',
            question: 'Choose rollout target:',
            options: [{ label: 'Canary staging (10%)' }, { label: 'Full production rollout' }, { label: 'Hold and audit logs' }],
          }],
        },
        // L2 High-Risk English destructive command -> raw cmd NEVER hidden, L2 badge preserved
        {
          code: 'L2D',
          agentId: 't4',
          kind: 'approval',
          toolName: 'Bash',
          promptTitle: 'Wipe build folder & force push?',
          commandLine: 'rm -rf /tmp/old-build && git push --force origin main',
          createdAt: nowMs - 10_000,
          options: [{ index: 1, label: 'Allow' }, { index: 2, label: 'Deny' }],
        },
      ],
    },
  })

  let llmCallCount = 0
  const mockFetch = async () => {
    llmCallCount += 1
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '选择 v0.9.21 发布策略',
              options: ['灰度发布 10%', '全量正式上线', '暂缓并查日志'],
            }),
          },
        }],
      }),
    }
  }

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'zh-loc-token',
    requireToken: true,
    voiceVaultFile: '',
    voiceFetch: mockFetch,
  })
  const headers = { 'x-hub-token': 'zh-loc-token' }

  // Register a BYOK brain credential (DeepSeek / OpenAI-compat)
  const cred = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'openai_compat',
      name: 'Fast Brain',
      apiKey: 'sk-test-fast-brain',
      baseUrl: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
    },
  })
  assert.equal(cred.status, 200)

  // Poll #1 (0ms non-blocking): Tier 1 & Tier 2 are ALREADY Chinese; Tier 3 kicks off 1 async LLM call
  const poll1 = await dispatchRequest({ method: 'GET', url: '/api/device/digest', headers })
  assert.equal(poll1.status, 200)
  const [a1, a2, a3, a4] = poll1.json.approvals

  // Tier 2 (Bash npm test): instant Chinese tool/title/options + verbatim raw command
  assert.equal(a1.tool, '终端命令')
  assert.equal(a1.title, '运行自动化测试')
  assert.equal(a1.cmd, 'npm test -- device-lite-api.test.js')
  assert.deepEqual(a1.options, ['本次允许', '拒绝'])

  // Tier 1 (Native Chinese question): passed straight through
  assert.equal(a2.tool, '请你选择')
  assert.equal(a2.title, '请选择数据库迁移方式')
  assert.deepEqual(a2.options, ['只迁移测试库', '灰度双写', '暂缓执行'])

  // L2 High-Risk: explicit Chinese danger title + verbatim destructive command NEVER masked
  assert.equal(a4.risk, 'L2')
  assert.match(a4.title, /高危/)
  assert.equal(a4.cmd, 'rm -rf /tmp/old-build && git push --force origin main')

  // Wait for background Tier 3 small model to finish -> ONLY 1 LLM call (not 4!)
  await flushDeviceSummaryTasks()
  assert.equal(llmCallCount, 1, 'Only the complex English multi-choice should invoke the small model')

  // Poll #2 with since=<poll1.rev> -> rev MUST flip because Tier 3 cache now has Chinese translation!
  const poll2 = await dispatchRequest({
    method: 'GET',
    url: `/api/device/digest?since=${encodeURIComponent(poll1.json.rev)}`,
    headers,
  })
  assert.equal(poll2.status, 200)
  assert.equal(poll2.json.unchanged, false)
  assert.notEqual(poll2.json.rev, poll1.json.rev)
  const a3Zh = poll2.json.approvals[2]
  assert.equal(a3Zh.title, '选择 v0.9.21 发布策略')
  assert.deepEqual(a3Zh.options, ['灰度发布 10%', '全量正式上线', '暂缓并查日志'])

  // Poll #3 hits cache cleanly with ZERO additional LLM calls
  const poll3 = await dispatchRequest({
    method: 'GET',
    url: `/api/device/digest?since=${encodeURIComponent(poll2.json.rev)}`,
    headers,
  })
  assert.equal(poll3.json.unchanged, true)
  assert.equal(llmCallCount, 1)

  // Explicit lang=en returns raw English untouched
  const enPoll = await dispatchRequest({ method: 'GET', url: '/api/device/digest?lang=en', headers })
  assert.equal(enPoll.json.approvals[0].tool, 'Bash')
  assert.equal(enPoll.json.approvals[0].title, 'Allow running unit test suite?')
})

test('Beginner 1-Click Setup Wizard: /device-setup HTML, /api/device/setup-info LAN detection, mint-token & live seen tracker', async () => {
  resetRecentDevices()
  const nowMs = 1_796_200_000_000
  const hub = new HubCore({ now: () => nowMs })
  seedDeviceHub(hub, nowMs)

  // Verify pure LAN detection prefers 192.168.x.x on en0 and excludes 127.0.0.1
  const pureInfo = buildDeviceSetupInfo(hub, {
    reqOrigin: 'http://127.0.0.1:8788',
    listenPort: 8788,
    nowMs,
    interfaces: {
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      utun3: [{ family: 'IPv4', internal: false, address: '100.64.0.9' }],
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.25' }],
    },
  })
  assert.equal(pureInfo.recommendedUrl, 'http://192.168.1.25:8788')
  assert.ok(!pureInfo.candidateUrls.some(c => c.url.includes('127.0.0.1')))

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'wizard-admin-secret',
    requireToken: true,
    voiceVaultFile: '',
  })

  // 1. /device-setup serves public HTML without leaking admin token
  const pageRes = await dispatchRequest({ method: 'GET', url: '/device-setup' })
  assert.equal(pageRes.status, 200)
  assert.match(String(pageRes.body || ''), /连接 FoloToy AI Passport/)
  assert.ok(!String(pageRes.body || '').includes('wizard-admin-secret'))

  // 2. /api/device/setup-info & /api/device/mint-token require auth
  const unauthSetup = await dispatchRequest({ method: 'GET', url: '/api/device/setup-info' })
  assert.equal(unauthSetup.status, 401)
  const unauthMint = await dispatchRequest({ method: 'POST', url: '/api/device/mint-token', body: {} })
  assert.equal(unauthMint.status, 401)

  // 3. Authenticated mint-token creates a dedicated dev_ token
  const adminHeaders = { 'x-hub-token': 'wizard-admin-secret' }
  const mintRes = await dispatchRequest({
    method: 'POST',
    url: '/api/device/mint-token',
    headers: adminHeaders,
    body: { deviceName: '我的 AI Passport' },
  })
  assert.equal(mintRes.status, 200)
  assert.equal(mintRes.json.ok, true)
  assert.ok(mintRes.json.token.startsWith('dev_'))

  // 4. Device uses minted dev_ token to call /api/device/digest -> immediately visible in setup-info.recentDevices!
  const digRes = await dispatchRequest({
    method: 'GET',
    url: '/api/device/digest',
    headers: { 'x-hub-token': mintRes.json.token },
    remoteAddress: '192.168.1.88',
  })
  assert.equal(digRes.status, 200)
  assert.equal(digRes.json.ok, true)

  const infoRes = await dispatchRequest({
    method: 'GET',
    url: '/api/device/setup-info',
    headers: adminHeaders,
  })
  assert.equal(infoRes.status, 200)
  assert.equal(infoRes.json.ok, true)
  assert.equal(infoRes.json.onlineHostsCount, 1)
  assert.equal(infoRes.json.recentDevices.length, 1)
  assert.equal(infoRes.json.recentDevices[0].ip, '192.168.1.88')
  assert.equal(infoRes.json.recentDevices[0].deviceName, '我的 AI Passport')
})

test('Merged Seed-TTS 3.0 preserves MP3 + retry for Web/iOS and supports PCM16 for FoloToy Passport', async () => {
  const nowMs = 1_796_200_100_000
  const hub = new HubCore({ now: () => nowMs })
  seedDeviceHub(hub, nowMs)

  const reqFormats = []
  let mp3Attempts = 0
  const mockFetch = async (_url, opts = {}) => {
    const payload = JSON.parse(String(opts.body || '{}'))
    reqFormats.push(payload?.output_format)
    if (payload?.output_format?.format === 'mp3') {
      mp3Attempts += 1
      if (mp3Attempts === 1) {
        return { ok: false, status: 502, headers: new Map(), text: async () => '{"message":"transient 502"}' }
      }
      const fakeMp3 = Buffer.from('ID3-fake-mp3-audio')
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'audio/mpeg']]),
        arrayBuffer: async () => fakeMp3,
      }
    }
    // PCM16 response (16kHz mono 40 samples = 80 bytes)
    const fakePcm = Buffer.alloc(80, 7)
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'audio/pcm']]),
      arrayBuffer: async () => fakePcm,
    }
  }

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'seed3-merge-token',
    requireToken: true,
    voiceVaultFile: '',
    voiceFetch: mockFetch,
  })
  const headers = { 'x-hub-token': 'seed3-merge-token' }

  await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'volcengine_tts',
      label: 'Volc Seed 3.0',
      apiKey: 'volc-v3-api-key-test',
      resourceId: 'seed-tts-3.0',
      defaultVoice: 'multi_female_tuanzi_v3_uranus_bigtts',
      active: true,
    },
  })
  await dispatchRequest({
    method: 'POST',
    url: '/api/voice/profiles',
    headers,
    body: {
      name: 'Seed 3.0 Merge Check',
      activate: true,
      stt: { provider: 'native', model: 'browser-web-speech' },
      brain: { provider: 'native', model: 'deterministic' },
      tts: { provider: 'volcengine_tts', model: 'seed-tts-3.0', voice: 'multi_female_tuanzi_v3_uranus_bigtts' },
    },
  })

  // 1. Web / iOS normal /api/voice/tts uses mp3 and retries transient 502 seamlessly
  const webTts = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/tts',
    headers,
    body: { text: '主功能豆包播报正常' },
  })
  assert.equal(webTts.status, 200)
  assert.equal(webTts.json.ok, true)
  assert.equal(webTts.json.mimeType, 'audio/mpeg')
  assert.equal(mp3Attempts, 2, 'Should retry transient 502 once')

  // 2. Punctuation-only chunk still cleanly skipped without hitting upstream
  const punctTts = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/tts',
    headers,
    body: { text: '……！？' },
  })
  assert.equal(punctTts.status, 200)
  assert.equal(punctTts.json.skippedEmpty, true)

  // 3. FoloToy AI Passport /api/device/tts-pcm gets raw 16kHz PCM16 cleanly
  const devPcm = await dispatchRequest({
    method: 'POST',
    url: '/api/device/tts-pcm',
    headers,
    body: { text: '一号审批请求', sampleRate: 16000 },
  })
  assert.equal(devPcm.status, 200)
  assert.match(String(devPcm.headers?.['content-type'] || ''), /audio\/pcm/)
  assert.equal(devPcm.buffer.length, 80)
  assert.equal(reqFormats.at(-1)?.format, 'pcm')
  assert.equal(reqFormats.at(-1)?.sample_rate, 16000)
})
