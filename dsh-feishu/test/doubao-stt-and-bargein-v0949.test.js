import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { HubCore } from '../../hub/hub-core.js'
import { VoiceCopilotEngine, runNativeRuleRouter } from '../../hub/voice-copilot.js'
import { VoiceVault } from '../../hub/voice-vault.js'
import { evaluateBargeInUtterance } from '../../hub/web/src/voice/bargeInGate.js'

test('v0.9.49 Volcengine ASR: formats hotwords as [{word}], enables enable_ddc, and auto-retries transient 502 on both flash and async submit', async () => {
  const hub = new HubCore()
  await hub.init()
  const vault = new VoiceVault({ vaultFile: '', secret: 'test-secret' })
  await vault.init()
  const cred = await vault.upsertCredential({
    provider: 'volcengine_asr',
    label: 'Doubao ASR',
    appId: 'app-123',
    accessToken: 'tok-xyz',
    resourceId: 'volc.seedasr.auc',
  })

  // 1. Async standard AUC (/submit + /query): first /submit returns HTTP 502, second succeeds with fresh X-Api-Request-Id!
  const calls = []
  let submitAttempt = 0
  const mockFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    calls.push({ url: String(url), headers: init?.headers || {}, body })
    if (String(url).endsWith('/submit')) {
      submitAttempt += 1
      if (submitAttempt === 1) {
        return {
          ok: false,
          status: 502,
          headers: new Headers({}),
          async json() { return { message: 'Bad Gateway' } },
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-api-status-code': '20000000' }),
        async json() { return {} },
      }
    }
    if (String(url).endsWith('/query')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-api-status-code': '20000000' }),
        async json() { return { result: { text: '帮我把 Antigravity 升级一下' } } },
      }
    }
    if (String(url).includes('/recognize/flash')) {
      const flashCalls = calls.filter(c => c.url.includes('/recognize/flash')).length
      if (flashCalls === 1) {
        return {
          ok: false,
          status: 502,
          headers: new Headers({}),
          async json() { return { message: 'Upstream 502' } },
        }
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-api-status-code': '20000000' }),
        async json() { return { result: { text: '放行一号审批' } } },
      }
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const engine = new VoiceCopilotEngine({ hub, vault, fetchImpl: mockFetch })

  const asyncRes = await engine.runSingleStt(
    { provider: 'volcengine_asr', credId: cred.id, model: 'volc.seedasr.auc' },
    { audioBase64: 'UklGRiQAAABXQVZF', hotwords: ['Antigravity', 'DeepSeek', 'a', 'Antigravity'] },
  )
  assert.equal(asyncRes.ok, true)
  assert.equal(asyncRes.text, '帮我把 Antigravity 升级一下')

  const submits = calls.filter(c => c.url.endsWith('/submit'))
  assert.equal(submits.length, 2, 'must retry once on 502')
  assert.notEqual(
    submits[0].headers['X-Api-Request-Id'],
    submits[1].headers['X-Api-Request-Id'],
    'retry submit must use a fresh X-Api-Request-Id',
  )
  assert.equal(submits[1].body.request.enable_ddc, true, 'must enable enable_ddc spoken smoothing')
  assert.equal(submits[1].body.request.enable_itn, true)
  assert.equal(submits[1].body.request.enable_punc, true)
  const parsedContext = JSON.parse(submits[1].body.request.corpus.context)
  assert.deepEqual(
    parsedContext.hotwords,
    [{ word: 'Antigravity' }, { word: 'DeepSeek' }],
    'Volcengine hotwords MUST be [{ word }] object array and deduplicated/filtered',
  )

  // 2. Flash endpoint (/recognize/flash): first returns 502, second succeeds!
  const flashRes = await engine.runSingleStt(
    { provider: 'volcengine_asr', credId: cred.id, model: 'volc.bigasr.auc_turbo' },
    { audioBase64: 'UklGRiQAAABXQVZF', hotwords: ['PocketAgents'] },
  )
  assert.equal(flashRes.ok, true)
  assert.equal(flashRes.text, '放行一号审批')
  const flashCalls = calls.filter(c => c.url.includes('/recognize/flash'))
  assert.equal(flashCalls.length, 2, 'flash endpoint must retry once on 502')
  assert.equal(flashCalls[1].body.request.enable_ddc, true)
})

test('v0.9.49 evaluateBargeInUtterance strictly rejects fillers, noise, short murmurs, and TTS echo while accepting real commands & instructions', () => {
  const speaking = '注意，MacBook Air 收到一号待审批请求，运行 npm test，请说放行或拒绝。'

  // 1. Empty / fillers / backchannels -> REJECT
  for (const noise of ['', '   ', '嗯', '嗯嗯', '啊', '哦', '哈哈', '呃', '那个', '好吧', 'uh', 'hmm']) {
    const v = evaluateBargeInUtterance(noise, speaking)
    assert.equal(v.accept, false, `noise/filler "${noise}" MUST be rejected`)
  }

  // 2. Short ambiguous non-command murmurs -> REJECT
  for (const murmur of ['对', '这里', '真的吗', '行吗']) {
    const v = evaluateBargeInUtterance(murmur, speaking)
    assert.equal(v.accept, false, `ambiguous short murmur "${murmur}" MUST be rejected`)
  }

  // 3. TTS acoustic self-echo -> REJECT
  const echoSub = evaluateBargeInUtterance('收到一号待审批请求', speaking)
  assert.equal(echoSub.accept, false)
  assert.equal(echoSub.reason, 'tts_echo_substring')

  const echoOverlap = evaluateBargeInUtterance('收到一号待审批运行测试', speaking)
  assert.equal(echoOverlap.accept, false)
  assert.equal(echoOverlap.reason, 'tts_echo_overlap')

  // 4. Short explicit action commands -> ACCEPT even when words appear in TTS prompt ("请说放行或拒绝")!
  for (const cmd of ['放行', '拒绝', '同意', '允许', '一号放行', '739']) {
    const v = evaluateBargeInUtterance(cmd, speaking)
    assert.equal(v.accept, true, `explicit command "${cmd}" MUST be accepted`)
    assert.equal(v.stopOnly, false)
  }

  // 5. Stop-only commands -> ACCEPT with stopOnly: true
  for (const stopCmd of ['停一下', '别说了', '跳过', 'stop']) {
    const v = evaluateBargeInUtterance(stopCmd, speaking)
    assert.equal(v.accept, true, `stop command "${stopCmd}" MUST be accepted`)
    assert.equal(v.stopOnly, true)
  }

  // 6. Substantive natural-language instructions -> ACCEPT
  const instr = evaluateBargeInUtterance('帮我把登录页按钮改成蓝色', speaking)
  assert.equal(instr.accept, true)
  assert.equal(instr.stopOnly, false)
})

test('v0.9.49 Frontend Chat Hold-to-Talk, Triage Deck, and Walk Mode barge-in wiring contracts', () => {
  const rootDir = resolve(process.cwd())
  const holdSrc = readFileSync(resolve(rootDir, 'hub/web/src/hooks/useVoiceInput.ts'), 'utf8')
  const triageSrc = readFileSync(resolve(rootDir, 'hub/web/src/triage-deck.js'), 'utf8')
  const walkSrc = readFileSync(resolve(rootDir, 'hub/web/src/components/VoiceCopilotSheets.tsx'), 'utf8')

  assert.match(holdSrc, /__dshVoiceByokStt/)
  assert.match(holdSrc, /stopAndTranscribe\(\{\s*tailGraceMs:\s*150\s*\}\)/)
  assert.match(triageSrc, /__dshVoiceByokStt/)
  assert.match(triageSrc, /stopAndTranscribe\(\{\s*tailGraceMs:\s*150\s*\}\)/)
  assert.match(walkSrc, /evaluateBargeInUtterance/)
  assert.match(walkSrc, /WalkBargeInMonitor/)
  assert.match(walkSrc, /playerRef\.current\?\.setVolume\(0\.25\)/)
  assert.match(walkSrc, /barge_in_rejected/)
  assert.match(walkSrc, /barge_in_accepted/)
  assert.match(walkSrc, /hasPendingApproval/)
  assert.match(walkSrc, /walk-receipt-log/)
})

test('v0.9.49 Semantic approval flow: contextual barge-in, brain ETIMEDOUT retry, anti-false-claim guard, native natural consent & L2 PIN safety', async () => {
  const speaking = '1号待审批，电脑想运行测试脚本，请说放行或拒绝。'

  // 1. Barge-in during pending approval accepts natural consent/refusal while still rejecting pure fillers & questions
  for (const okPhrase of ['可以', '可以呀', '好的', '好吧', '行', '行吧', '没问题', '让它跑吧', 'ok', '不要', '算了', '不行', '先别']) {
    const v = evaluateBargeInUtterance(okPhrase, speaking, { hasPendingApproval: true })
    assert.equal(v.accept, true, `semantic decision "${okPhrase}" MUST be accepted during pending approval`)
  }
  for (const stillReject of ['嗯', '嗯嗯', '啊', '哦', '哈哈', '那个', '可以吗', '行吗', '真的吗']) {
    const v = evaluateBargeInUtterance(stillReject, speaking, { hasPendingApproval: true })
    assert.equal(v.accept, false, `filler/question "${stillReject}" MUST still be rejected even with pending approval`)
  }
  // Outside pending approval, casual "好吧/ok/可以" remain rejected
  assert.equal(evaluateBargeInUtterance('好吧', speaking, { hasPendingApproval: false }).accept, false)
  assert.equal(evaluateBargeInUtterance('可以', speaking, { hasPendingApproval: false }).accept, false)

  // 2. Native rule router natural consent/refusal/question discrimination
  const baseCtx = {
    activeHostId: 'mac-air',
    pendingApprovals: [{ hostId: 'mac-air', code: 'AGY-1', slot: 1, title: '运行测试', riskLevel: 'L1' }],
    tasks: [],
  }
  for (const okPhrase of ['可以', '可以呀', '没问题', '好的', '行吧', '让它跑吧', 'ok']) {
    assert.equal(runNativeRuleRouter(okPhrase, baseCtx).action.type, 'approve', `"${okPhrase}" must approve`)
  }
  for (const noPhrase of ['不可以', '不行', '不要', '算了', '先别执行']) {
    assert.equal(runNativeRuleRouter(noPhrase, baseCtx).action.type, 'reject', `"${noPhrase}" must reject`)
  }
  assert.equal(runNativeRuleRouter('可以吗？', baseCtx).action.type, 'none', 'question must NOT approve')

  // 3. Brain ETIMEDOUT retry + explicit execution confirmation + anti-false-claim guard + L2 PIN protection
  const hub = new HubCore()
  await hub.init()
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'Air',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      tasks: [{ id: 's1', title: '测试会话', status: 'approval' }],
      approvals: [
        { code: 'AGY-SAFE-1', agentId: 's1', kind: 'approval', toolName: 'run_command', title: '运行测试', commandLine: 'npm test', createdAt: Date.now() - 2000 },
      ],
    },
  })
  const vault = new VoiceVault({ vaultFile: '', secret: 'test-secret' })
  await vault.init()
  const brainCredRes = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'Ark DeepSeek',
    apiKey: 'sk-test-123',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'deepseek-v4-1-flash-261017',
  })
  const profRes = await vault.upsertProfile({
    name: 'DeepSeek Semantic',
    brain: { provider: 'openai_compat', credId: brainCredRes.credential.id, model: 'deepseek-v4-1-flash-261017', thinkingLevel: 'off' },
  })
  const profId = profRes.profile.id
  await vault.updatePrefs({ activeProfileId: profId })

  let brainCalls = 0
  let brainMode = 'retry_then_approve'
  const mockFetch = async () => {
    brainCalls += 1
    if (brainMode === 'retry_then_approve' && brainCalls === 1) {
      const err = new Error('fetch failed')
      err.cause = Object.assign(new Error('connect ETIMEDOUT 101.126.13.31:443'), { code: 'ETIMEDOUT' })
      throw err
    }
    if (brainMode === 'retry_then_approve') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              // Intentionally brief reply without "已放行" -> server must prefix "已放行 1号，"
              content: JSON.stringify({ spokenReply: '好的，马上运行。', action: { type: 'approve', hostId: 'mac-air', code: 'AGY-SAFE-1', slot: 1 } }),
            },
          }],
        }),
      }
    }
    // Simulate buggy LLM claiming "已放行" while returning action.type="none"
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({ spokenReply: '好的，已放行 1号。', action: { type: 'none' } }),
          },
        }],
      }),
    }
  }

  const engine = new VoiceCopilotEngine({ hub, vault, fetchImpl: mockFetch })
  const focus = { hostId: 'mac-air', code: 'AGY-SAFE-1', slot: 1, announcedAt: Date.now() - 1000 }

  // Attempt 1 fails with ETIMEDOUT -> auto-retries on attempt 2 and approves with clear confirmation!
  const res1 = await engine.runBrainTurn({ text: '可以', voiceSessionId: 'sem1', focusedApproval: focus, profileId: profId })
  assert.equal(brainCalls, 2, 'brain must auto-retry transient ETIMEDOUT')
  assert.equal(res1.ok, true)
  assert.equal(res1.execution.executed, true)
  assert.match(res1.spokenReply, /^已放行 1号/, 'executed approval must always give unmistakable spoken confirmation')

  // Anti-false-claim guard: if LLM outputs action="none" yet claims "已放行", server blocks the lie and reopens mic!
  brainMode = 'false_claim'
  const res2 = await engine.runBrainTurn({ text: '嗯可以吧', voiceSessionId: 'sem2', focusedApproval: focus, profileId: profId })
  assert.equal(res2.ok, true)
  assert.equal(res2.execution.executed, false)
  assert.match(res2.spokenReply, /目前还没执行/, 'server must block false "已放行" claim when nothing executed')
  assert.equal(res2.expectReply, true, 'must reopen mic when approval remains unexecuted')

  // L2 high-risk safety: saying "可以" on rm -rf MUST STILL trigger 3-digit PIN guard, never blind approve!
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'Air',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      tasks: [{ id: 's2', title: '清理任务', status: 'approval' }],
      approvals: [
        { code: 'AGY-L2-9', agentId: 's2', kind: 'approval', toolName: 'run_command', title: '强制删除目录', commandLine: 'rm -rf ./dist', createdAt: Date.now() - 1000 },
      ],
    },
  })
  const l2Res = await engine.runBrainTurn({ text: '可以', voiceSessionId: 'sem3', profileId: 'native' })
  assert.equal(l2Res.execution.executed, false)
  assert.equal(l2Res.execution.requiresPin, true, 'L2 destructive command must STILL require 3-digit PIN even on natural "可以"')
})
