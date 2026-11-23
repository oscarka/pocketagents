import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'
import { VoiceVault } from '../../hub/voice-vault.js'
import {
  buildGeminiThinkingConfig,
  classifyApprovalRisk,
  encodePcm16ToWav,
  extractSpokenPin,
  splitIntoProgressiveTtsChunks,
} from '../../hub/voice-copilot.js'

function createMockResponse({ status = 200, json = null, text = null, buffer = null, headers = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  )
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: name => normalizedHeaders.get(String(name).toLowerCase()) ?? null,
    },
    json: async () => (json !== null ? json : JSON.parse(text || '{}')),
    text: async () => (text !== null ? text : JSON.stringify(json ?? {})),
    arrayBuffer: async () => {
      const b = buffer ? Buffer.from(buffer) : Buffer.from(text || '', 'utf8')
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
  }
}

function seedHubWithTasksAndApprovals(hub) {
  hub.handleHeartbeat({
    hostId: 'mac-studio',
    hostName: 'Mac Studio',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      tasks: [
        {
          id: 'sess-alpha',
          title: 'Payment API Refactor',
          cwd: '/workspace/payment-api',
          harness: 'dsh',
          status: 'running',
          updatedAt: Date.now(),
          lastOutput: 'Running migration unit tests',
        },
      ],
      approvals: [
        {
          code: 'DSHA-101',
          agentId: 'sess-alpha',
          kind: 'approval',
          toolName: 'run_command',
          title: '运行单元测试 npm test',
          command: 'npm test',
        },
        {
          code: 'DSHA-999',
          agentId: 'sess-alpha',
          kind: 'approval',
          toolName: 'run_command',
          title: '清理生产缓存并强推分支',
          command: 'rm -rf /var/app/cache && git push --force origin main',
        },
      ],
      workspaces: ['/workspace/payment-api'],
    },
  })
}

describe('v0.9.9 BYOK Voice Copilot & Encrypted Vault', () => {
  it('encrypts credentials with AES-256-GCM (0600), masks public state, supports multi-key pool hot-switch, and rejects tampering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pa-voice-vault-'))
    const vaultFile = join(dir, 'voice-vault.enc.json')
    try {
      const vault1 = new VoiceVault({ vaultFile })
      await vault1.init()

      // Neutral out-of-the-box defaults
      const initPub = vault1.toPublicState()
      assert.equal(initPub.prefs.activeProfileId, 'native')
      assert.equal(initPub.prefs.l2Policy, 'pin')
      assert.equal(initPub.prefs.useByokForChatStt, false)
      assert.equal(initPub.prefs.useByokForChatTts, false)
      assert.equal(initPub.credentials.length, 0)

      const secret1 = 'AQ.AbTestGeminiPrimaryKey_9876543210'
      const secret2 = 'AIzaSySecondaryBackupKey_1122334455'
      const r1 = await vault1.upsertCredential({ provider: 'gemini', label: '主 Gemini', apiKey: secret1 })
      assert.equal(r1.ok, true)
      const r2 = await vault1.upsertCredential({ provider: 'gemini', label: '备 Gemini', apiKey: secret2, active: false })
      assert.equal(r2.ok, true)

      // Raw disk file must NOT contain any plaintext secrets and must have 0600 mode
      const rawFile = await readFile(vaultFile, 'utf8')
      assert.equal(rawFile.includes(secret1), false)
      assert.equal(rawFile.includes(secret2), false)
      const parsedEnv = JSON.parse(rawFile)
      assert.equal(parsedEnv.alg, 'aes-256-gcm')
      const st = await stat(vaultFile)
      assert.equal(st.mode & 0o777, 0o600)

      // Public state must NEVER leak plaintext keys
      const pubJson = JSON.stringify(vault1.toPublicState())
      assert.equal(pubJson.includes(secret1), false)
      assert.equal(pubJson.includes(secret2), false)

      // Hot-switch active key in pool
      assert.equal(vault1.resolveCredential({ provider: 'gemini' }).id, r1.credential.id)
      const sw = await vault1.activateCredential(r2.credential.id)
      assert.equal(sw.ok, true)
      assert.equal(vault1.resolveCredential({ provider: 'gemini' }).id, r2.credential.id)

      // Reload from encrypted disk file in fresh instance
      const vault2 = new VoiceVault({ vaultFile })
      await vault2.init()
      assert.equal(vault2.state.credentials.length, 2)
      assert.equal(vault2.resolveCredential({ provider: 'gemini' }).apiKey, secret2)

      // Delete active key promotes remaining key automatically
      await vault2.deleteCredential(r2.credential.id)
      assert.equal(vault2.resolveCredential({ provider: 'gemini' }).apiKey, secret1)

      // Tampering ciphertext causes clean fallback to empty native state (no crash, no plaintext leak)
      const tampered = JSON.parse(await readFile(vaultFile, 'utf8'))
      tampered.ciphertext = Buffer.from('tampered-bytes').toString('base64')
      await writeFile(vaultFile, JSON.stringify(tampered), 'utf8')
      const vault3 = new VoiceVault({ vaultFile })
      await vault3.init()
      assert.equal(vault3.state.credentials.length, 0)
      assert.equal(vault3.state.prefs.activeProfileId, 'native')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies L0/L1/L2 approval risks accurately and parses ZH/EN/Arabic spoken 3-digit PINs', () => {
    assert.equal(classifyApprovalRisk({ toolName: 'read_file' }).level, 'L0')
    assert.equal(classifyApprovalRisk({ kind: 'question', toolName: 'ask_user_question' }).level, 'L0')
    assert.equal(classifyApprovalRisk({ toolName: 'run_command', command: 'npm test' }).level, 'L1')
    assert.equal(classifyApprovalRisk({ toolName: 'run_command', command: 'rm -rf ./dist' }).level, 'L2')
    assert.equal(classifyApprovalRisk({ toolName: 'run_command', command: 'git push --force origin main' }).level, 'L2')
    assert.equal(classifyApprovalRisk({ toolName: 'run_command', command: 'DROP TABLE users;' }).level, 'L2')
    assert.equal(classifyApprovalRisk({ toolName: 'run_command', command: 'sudo chmod 777 /etc' }).level, 'L2')

    assert.equal(extractSpokenPin('739'), '739')
    assert.equal(extractSpokenPin('确认码 7 3 9 放行'), '739')
    assert.equal(extractSpokenPin('确认码是 7-3-9'), '739')
    assert.equal(extractSpokenPin('七三九'), '739')
    assert.equal(extractSpokenPin('念一下七、三、九'), '739')
    assert.equal(extractSpokenPin('幺洞九'), '109')
    assert.equal(extractSpokenPin('七百三十九'), '739')
    assert.equal(extractSpokenPin('两百零八'), '208')
    assert.equal(extractSpokenPin('二百五'), '250')
    assert.equal(extractSpokenPin('seven three nine'), '739')
    assert.equal(extractSpokenPin('confirm oh two five'), '025')
    assert.equal(extractSpokenPin('12'), '')
    assert.equal(extractSpokenPin('1234'), '')

    // Progressive TTS chunker keeps first sentence short for fast TTFA
    const chunks = splitIntoProgressiveTtsChunks('测试全部通过了。接下来我会帮你把所有改动汇总发到控制台，并且等待你的下一次确认指令。')
    assert.ok(chunks.length >= 2)
    assert.ok(chunks[0].length <= 32)
  })

  it('maps Gemini thinkingConfig safely for 2.5 vs 3.8/4-hydrogen and text vs audio STT', () => {
    assert.deepEqual(buildGeminiThinkingConfig('gemini-2.5-flash', 'off', { isAudioStt: false }), { thinkingBudget: 0 })
    // Critical live Cloud Run finding: NEVER pass thinkingBudget=0 on 2.5-flash audio STT
    assert.equal(buildGeminiThinkingConfig('gemini-2.5-flash', 'off', { isAudioStt: true }), undefined)
    // Critical live Cloud Run finding: 3.8-flash and 4-hydrogen reject 0/MINIMAL -> minimum is 'low'
    assert.deepEqual(buildGeminiThinkingConfig('gemini-3.8-flash', 'off', { isAudioStt: false }), { thinkingLevel: 'low' })
    assert.deepEqual(buildGeminiThinkingConfig('gemini-4-hydrogen', 'off', { isAudioStt: false }), { thinkingLevel: 'low' })
    assert.deepEqual(buildGeminiThinkingConfig('gemini-3.8-flash', 'high', { isAudioStt: false }), { thinkingLevel: 'high' })
  })

  it('enforces HUB_TOKEN auth (401) and 1ms deterministic L2 3-digit PIN fast-path with zero LLM hallucination', async () => {
    let nowMs = 1_700_000_000_000
    const hub = new HubCore({ now: () => nowMs })
    seedHubWithTasksAndApprovals(hub)

    let llmCalls = 0
    const mockFetch = async () => {
      llmCalls += 1
      return createMockResponse({ status: 500, json: { error: 'should not be called in native or PIN fast-path' } })
    }

    const { dispatchRequest } = createHubServer({
      hub,
      token: 'super-secret-hub-token',
      requireToken: true,
      voiceVaultFile: '',
      voiceFetch: mockFetch,
    })

    // 1. Unauthorized requests must get 401
    const unauth = await dispatchRequest({ method: 'GET', url: '/api/voice/config' })
    assert.equal(unauth.status, 401)

    const authHeaders = { 'x-hub-token': 'super-secret-hub-token' }

    // 2. Approving L1 approval ("放行 DSHA-101") succeeds directly and enqueues approve command
    const l1Res = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: '放行 DSHA-101', voiceSessionId: 'walk-test-1' },
    })
    assert.equal(l1Res.status, 200)
    assert.equal(l1Res.json.execution.executed, true)
    assert.equal(hub.hosts.get('mac-studio').commands.length, 1)
    assert.equal(hub.hosts.get('mac-studio').commands[0].code, 'DSHA-101')

    // 3. Approving L2 high-risk approval ("放行 DSHA-999") MUST block and issue 3-digit PIN challenge
    const l2Req = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: '放行 DSHA-999', voiceSessionId: 'walk-test-1' },
    })
    assert.equal(l2Req.status, 200)
    assert.equal(l2Req.json.execution.executed, false)
    assert.equal(l2Req.json.execution.requiresPin, true)
    const pin = l2Req.json.pinChallenge.pin
    assert.match(pin, /^\d{3}$/)
    assert.equal(hub.hosts.get('mac-studio').commands.length, 1) // still NOT approved!

    // 4. Bare "放行" without PIN is intercepted at 1ms fast-path
    const bareRes = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: '放行吧', voiceSessionId: 'walk-test-1' },
    })
    assert.equal(bareRes.json.fastPath, 'l2_pin_missing')
    assert.equal(bareRes.json.execution.executed, false)
    assert.equal(llmCalls, 0)

    // 5. Wrong PIN decrements remaining attempts without approving
    const wrongPin = pin === '123' ? '456' : '123'
    const wrongRes = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: `确认码 ${wrongPin}`, voiceSessionId: 'walk-test-1' },
    })
    assert.equal(wrongRes.json.fastPath, 'l2_pin_mismatch')
    assert.equal(wrongRes.json.execution.executed, false)
    assert.equal(hub.hosts.get('mac-studio').commands.length, 1)

    // 6. Correct spoken PIN approves deterministically in fast-path!
    const zhMap = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
    const spokenZhPin = pin.split('').map(d => zhMap[Number(d)]).join('')
    const okRes = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: `确认码 ${spokenZhPin}`, voiceSessionId: 'walk-test-1' },
    })
    assert.equal(okRes.json.fastPath, 'l2_pin_matched')
    assert.equal(okRes.json.execution.executed, true)
    assert.equal(okRes.json.pinChallenge, null)
    assert.equal(hub.hosts.get('mac-studio').commands.length, 2)
    assert.equal(hub.hosts.get('mac-studio').commands[1].code, 'DSHA-999')
    assert.equal(llmCalls, 0)

    // 7. screen_only policy blocks voice approval completely without issuing PIN
    await dispatchRequest({
      method: 'POST',
      url: '/api/voice/prefs',
      headers: authHeaders,
      body: { l2Policy: 'screen_only' },
    })
    const blockedRes = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: '放行 DSHA-999', voiceSessionId: 'walk-test-2' },
    })
    assert.equal(blockedRes.json.execution.blockedByPolicy, 'screen_only')
    assert.equal(blockedRes.json.pinChallenge, null)

    // 8. Expiry test: issue PIN then advance clock past 30s TTL
    await dispatchRequest({
      method: 'POST',
      url: '/api/voice/prefs',
      headers: authHeaders,
      body: { l2Policy: 'pin' },
    })
    const expIssue = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: '放行 DSHA-999', voiceSessionId: 'walk-test-exp' },
    })
    const expPin = expIssue.json.pinChallenge.pin
    nowMs += 31_000
    const expTry = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: authHeaders,
      body: { text: expPin, voiceSessionId: 'walk-test-exp' },
    })
    assert.equal(expTry.json.fastPath, 'l2_pin_expired')
    assert.equal(expTry.json.execution.executed, false)
  })

  it('executes Volcengine Flash ASR (20000003 silence + ok), STT fallback chain, Gemini/Ark brains, Seed-TTS NDJSON, Gemini PCM->WAV, and Dry-Run vs real HubCore dispatch', async () => {
    const hub = new HubCore()
    seedHubWithTasksAndApprovals(hub)

    const seenRequests = []
    let failVolcAsrOnce = false
    let volcSilenceMode = false
    let rejectThinkingOnce = true

    const mockFetch = async (url, init = {}) => {
      const urlStr = String(url)
      seenRequests.push({ url: urlStr, headers: init.headers || {}, body: init.body })

      // Volcengine Flash ASR
      if (urlStr.includes('recognize/flash')) {
        if (failVolcAsrOnce) {
          failVolcAsrOnce = false
          return createMockResponse({ status: 500, json: { message: 'upstream temporary error' } })
        }
        if (volcSilenceMode) {
          volcSilenceMode = false
          return createMockResponse({
            status: 200,
            headers: { 'x-api-status-code': '20000003', 'x-api-message': 'silence' },
            json: {},
          })
        }
        return createMockResponse({
          status: 200,
          headers: { 'x-api-status-code': '20000000' },
          json: { result: { text: '帮我新建任务跑一遍 pytest' } },
        })
      }

      // Volcengine Seed-TTS 2.0 NDJSON stream
      if (urlStr.includes('tts/unidirectional')) {
        const chunk1 = Buffer.from('ID3fake-mp3-part-1').toString('base64')
        const chunk2 = Buffer.from('fake-mp3-part-2').toString('base64')
        const ndjson = [
          JSON.stringify({ code: 0, data: chunk1 }),
          JSON.stringify({ code: 0, data: chunk2 }),
          JSON.stringify({ code: 20000000, message: 'ok' }),
        ].join('\n')
        return createMockResponse({
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: ndjson,
        })
      }

      // Gemini API (STT / Brain / TTS)
      if (urlStr.includes('generativelanguage.googleapis.com')) {
        const payload = JSON.parse(String(init.body || '{}'))
        if (payload?.generationConfig?.responseModalities?.includes('AUDIO')) {
          const rawPcm = Buffer.alloc(480)
          return createMockResponse({
            status: 200,
            json: {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'audio/L16;codec=pcm;rate=24000',
                          data: rawPcm.toString('base64'),
                        },
                      },
                    ],
                  },
                },
              ],
            },
          })
        }
        const isAudioInput = Boolean(payload?.contents?.[0]?.parts?.some(p => p.inlineData))
        if (isAudioInput) {
          return createMockResponse({
            status: 200,
            json: { candidates: [{ content: { parts: [{ text: 'Gemini 降级转写成功' }] } }] },
          })
        }
        return createMockResponse({
          status: 200,
          json: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        spokenReply: '好的，已为你新建跑 pytest 的任务。',
                        action: { type: 'create_task', hostId: 'mac-studio', prompt: 'run pytest', cwd: '/workspace/payment-api' },
                      }),
                    },
                  ],
                },
              },
            ],
          },
        })
      }

      // OpenAI-compatible (Volcengine Ark / DeepSeek)
      if (urlStr.includes('/chat/completions')) {
        const payload = JSON.parse(String(init.body || '{}'))
        if (payload.thinking && rejectThinkingOnce) {
          rejectThinkingOnce = false
          return createMockResponse({ status: 400, json: { error: { message: 'unknown field: thinking' } } })
        }
        return createMockResponse({
          status: 200,
          json: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    spokenReply: '已把追问发给 Payment API Refactor。',
                    action: { type: 'send_prompt', hostId: 'mac-studio', agentId: 'sess-alpha', prompt: '查看失败用例' },
                  }),
                },
              },
            ],
          },
        })
      }

      return createMockResponse({ status: 404, json: { error: `unexpected url ${urlStr}` } })
    }

    const { dispatchRequest } = createHubServer({
      hub,
      token: 'tok',
      requireToken: true,
      voiceVaultFile: '',
      voiceFetch: mockFetch,
    })
    const auth = { 'x-hub-token': 'tok' }

    // Add independent credentials (Volc ASR, separate Volc TTS, Gemini AQ.Ab..., Ark OpenAI-compat)
    const asrCred = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/credentials',
      headers: auth,
      body: { provider: 'volcengine_asr', label: 'ASR App', appId: '111111', accessToken: 'tok-asr', resourceId: 'volc.bigasr.auc_turbo' },
    })
    const ttsCred = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/credentials',
      headers: auth,
      body: { provider: 'volcengine_tts', label: 'TTS App', appId: '222222', accessToken: 'tok-tts', resourceId: 'seed-tts-2.0' },
    })
    const gemCred = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/credentials',
      headers: auth,
      body: { provider: 'gemini', label: 'Gemini AQ', apiKey: 'AQ.AbTestKey999999' },
    })
    const arkCred = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/credentials',
      headers: auth,
      body: { provider: 'openai_compat', label: 'Ark DeepSeek', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark-secret-123' },
    })
    assert.equal(asrCred.status, 200)
    assert.equal(ttsCred.status, 200)
    assert.equal(gemCred.status, 200)
    assert.equal(arkCred.status, 200)

    // Create hybrid profile: Volc Flash ASR (fallback -> Gemini) + Gemini 2.5 Brain (thinking=off) + Volc Seed-TTS 2.0
    const profRes = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/profiles',
      headers: auth,
      body: {
        name: '混搭实战方案',
        activate: true,
        stt: {
          provider: 'volcengine_asr',
          credId: asrCred.json.credential.id,
          model: 'volc.bigasr.auc_turbo',
          fallbackChain: [{ provider: 'gemini', credId: gemCred.json.credential.id, model: 'gemini-2.5-flash', thinkingLevel: 'low' }],
        },
        brain: { provider: 'gemini', credId: gemCred.json.credential.id, model: 'gemini-2.5-flash', thinkingLevel: 'off' },
        tts: { provider: 'volcengine_tts', credId: ttsCred.json.credential.id, model: 'seed-tts-2.0', voice: 'zh_female_vv_uranus_bigtts' },
      },
    })
    assert.equal(profRes.status, 200)

    const sampleWavB64 = encodePcm16ToWav(Buffer.alloc(3200), 16000, 1).toString('base64')

    // 1. Volcengine Flash ASR silence 20000003 is handled cleanly as silence (NOT error!)
    volcSilenceMode = true
    const silRes = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/stt',
      headers: auth,
      body: { audioBase64: sampleWavB64, mimeType: 'audio/wav' },
    })
    assert.equal(silRes.status, 200)
    assert.equal(silRes.json.ok, true)
    assert.equal(silRes.json.silence, true)
    assert.equal(silRes.json.text, '')

    // 2. Volcengine Flash ASR normal transcription
    const sttOk = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/stt',
      headers: auth,
      body: { audioBase64: sampleWavB64, mimeType: 'audio/wav' },
    })
    assert.equal(sttOk.json.ok, true)
    assert.equal(sttOk.json.text, '帮我新建任务跑一遍 pytest')

    // 3. Ordered STT Fallback Chain: Volc ASR 500 -> auto falls back to Gemini STT
    failVolcAsrOnce = true
    const sttFb = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/stt',
      headers: auth,
      body: { audioBase64: sampleWavB64, mimeType: 'audio/wav' },
    })
    assert.equal(sttFb.json.ok, true)
    assert.equal(sttFb.json.provider, 'gemini')
    assert.equal(sttFb.json.text, 'Gemini 降级转写成功')
    assert.equal(sttFb.json.attempts.length, 2)

    // 4. Dry-Run Brain turn does NOT enqueue command on HubCore
    const dryTurn = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: auth,
      body: { text: '新建任务跑 pytest', dryRun: true },
    })
    assert.equal(dryTurn.json.ok, true)
    assert.equal(dryTurn.json.execution.dryRun, true)
    assert.equal(dryTurn.json.execution.executed, false)
    assert.equal(dryTurn.json.execution.commandPayload.type, 'new_session')
    assert.equal(hub.hosts.get('mac-studio').commands.length, 0)

    // 5. Real Brain turn enqueues `new_session` into HubCore
    const realTurn = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: auth,
      body: { text: '新建任务跑 pytest', dryRun: false },
    })
    assert.equal(realTurn.json.ok, true)
    assert.equal(realTurn.json.execution.executed, true)
    assert.equal(hub.hosts.get('mac-studio').commands.length, 1)
    assert.equal(hub.hosts.get('mac-studio').commands[0].type, 'new_session')
    assert.equal(hub.hosts.get('mac-studio').commands[0].prompt, 'run pytest')

    // 6. Volcengine Seed-TTS 2.0 NDJSON assembly uses independent TTS cred (appId 222222)
    const volcTts = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/tts',
      headers: auth,
      body: { text: '任务已经启动' },
    })
    assert.equal(volcTts.status, 200)
    assert.equal(volcTts.json.ok, true)
    assert.equal(volcTts.json.mimeType, 'audio/mpeg')
    assert.equal(Buffer.from(volcTts.json.audioBase64, 'base64').toString('utf8'), 'ID3fake-mp3-part-1fake-mp3-part-2')

    // 7. Gemini TTS wraps raw 24kHz PCM into RIFF/WAVE header
    const gemTts = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/tts',
      headers: auth,
      body: {
        text: 'hello',
        stageOverride: { provider: 'gemini', credId: gemCred.json.credential.id, model: 'gemini-2.5-flash-preview-tts', voice: 'Kore' },
      },
    })
    assert.equal(gemTts.status, 200)
    assert.equal(gemTts.json.mimeType, 'audio/wav')
    const wavHeader = Buffer.from(gemTts.json.audioBase64, 'base64').subarray(0, 4).toString('ascii')
    assert.equal(wavHeader, 'RIFF')

    // 8. OpenAI-compat Ark Brain retries gracefully if upstream rejects `thinking` param, then enqueues `prompt`
    const arkTurn = await dispatchRequest({
      method: 'POST',
      url: '/api/voice/turn',
      headers: auth,
      body: {
        text: '追问一下失败用例',
        stageOverride: { provider: 'openai_compat', credId: arkCred.json.credential.id, model: 'deepseek-v4-1-flash-261017', thinkingLevel: 'off' },
      },
    })
    assert.equal(arkTurn.json.ok, true)
    assert.equal(arkTurn.json.execution.executed, true)
    assert.equal(hub.hosts.get('mac-studio').commands.length, 2)
    assert.equal(hub.hosts.get('mac-studio').commands[1].type, 'prompt')
  })
})
