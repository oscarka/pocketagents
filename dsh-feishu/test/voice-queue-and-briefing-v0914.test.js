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
      detailLevel: 'concise',
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

test('v0.9.45 native zero-WebView background briefing, /api/voice/diag ring buffer, and Walk Mode anti-reload guard', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const hub = new HubCore()
  const logs = []
  const { dispatchRequest } = createHubServer({
    hub,
    token: 'voice-diag-token-0945',
    requireToken: true,
    voiceVaultFile: '',
    logger: { info: m => logs.push(m), warn: () => {}, error: () => {} },
  })
  const headers = { 'x-hub-token': 'voice-diag-token-0945' }

  // 1. /api/voice/diag requires auth
  const unauth = await dispatchRequest({ method: 'GET', url: '/api/voice/diag', headers: {} })
  assert.equal(unauth.status, 401)

  // 2. POST + GET /api/voice/diag records structured native audio events and logs compact line
  const postRes = await dispatchRequest({
    method: 'POST',
    url: '/api/voice/diag',
    headers,
    body: {
      source: 'ios-native',
      version: '1.1.5',
      event: 'bg_briefing_done',
      appState: 'background',
      osStatus: 0,
      latencyMs: 1420,
      detail: 'src=apns_native kind=approval chunks=2/2 mode=playback_voicePrompt_duck',
    },
  })
  assert.equal(postRes.status, 200)
  assert.equal(postRes.json.ok, true)
  assert.equal(postRes.json.recorded, 1)
  assert.ok(logs.some(line => line.includes('[voice-diag]') && line.includes('playback_voicePrompt_duck')))

  const getRes = await dispatchRequest({ method: 'GET', url: '/api/voice/diag?limit=10', headers })
  assert.equal(getRes.status, 200)
  assert.equal(getRes.json.ok, true)
  assert.equal(getRes.json.events.length, 1)
  assert.equal(getRes.json.events[0].event, 'bg_briefing_done')
  assert.equal(getRes.json.events[0].version, '1.1.5')

  // 3. Ring buffer enforces 120-event cap without unbounded memory growth
  const batch = Array.from({ length: 20 }, (_, idx) => ({
    event: `ev_${idx}`,
    detail: 'x'.repeat(500),
    latencyMs: idx * 10,
  }))
  for (let i = 0; i < 7; i += 1) {
    const r = await dispatchRequest({ method: 'POST', url: '/api/voice/diag', headers, body: { events: batch } })
    assert.equal(r.status, 200)
  }
  const capped = await dispatchRequest({ method: 'GET', url: '/api/voice/diag?limit=200', headers })
  assert.equal(capped.json.total, 120)
  assert.equal(capped.json.events.length, 120)
  assert.ok(capped.json.events[0].detail.length <= 320)

  // 4. Web controller protects Walk Mode from Service Worker / SSE auto-reload wipeout
  const rootDir = resolve(process.cwd())
  const controllerSrc = readFileSync(resolve(rootDir, 'hub/web/src/controller.js'), 'utf8')
  assert.match(controllerSrc, /hasActiveUserInputInProgress\(\)[\s\S]{0,220}__dshWalkModeOpen \|\| window\.__dshWalkKeepAliveActive/)
  assert.match(controllerSrc, /triggerAppShellUpgradeReload\(nextBuild\)[\s\S]{0,280}walkBusy/)
  assert.match(controllerSrc, /__dshGetVoiceAuthToken:\s*\(\)\s*=>\s*getToken\(\)/)

  // 5. Walk Mode frontend syncs native context, delegates hidden briefings, and deduplicates atomically
  const voiceSheetsSrc = readFileSync(resolve(rootDir, 'hub/web/src/components/VoiceCopilotSheets.tsx'), 'utf8')
  const walkAudioSrc = readFileSync(resolve(rootDir, 'hub/web/src/voice/walkAudio.ts'), 'utf8')
  assert.match(voiceSheetsSrc, /buildWalkNativeExtraOpts/)
  assert.match(voiceSheetsSrc, /__dshOnNativeBackgroundBriefingsSynced/)
  assert.match(voiceSheetsSrc, /delegateNativeBackgroundBriefing/)
  assert.match(voiceSheetsSrc, /claimNativeBriefingKey/)
  assert.match(walkAudioSrc, /speakBackgroundBriefing/)
  assert.match(walkAudioSrc, /drainNativeSpokenBriefings/)

  // 6. Optional local iOS native shell contract check (when ios-local-shell is present)
  const nativeAudioPath = resolve(rootDir, 'ios-local-shell/PocketAgentsShell/NativeAudioBridge.swift')
  if (existsSync(nativeAudioPath)) {
    const swiftSrc = readFileSync(nativeAudioPath, 'utf8')
    assert.match(swiftSrc, /shellVersion = "1\.1\.6"/)
    assert.match(swiftSrc, /AVAudioConverter/)
    assert.match(swiftSrc, /startBargeInMonitor/)
    assert.match(swiftSrc, /\/api\/voice\/briefing/)
    assert.match(swiftSrc, /\/api\/voice\/tts/)
    assert.match(swiftSrc, /\/api\/voice\/diag/)
    assert.match(swiftSrc, /\.voicePrompt, \[\.mixWithOthers, \.duckOthers\]/)
    assert.match(swiftSrc, /playback_exclusive/)
    assert.match(swiftSrc, /isNativeBackgroundBriefingRunning \|\| self\.speechPlayer != nil/)
    assert.doesNotMatch(swiftSrc, /__dshOnBackgroundPushWake/)
  }
})

test('v0.9.48 Walk Mode auto-listen after briefing: synchronous walkPhaseRef update, earcon-before-mic guard, and live native-briefing auto-listen handoff', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const rootDir = resolve(process.cwd())
  const walkSrc = readFileSync(resolve(rootDir, 'hub/web/src/components/VoiceCopilotSheets.tsx'), 'utf8')
  const walkAudioSrc = readFileSync(resolve(rootDir, 'hub/web/src/voice/walkAudio.ts'), 'utf8')

  // 1. setWalkPhase & setWalkOpen MUST update their refs synchronously before Preact renders
  assert.match(walkSrc, /const setWalkPhase\s*=\s*\([^)]*\)\s*=>\s*\{\s*walkPhaseRef\.current\s*=\s*next;\s*setWalkPhaseState\(next\)/)
  assert.match(walkSrc, /const setWalkOpen\s*=\s*\([^)]*\)\s*=>\s*\{\s*walkOpenRef\.current\s*=\s*next;\s*setWalkOpenState\(next\)/)

  // 2. speakWalkReply guarantees walkPhaseRef leaves 'speaking' even if chunk list was empty
  assert.match(walkSrc, /if\s*\(walkPhaseRef\.current\s*===\s*'speaking'\)\s*\{\s*setWalkPhase\('idle'\)/)

  // 3. playEarcon('listen') plays and settles (~210ms) BEFORE recorderRef.current.start() arms VAD
  const earconPos = walkSrc.indexOf("playEarcon('listen');\n      await new Promise")
  const recStartPos = walkSrc.indexOf('await recorderRef.current!.start({', earconPos)
  assert.ok(earconPos > 0 && recStartPos > earconPos, 'listen earcon must complete before mic VAD arms')
  assert.match(walkSrc, /noSpeechTimeoutMs:\s*effectiveNoSpeechMs/)
  assert.match(walkSrc, /aiTabActiveRef\.current\s*\?\s*14000\s*:\s*7000/)

  // 4. Live native zero-WebView background briefing callback triggers auto-listen when fresh,
  //    while stale visibilitychange drain does NOT hijack mic
  assert.match(walkSrc, /__dshOnNativeBackgroundBriefingsSynced\s*=\s*\(items:\s*any\[\]\)\s*=>\s*applyNativeSpokenBriefings\(items,\s*\{\s*triggerAutoListen:\s*true\s*\}\)/)
  assert.match(walkSrc, /applyNativeSpokenBriefings\(items,\s*\{\s*triggerAutoListen:\s*false\s*\}\)/)

  // 5. Native diag tracing helper exported in walkAudio.ts and wired in VoiceCopilotSheets.tsx
  assert.match(walkAudioSrc, /export function postNativeVoiceDiag/)
  assert.match(walkSrc, /postNativeVoiceDiag\('auto_listen_after_briefing'/)
  assert.match(walkSrc, /postNativeVoiceDiag\('listen_started'/)
})
