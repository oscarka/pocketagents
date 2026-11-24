import test from 'node:test'
import assert from 'node:assert/strict'

import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'
import {
  extractSpokenSlotNumber,
  extractSpokenOptionIndex,
  sanitizeTextForVoiceBriefing,
  computeDenyOptionIndex,
  formatApprovalBriefingSpeech,
} from '../../hub/voice-copilot.js'

function createMockJsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function seedMultiHostHub(hub, nowMs) {
  hub.handleHeartbeat({
    hostId: 'mac-mini',
    hostName: 'Mac mini',
    bridgeState: {
      tasks: [
        {
          id: 'agy-ide:blender-1',
          title: '食梦貘blender',
          cwd: '/Users/dev/blender',
          status: 'approval',
          updatedAt: nowMs - 2000,
          lastOutput: '正在等待上传参考图到 Tripo Studio。',
        },
      ],
      approvals: [
        {
          code: 'AGY-56A39C-145',
          agentId: 'agy-ide:blender-1',
          kind: 'approval',
          toolName: 'browser_upload',
          promptTitle: 'Allow upload "lumo_v2_nose_left.png" to https://studio.tripo3d.ai?',
          title: 'Allow upload "lumo_v2_nose_left.png" to https://studio.tripo3d.ai?',
          commandLine: 'lumo_v2_nose_left.png -> https://studio.tripo3d.ai',
          createdAt: nowMs - 10_000,
          options: [
            { index: 1, label: 'Yes, allow this time' },
            { index: 2, label: 'No (tell the agent what to do instead)' },
          ],
        },
      ],
    },
  })

  hub.handleHeartbeat({
    hostId: 'macbook-air',
    hostName: 'MacBook Air',
    bridgeState: {
      tasks: [
        {
          id: 'agy-ide:pocket-2',
          title: 'pocketagents',
          cwd: '/Users/dev/pocketagents',
          status: 'approval',
          updatedAt: nowMs - 1000,
          lastOutput: '已完成方案分析，请你选择发布策略。',
        },
        {
          id: 'agy-ide:done-3',
          title: '语音总管升级',
          cwd: '/Users/dev/pocketagents',
          status: 'idle',
          updatedAt: nowMs - 500,
          lastConclusionAt: nowMs - 500,
          lastOutput: '已完成 `hub/voice-copilot.js` 队列改造，195 项测试全部通过，文件在 /Users/dev/pocketagents/hub/voice-copilot.js。要不要现在直接部署上线？',
        },
      ],
      approvals: [
        {
          code: 'AGY-99BBCC-20',
          agentId: 'agy-ide:pocket-2',
          kind: 'question',
          toolName: 'ask_question',
          promptTitle: '请选择本次部署方案',
          title: '请选择本次部署方案',
          createdAt: nowMs - 5_000,
          questions: [
            {
              id: 'q_deploy',
              question: '你想采用哪个部署策略？',
              options: [
                { label: '仅部署测试服' },
                { label: '直接热更新生产服' },
                { label: '暂不部署' },
              ],
            },
          ],
        },
      ],
    },
  })
}

test('v0.9.14 spoken slot & option parsers cleanly separate approval slots from option indices', () => {
  assert.equal(extractSpokenSlotNumber('放行 1 号'), 1)
  assert.equal(extractSpokenSlotNumber('拒绝二号'), 2)
  assert.equal(extractSpokenSlotNumber('第一条允许'), 1)
  assert.equal(extractSpokenSlotNumber('2号选第三个'), 2)
  assert.equal(extractSpokenOptionIndex('2号选第三个'), 3)
  // Choosing an option MUST NOT be misparsed as an approval slot
  assert.equal(extractSpokenSlotNumber('选第二个'), 0)
  assert.equal(extractSpokenOptionIndex('选第二个'), 2)
  assert.equal(extractSpokenOptionIndex('选 B'), 2)
  assert.equal(extractSpokenOptionIndex('选项3'), 3)

  // Dynamic deny option index: 2-option browser popup -> 2, 4-option command -> 4
  assert.equal(
    computeDenyOptionIndex({ options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }] }),
    2,
  )
  assert.equal(
    computeDenyOptionIndex({
      options: [
        { index: 1, label: 'Yes' },
        { index: 2, label: 'Always in chat' },
        { index: 3, label: 'Always' },
        { index: 4, label: 'No' },
      ],
    }),
    4,
  )

  // Voice sanitizer strips paths, code, markdown cleanly
  const cleaned = sanitizeTextForVoiceBriefing('已修复 `/Users/cc/app/index.js` 中的 **Bug**，详见 [报告](https://example.com/a) commit `a7281e1deadbeef1234`！')
  assert.ok(!cleaned.includes('/Users/cc'))
  assert.ok(!cleaned.includes('https://'))
  assert.ok(!cleaned.includes('**'))
  assert.match(cleaned, /已修复/)
})

test('v0.9.14 multi-approval anti-mixup guard refuses blind approve, supports slot #1 -> auto-advance #2 -> option choice, and dynamic 2-option deny', async () => {
  let nowMs = 1_795_500_000_000
  const hub = new HubCore({ now: () => nowMs })
  seedMultiHostHub(hub, nowMs)

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'voice-v0914-token',
    requireToken: true,
    voiceVaultFile: '',
  })
  const headers = { 'x-hub-token': 'voice-v0914-token' }

  // 1. Vague "放行" with 2 pending approvals and NO fresh focus MUST refuse to guess!
  const ambig = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/turn',
    headers,
    body: { text: '放行', voiceSessionId: 'walk-v14' },
  })
  assert.equal(ambig.status, 200)
  assert.equal(ambig.json.execution.executed, false)
  assert.equal(ambig.json.expectReply, true)
  assert.match(ambig.json.spokenReply, /1号.*2号/)
  assert.equal(hub.hosts.get('mac-mini').commands.length, 0)
  assert.equal(hub.hosts.get('macbook-air').commands.length, 0)

  // 2. Explicit "拒绝 1 号" denies the 2-option browser upload popup with dynamic optionIndex=2 AND advances to #2!
  const deny1 = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/turn',
    headers,
    body: { text: '拒绝 1 号', voiceSessionId: 'walk-v14' },
  })
  assert.equal(deny1.status, 200)
  assert.equal(deny1.json.execution.executed, true)
  assert.equal(hub.hosts.get('mac-mini').commands.length, 1)
  assert.equal(hub.hosts.get('mac-mini').commands[0].type, 'deny')
  assert.equal(hub.hosts.get('mac-mini').commands[0].code, 'AGY-56A39C-145')
  assert.equal(hub.hosts.get('mac-mini').commands[0].optionIndex, 2)
  // Auto-advanced to #2 question with options read aloud + locked focus + expectReply=true
  assert.equal(deny1.json.expectReply, true)
  assert.equal(deny1.json.nextFocusedApproval?.code, 'AGY-99BBCC-20')
  assert.match(deny1.json.spokenReply, /还有下一条.*选项1.*选项2.*直接热更新生产服/)

  // 3. Immediately saying "选第二个" resolves unambiguously via locked focus on #2!
  nowMs += 3000
  const pick2 = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/turn',
    headers,
    body: { text: '选第二个', voiceSessionId: 'walk-v14' },
  })
  assert.equal(pick2.status, 200)
  assert.equal(pick2.json.execution.executed, true)
  assert.equal(hub.hosts.get('macbook-air').commands.length, 1)
  const qCmd = hub.hosts.get('macbook-air').commands[0]
  assert.equal(qCmd.code, 'AGY-99BBCC-20')
  assert.equal(qCmd.optionIndex, 2)
  assert.deepEqual(qCmd.answers, [{ questionId: 'q_deploy', selected: ['直接热更新生产服'] }])
})

test('v0.9.14 POST /api/voice/briefing reads numbered question options, summarizes completed tasks via BYOK brain, and persists Walk Mode audio prefs', async () => {
  let nowMs = 1_795_500_100_000
  const hub = new HubCore({ now: () => nowMs })
  seedMultiHostHub(hub, nowMs)

  let brainCalls = 0
  const mockFetch = async () => {
    brainCalls += 1
    return createMockJsonResponse({
      candidates: [
        {
          content: {
            parts: [{ text: '语音队列改造已完成，195 项测试全绿，询问你是否现在直接部署上线？' }],
          },
        },
      ],
    })
  }

  const { dispatchRequest } = createHubServer({
    hub,
    token: 'voice-v0914-token',
    requireToken: true,
    voiceVaultFile: '',
    voiceFetch: mockFetch,
  })
  const headers = { 'x-hub-token': 'voice-v0914-token' }

  // 1. Briefing for #2 question reads options & locks focus so immediate "选B" hits #2 even while 2 approvals exist
  const qBrief = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/briefing',
    headers,
    body: {
      kind: 'approval',
      hostId: 'macbook-air',
      code: 'AGY-99BBCC-20',
      voiceSessionId: 'walk-brief-1',
    },
  })
  assert.equal(qBrief.status, 200)
  assert.equal(qBrief.json.ok, true)
  assert.equal(qBrief.json.expectReply, true)
  assert.equal(qBrief.json.focusedApproval?.code, 'AGY-99BBCC-20')
  assert.match(qBrief.json.spokenReply, /2号提问.*选项1.*仅部署测试服.*选项2.*直接热更新生产服/)

  nowMs += 2000
  const replyB = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/turn',
    headers,
    body: { text: '选B', voiceSessionId: 'walk-brief-1' },
  })
  assert.equal(replyB.status, 200)
  assert.equal(replyB.json.execution.executed, true)
  assert.equal(hub.hosts.get('macbook-air').commands[0].code, 'AGY-99BBCC-20')
  assert.equal(hub.hosts.get('macbook-air').commands[0].optionIndex, 2)

  // 2. Configure BYOK Gemini brain & verify completed task briefing produces AI oral summary + expectReply=true for question
  await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: { provider: 'gemini', label: 'My Gemini', apiKey: 'AIzaTestBriefingKey1234', active: true },
  })
  await dispatchRequest({
    method: 'POST',
    url: '/api/voice/profiles',
    headers,
    body: {
      name: 'Gemini Brain Test',
      activate: true,
      stt: { provider: 'native', model: 'browser-web-speech' },
      brain: { provider: 'gemini', model: 'gemini-2.5-flash', thinkingLevel: 'off' },
      tts: { provider: 'native', model: 'browser-speech-synthesis' },
    },
  })

  const doneBrief = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/briefing',
    headers,
    body: {
      kind: 'completed',
      hostId: 'macbook-air',
      agentId: 'agy-ide:done-3',
      voiceSessionId: 'walk-brief-1',
    },
  })
  assert.equal(doneBrief.status, 200)
  assert.equal(doneBrief.json.ok, true)
  assert.equal(doneBrief.json.summarizedByBrain, true)
  assert.equal(doneBrief.json.expectReply, true)
  assert.equal(brainCalls, 1)
  assert.match(doneBrief.json.spokenReply, /MacBook Air的「语音总管升级」已完成：语音队列改造已完成/)

  // 3. Persist new Walk Mode prefs (`autoListenAfterBriefing` & `duckMusicMode`)
  const prefsRes = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/prefs',
    headers,
    body: { autoListenAfterBriefing: false, duckMusicMode: true },
  })
  assert.equal(prefsRes.status, 200)
  assert.equal(prefsRes.json.prefs.autoListenAfterBriefing, false)
  assert.equal(prefsRes.json.prefs.duckMusicMode, true)

  // Helper smoke check for 2-option browser upload briefing
  const uploadSpeech = formatApprovalBriefingSpeech({
    slot: 1,
    hostName: 'Mac mini',
    sessionTitle: '食梦貘blender',
    promptTitle: 'Allow upload "lumo.png" to https://studio.tripo3d.ai?',
    riskLevel: 'L1',
    options: [{ index: 1, label: 'Yes' }, { index: 2, label: 'No' }],
  })
  assert.match(uploadSpeech, /1号待审批.*食梦貘blender.*选项1允许，选项2拒绝/)
})

test('v0.9.16 Volcengine ASR->TTS cloneSecretFromCredId allows official openspeech reuse and blocks cross-provider/custom-host exfiltration', async () => {
  const hub = new HubCore()
  const { dispatchRequest } = createHubServer({
    hub,
    token: 'voice-v0916-token',
    requireToken: true,
    voiceVaultFile: '',
  })
  const headers = { 'x-hub-token': 'voice-v0916-token' }

  const asrSave = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'volcengine_asr',
      label: '火山语音 ASR',
      baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      apiKey: 'volc-secret-key-9876543210',
      resourceId: 'volc.bigasr.auc_turbo',
    },
  })
  assert.equal(asrSave.status, 200)
  const asrId = asrSave.json.credential.id

  // 1. Official Volcengine TTS cloning from ASR succeeds without client ever knowing plaintext
  const ttsClone = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'volcengine_tts',
      label: '火山语音 TTS',
      baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      cloneSecretFromCredId: asrId,
      resourceId: 'seed-tts-2.0',
      defaultVoice: 'zh_female_vv_uranus_bigtts',
    },
  })
  assert.equal(ttsClone.status, 200)
  assert.equal(ttsClone.json.ok, true)
  assert.equal(ttsClone.json.credential.authSummary, asrSave.json.credential.authSummary)

  // 2. Attempting to clone Volcengine key to an arbitrary external host MUST fail (400)
  const evilHostClone = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'volcengine_tts',
      baseUrl: 'https://attacker.example.com/steal',
      cloneSecretFromCredId: asrId,
    },
  })
  assert.equal(evilHostClone.status, 400)

  // 3. Attempting cross-provider cloning to openai_compat MUST fail (400)
  const crossProvClone = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/credentials',
    headers,
    body: {
      provider: 'openai_compat',
      baseUrl: 'https://api.deepseek.com/v1',
      cloneSecretFromCredId: asrId,
    },
  })
  assert.equal(crossProvClone.status, 400)
})
