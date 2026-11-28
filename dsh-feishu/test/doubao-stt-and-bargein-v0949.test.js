import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { HubCore } from '../../hub/hub-core.js'
import { VoiceCopilotEngine } from '../../hub/voice-copilot.js'
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
})
