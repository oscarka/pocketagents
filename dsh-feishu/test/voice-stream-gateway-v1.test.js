import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { HubCore } from '../../hub/hub-core.js'
import { createHubServer } from '../../hub/server.js'
import { VoiceVault } from '../../hub/voice-vault.js'
import {
  buildVolcSaucAudioPacket,
  buildVolcSaucFullRequest,
  buildVolcSaucHeader,
  parseVolcSaucServerFrame,
  resolveVoiceStreamPlan,
} from '../../hub/voice-stream-gateway.js'
import { acceptWebSocketUpgrade, connectWebSocket } from '../../hub/ws-lite.js'
import { resolveClientStreamCapability } from '../../hub/web/src/voice/provider-routing.js'

function buildMockVolcSaucServerResponse(payloadObj, { flags = 0x01, sequence = 1, compress = true } = {}) {
  const raw = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  const body = compress ? gzipSync(raw) : raw
  const header = buildVolcSaucHeader(0x9, flags, 0x1, compress ? 0x1 : 0x0)
  const parts = [header]
  if ((flags & 0x01) !== 0) {
    const seqBuf = Buffer.alloc(4)
    seqBuf.writeInt32BE(sequence, 0)
    parts.push(seqBuf)
  }
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(body.length, 0)
  parts.push(lenBuf, body)
  return Buffer.concat(parts)
}

function buildMockVolcSaucErrorFrame(errorCode, msg) {
  const msgBuf = Buffer.from(String(msg || 'error'), 'utf8')
  const header = buildVolcSaucHeader(0x0f, 0x0, 0x1, 0x0)
  const codeBuf = Buffer.alloc(4)
  codeBuf.writeUInt32BE(errorCode, 0)
  const sizeBuf = Buffer.alloc(4)
  sizeBuf.writeUInt32BE(msgBuf.length, 0)
  return Buffer.concat([header, codeBuf, sizeBuf, msgBuf])
}

async function startMockWsServer(onConnection) {
  const activeWs = new Set()
  const srv = createServer((req, res) => {
    res.writeHead(404)
    res.end('not found')
  })
  srv.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocketUpgrade(req, socket, head)
    if (ws) {
      activeWs.add(ws)
      ws.on('close', () => activeWs.delete(ws))
      onConnection(ws, req)
    }
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const { port } = srv.address()
  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: () => new Promise(resolve => {
      for (const ws of activeWs) ws.terminate()
      srv.closeAllConnections?.()
      srv.close(() => resolve())
    }),
  }
}

function closeHttpServer(srv) {
  return new Promise(resolve => {
    srv.closeAllConnections?.()
    srv.close(() => resolve())
  })
}

function waitForJsonMessage(ws, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error('Timed out waiting for WebSocket JSON message'))
    }, timeoutMs)
    const onMsg = (data, isBinary) => {
      if (isBinary) return
      let obj
      try { obj = JSON.parse(String(data)) } catch { return }
      if (predicate(obj)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(obj)
      }
    }
    ws.on('message', onMsg)
  })
}

test('ws-lite handles custom headers, text, large binary (>65KB), ping/pong, and HTTP 401 rejection', async () => {
  let receivedHeaders = null
  const mock = await startMockWsServer((ws, req) => {
    receivedHeaders = req.headers
    ws.on('message', (data, isBinary) => {
      if (isBinary) ws.sendBinary(data)
      else ws.sendText(`echo:${data}`)
    })
  })
  try {
    const client = await connectWebSocket(`${mock.wsUrl}/test?foo=bar`, {
      headers: {
        Authorization: 'Bearer sk-test-123',
        'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
      },
    })
    assert.equal(receivedHeaders.authorization, 'Bearer sk-test-123')
    assert.equal(receivedHeaders['x-api-resource-id'], 'volc.seedasr.sauc.duration')

    const textPromise = new Promise(r => client.once('message', (d, bin) => r({ d, bin })))
    client.sendText('hello-world')
    const textRes = await textPromise
    assert.equal(textRes.bin, false)
    assert.equal(textRes.d, 'echo:hello-world')

    // Large binary > 65535 bytes tests 64-bit extended length framing
    const bigBuf = Buffer.alloc(70_000, 0x5a)
    const binPromise = new Promise(r => client.once('message', (d, bin) => r({ d, bin })))
    client.sendBinary(bigBuf)
    const binRes = await binPromise
    assert.equal(binRes.bin, true)
    assert.equal(binRes.d.length, 70_000)
    assert.equal(binRes.d[69_999], 0x5a)

    const pongPromise = new Promise(r => client.once('pong', p => r(p.toString('utf8'))))
    client.ping('hb')
    assert.equal(await pongPromise, 'hb')

    client.close(1000, 'done')
  } finally {
    await mock.close()
  }

  // Non-101 rejection
  const denySrv = createServer((req, res) => { res.writeHead(401); res.end('nope') })
  denySrv.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 401 Unauthorized\r\nX-Api-Message: invalid key\r\nContent-Length: 4\r\n\r\ndeny')
    socket.destroy()
  })
  await new Promise(resolve => denySrv.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = denySrv.address()
    await assert.rejects(
      connectWebSocket(`ws://127.0.0.1:${port}/denied`),
      /HTTP 401.*invalid key/,
    )
  } finally {
    await new Promise(resolve => denySrv.close(() => resolve()))
  }
})

test('Volcengine SAUC v3 binary frame encoder/decoder handles gzip, 4-byte sequence offset, and 0x0F error frames', () => {
  const fullPkt = buildVolcSaucFullRequest({ user: { uid: 'u1' }, audio: { format: 'pcm', rate: 16000 } })
  assert.equal(fullPkt[0], 0x11)
  assert.equal(fullPkt[1], 0x10)
  assert.equal(fullPkt[2], 0x11)

  const audioPkt = buildVolcSaucAudioPacket(Buffer.alloc(3200, 1), { isLast: true, compress: false })
  assert.equal(audioPkt[0], 0x11)
  assert.equal(audioPkt[1], 0x22) // msgType=2, flags=2 (last)
  assert.equal(audioPkt.readUInt32BE(4), 3200)

  // Server response WITH sequence offset (flags=0x01)
  const respWithSeq = buildMockVolcSaucServerResponse(
    { result: { utterances: [{ text: '帮我新建个任务', definite: true, start_time: 0, end_time: 900 }] } },
    { flags: 0x01, sequence: 7, compress: true },
  )
  const parsedSeq = parseVolcSaucServerFrame(respWithSeq)
  assert.equal(parsedSeq.isError, false)
  assert.equal(parsedSeq.sequence, 7)
  assert.equal(parsedSeq.payload.result.utterances[0].text, '帮我新建个任务')
  assert.equal(parsedSeq.payload.result.utterances[0].definite, true)

  // Server response WITHOUT sequence offset (flags=0x00)
  const respNoSeq = buildMockVolcSaucServerResponse({ result: { text: '你好' } }, { flags: 0x00, compress: false })
  const parsedNoSeq = parseVolcSaucServerFrame(respNoSeq)
  assert.equal(parsedNoSeq.sequence, null)
  assert.equal(parsedNoSeq.payload.result.text, '你好')

  // Server 0x0F error frame
  const errFrame = buildMockVolcSaucErrorFrame(45000001, 'resource not granted')
  const parsedErr = parseVolcSaucServerFrame(errFrame)
  assert.equal(parsedErr.isError, true)
  assert.equal(parsedErr.errorCode, 45000001)
  assert.match(parsedErr.errorMessage, /resource not granted/)
})

test('resolveVoiceStreamPlan & resolveClientStreamCapability accurately route Route A & Route B combinations', async () => {
  const vault = new VoiceVault()
  await vault.init()

  // 1. Volcengine batch AUC -> not streaming (returns helpful hint)
  const aucCred = await vault.upsertCredential({
    provider: 'volcengine_asr',
    label: '豆包录音版',
    apiKey: 'volc-k1',
    resourceId: 'volc.seedasr.auc',
  })
  await vault.upsertProfile({
    name: '豆包录音',
    stt: { provider: 'volcengine_asr', credId: aucCred.credential.id, model: 'volc.seedasr.auc' },
    brain: { provider: 'native' },
    tts: { provider: 'native' },
    activate: true,
  })
  const aucPlan = resolveVoiceStreamPlan(vault)
  assert.equal(aucPlan.supported, false)
  assert.match(aucPlan.reason, /volc\.seedasr\.sauc\.duration/)
  assert.equal(resolveClientStreamCapability(vault.toPublicState()).supported, false)

  // 2. Switch Volcengine to SAUC streaming 2.0 -> Route B volcengine_sauc!
  const saucCred = await vault.upsertCredential({
    id: aucCred.credential.id,
    provider: 'volcengine_asr',
    label: '豆包流式 2.0',
    apiKey: 'volc-k1',
    resourceId: 'volc.seedasr.sauc.duration',
  })
  await vault.upsertProfile({
    id: vault.state.prefs.activeProfileId,
    name: '豆包流式 + DeepSeek',
    stt: { provider: 'volcengine_asr', credId: saucCred.credential.id, model: 'volc.seedasr.sauc.duration' },
    brain: { provider: 'native' },
    tts: { provider: 'native' },
    activate: true,
  })
  const saucPlan = resolveVoiceStreamPlan(vault)
  assert.equal(saucPlan.supported, true)
  assert.equal(saucPlan.mode, 'pipeline')
  assert.equal(saucPlan.adapter, 'volcengine_sauc')
  assert.equal(resolveClientStreamCapability(vault.toPublicState()).supported, true)

  // 3. DashScope key in Route B (pure ASR qwen3-asr-flash-realtime) + DeepSeek brain!
  const dsCred = await vault.upsertCredential({
    provider: 'dashscope',
    label: '阿里云百炼',
    apiKey: 'sk-dash-123',
    defaultModel: 'qwen3-asr-flash-realtime',
  })
  const deepseekCred = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-ds-123',
    defaultModel: 'deepseek-chat',
  })
  await vault.upsertProfile({
    id: vault.state.prefs.activeProfileId,
    name: '千问纯听写 + DeepSeek',
    stt: { provider: 'dashscope', credId: dsCred.credential.id, model: 'qwen3-asr-flash-realtime' },
    brain: { provider: 'openai_compat', credId: deepseekCred.credential.id, model: 'deepseek-chat' },
    tts: { provider: 'native' },
    activate: true,
  })
  const qwenAsrPlan = resolveVoiceStreamPlan(vault)
  assert.equal(qwenAsrPlan.supported, true)
  assert.equal(qwenAsrPlan.mode, 'pipeline')
  assert.equal(qwenAsrPlan.adapter, 'qwen_asr_realtime')
  assert.equal(qwenAsrPlan.profile.brain.credId, deepseekCred.credential.id)

  // 4. Deepgram Nova-3 (Global Route B)
  const dgCred = await vault.upsertCredential({
    provider: 'deepgram',
    label: 'Deepgram Nova-3',
    apiKey: 'dg-key-123',
    defaultModel: 'nova-3',
  })
  await vault.upsertProfile({
    id: vault.state.prefs.activeProfileId,
    name: 'Deepgram + DeepSeek',
    stt: { provider: 'deepgram', credId: dgCred.credential.id, model: 'nova-3' },
    brain: { provider: 'openai_compat', credId: deepseekCred.credential.id, model: 'deepseek-chat' },
    tts: { provider: 'native' },
    activate: true,
  })
  const dgPlan = resolveVoiceStreamPlan(vault)
  assert.equal(dgPlan.supported, true)
  assert.equal(dgPlan.adapter, 'deepgram')

  // 5. Route A: 1-Key All-in-One Qwen Omni Realtime
  await vault.updatePrefs({
    voiceMode: 'realtime',
    realtimeCredId: dsCred.credential.id,
    realtimeModel: 'qwen3.8-omni-flash-realtime',
    realtimeVoice: 'Tina',
  })
  const omniPlan = resolveVoiceStreamPlan(vault)
  assert.equal(omniPlan.supported, true)
  assert.equal(omniPlan.mode, 'realtime')
  assert.equal(omniPlan.adapter, 'qwen_omni_realtime')
  assert.equal(omniPlan.model, 'qwen3.8-omni-flash-realtime')
  assert.equal(resolveClientStreamCapability(vault.toPublicState()).mode, 'realtime')

  // 6. Route A: 1-Key All-in-One OpenAI Realtime
  const oaiCred = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-oai-123',
    defaultModel: 'gpt-4o-mini',
  })
  await vault.updatePrefs({
    voiceMode: 'realtime',
    realtimeCredId: oaiCred.credential.id,
    realtimeModel: 'gpt-realtime-mini',
    realtimeVoice: 'shimmer',
  })
  const oaiPlan = resolveVoiceStreamPlan(vault)
  assert.equal(oaiPlan.supported, true)
  assert.equal(oaiPlan.mode, 'realtime')
  assert.equal(oaiPlan.adapter, 'openai_realtime')
  assert.equal(oaiPlan.model, 'gpt-realtime-mini')
})

test('End-to-end /api/voice/stream enforces auth and streams Route B (Volc SAUC -> voice-harness -> TTS)', async () => {
  // Mock upstream Volcengine SAUC server
  let upstreamFrames = 0
  const mockSauc = await startMockWsServer(ws => {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return
      upstreamFrames += 1
      if (upstreamFrames === 2) {
        // First audio frame -> partial subtitle
        ws.sendBinary(buildMockVolcSaucServerResponse({
          result: { utterances: [{ text: '帮我新建', definite: false, start_time: 0, end_time: 400 }] },
        }, { flags: 0x01, sequence: 1 }))
        // Then finalized utterance -> triggers voice-harness draft flow!
        ws.sendBinary(buildMockVolcSaucServerResponse({
          result: { utterances: [{ text: '帮我新建个任务', definite: true, start_time: 0, end_time: 900 }] },
        }, { flags: 0x01, sequence: 2 }))
      }
    })
  })

  const hub = new HubCore({ stateFile: '' })
  await hub.init()
  hub.handleHeartbeat({
    hostId: 'mac-air',
    hostName: 'MacBook Air',
    platform: 'darwin',
    arch: 'arm64',
    bridgeState: {
      workspaces: ['/Users/cc/deepseekharness-remote'],
      tasks: [],
      approvals: [],
    },
  })

  const fakeMp3 = Buffer.from('ID3-mock-mp3-audio').toString('base64')
  const { server, voiceVault } = createHubServer({
    hub,
    token: 'secret-hub-tok-123456',
    requireToken: true,
    voiceFetch: async url => {
      if (String(url).includes('text-to-speech') || String(url).includes('audio/speech')) {
        return new Response(Buffer.from(fakeMp3, 'base64'), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
    voiceConnectWs: (_url, opts) => connectWebSocket(`${mockSauc.wsUrl}/sauc`, opts),
  })
  await voiceVault.init()
  const asrCred = await voiceVault.upsertCredential({
    provider: 'volcengine_asr',
    label: '豆包流式',
    apiKey: 'volc-key',
    resourceId: 'volc.seedasr.sauc.duration',
  })
  const ttsCred = await voiceVault.upsertCredential({
    provider: 'openai_compat',
    label: 'Mock TTS',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-tts',
  })
  await voiceVault.upsertProfile({
    name: '豆包流式 + TTS',
    stt: { provider: 'volcengine_asr', credId: asrCred.credential.id, model: 'volc.seedasr.sauc.duration' },
    brain: { provider: 'native' },
    tts: { provider: 'openai_compat', credId: ttsCred.credential.id, model: 'gpt-4o-mini-tts', voice: 'alloy' },
    activate: true,
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    // 1. Unauthorized WebSocket upgrade MUST be rejected with 401
    await assert.rejects(
      connectWebSocket(`ws://127.0.0.1:${port}/api/voice/stream?token=wrong`),
      /HTTP 401/,
    )

    // 2. Authorized WebSocket upgrade succeeds and completes full Route B roundtrip!
    const client = await connectWebSocket(`ws://127.0.0.1:${port}/api/voice/stream?token=secret-hub-tok-123456`)
    const received = []
    client.on('message', (data, isBinary) => {
      if (!isBinary) {
        try { received.push(JSON.parse(data)) } catch { }
      }
    })

    const readyP = waitForJsonMessage(client, m => m.type === 'ready')
    client.sendJson({ type: 'start', voiceSessionId: 'vs_route_b', activeHostId: 'mac-air' })
    const ready = await readyP
    assert.equal(ready.mode, 'pipeline')
    assert.equal(ready.adapter, 'volcengine_sauc')

    const audioDoneP = waitForJsonMessage(client, m => m.type === 'audio_done')
    client.sendBinary(Buffer.alloc(3200, 7)) // 100ms PCM16
    await audioDoneP

    assert.ok(received.some(m => m.type === 'transcript_partial' && m.text.includes('新建')))
    assert.ok(received.some(m => m.type === 'transcript_final' && m.text === '帮我新建个任务'))
    const turnMsg = received.find(m => m.type === 'turn_result')
    assert.ok(turnMsg, 'expected turn_result event')
    assert.ok(turnMsg.turn.draftCard, 'expected multi-turn new-task draftCard from voice-harness.js!')
    const audioMsg = received.find(m => m.type === 'audio_chunk')
    assert.ok(audioMsg && audioMsg.audioBase64 === fakeMp3)

    // Verify client barge_in bumps epoch and emits clear_output
    const clearP = waitForJsonMessage(client, m => m.type === 'clear_output' && m.reason === 'client_barge_in')
    client.sendJson({ type: 'barge_in' })
    const clearEv = await clearP
    assert.ok(clearEv.epoch > ready.epoch)

    client.close(1000, 'done')
  } finally {
    await closeHttpServer(server)
    await mockSauc.close()
  }
})

test('End-to-end /api/voice/stream Route A (Qwen Omni S2S) bridges tools into voice-harness + streams 24k PCM + instant barge-in', async () => {
  const upstreamLog = []
  const mockOmni = await startMockWsServer(ws => {
    ws.sendJson({ type: 'session.created' })
    ws.on('message', data => {
      const ev = JSON.parse(String(data))
      upstreamLog.push(ev)
      if (ev.type === 'session.update') {
        ws.sendJson({ type: 'session.created' })
      } else if (ev.type === 'input_audio_buffer.append' && upstreamLog.filter(e => e.type === 'input_audio_buffer.append').length === 1) {
        // Simulate Omni calling execute_pocketagents_command tool!
        ws.sendJson({ type: 'response.created', response: { id: 'resp_1' } })
        ws.sendJson({
          type: 'response.function_call_arguments.done',
          call_id: 'call_speed_1',
          name: 'execute_pocketagents_command',
          arguments: JSON.stringify({ spokenCommand: '调到 1.5 倍速' }),
        })
      } else if (ev.type === 'conversation.item.create' && ev.item?.type === 'function_call_output') {
        // After receiving tool output, stream 24kHz PCM audio + transcript, then simulate speech_started barge-in
        ws.sendJson({ type: 'response.created', response: { id: 'resp_2' } })
        ws.sendJson({ type: 'response.audio_transcript.delta', response_id: 'resp_2', delta: '已调到 1.5 倍速。' })
        ws.sendJson({ type: 'response.audio.delta', response_id: 'resp_2', delta: Buffer.alloc(960, 3).toString('base64') })
        ws.sendJson({ type: 'input_audio_buffer.speech_started' })
        // Stale delta for cancelled resp_2 MUST be dropped by gateway!
        ws.sendJson({ type: 'response.audio.delta', response_id: 'resp_2', delta: Buffer.alloc(960, 9).toString('base64') })
        ws.sendJson({ type: 'response.done', response: { id: 'resp_2' } })
      }
    })
  })

  const hub = new HubCore({ stateFile: '' })
  await hub.init()
  const { server, voiceVault, voiceCopilot } = createHubServer({
    hub,
    token: 'secret-hub-tok-123456',
    requireToken: true,
    voiceConnectWs: (_url, opts) => connectWebSocket(`${mockOmni.wsUrl}/realtime`, opts),
  })
  await voiceVault.init()
  const dsCred = await voiceVault.upsertCredential({
    provider: 'dashscope',
    label: '阿里云百炼',
    apiKey: 'sk-dash-live',
    defaultModel: 'qwen3.8-omni-flash-realtime',
  })
  await voiceVault.updatePrefs({
    voiceMode: 'realtime',
    realtimeCredId: dsCred.credential.id,
    realtimeModel: 'qwen3.8-omni-flash-realtime',
    realtimeVoice: 'Tina',
  })

  // Also test streaming credential connectivity probe via testCredential!
  const probe = await voiceCopilot.testCredential({ credId: dsCred.credential.id })
  assert.equal(probe.ok, true)
  assert.match(probe.summary, /阿里云百炼实时连通正常/)

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const client = await connectWebSocket(`ws://127.0.0.1:${port}/api/voice/stream?token=secret-hub-tok-123456`)
    const received = []
    client.on('message', (data, isBinary) => {
      if (!isBinary) {
        try { received.push(JSON.parse(data)) } catch { }
      }
    })

    const readyP = waitForJsonMessage(client, m => m.type === 'ready')
    client.sendJson({ type: 'start', voiceSessionId: 'vs_route_a' })
    const ready = await readyP
    assert.equal(ready.mode, 'realtime')
    assert.equal(ready.adapter, 'qwen_omni_realtime')

    const clearP = waitForJsonMessage(client, m => m.type === 'clear_output' && m.reason === 'vad_speech_started')
    client.sendBinary(Buffer.alloc(3200, 5))
    await clearP

    // Verify tool executed voice-harness 0ms playback speed change & updated vault prefs!
    const turnEv = received.find(m => m.type === 'turn_result' && m.fromRealtimeTool)
    assert.ok(turnEv, 'expected turn_result pushed to UI from Realtime tool call')
    assert.equal(turnEv.turn.playbackControl.speechRate, 1.5)
    assert.equal(voiceVault.state.prefs.speechRate, 1.5)

    // Verify ONLY the first audio delta arrived (stale delta after speech_started was dropped!)
    const audioDeltas = received.filter(m => m.type === 'audio_chunk' && m.format === 'pcm16')
    assert.equal(audioDeltas.length, 1)
    assert.equal(audioDeltas[0].sampleRate, 24000)

    // Verify tool output was sent back to Omni
    const toolOut = upstreamLog.find(e => e.type === 'conversation.item.create' && e.item?.type === 'function_call_output')
    assert.ok(toolOut && toolOut.item.call_id === 'call_speed_1')

    client.close(1000, 'done')
  } finally {
    await closeHttpServer(server)
    await mockOmni.close()
  }
})

test('End-to-end /api/voice/stream Route B with Deepgram Nova-3 + Qwen ASR Realtime adapters', async () => {
  const mockDg = await startMockWsServer((ws, req) => {
    assert.match(String(req.headers.authorization || ''), /^Token dg-live-key$/)
    let gotAudio = false
    ws.on('message', (_data, isBinary) => {
      if (isBinary && !gotAudio) {
        gotAudio = true
        ws.sendJson({ type: 'SpeechStarted' })
        ws.sendJson({
          type: 'Results',
          is_final: true,
          speech_final: true,
          channel: { alternatives: [{ transcript: '调到 2 倍速' }] },
        })
      }
    })
  })

  const hub = new HubCore({ stateFile: '' })
  await hub.init()
  const { server, voiceVault, voiceCopilot } = createHubServer({
    hub,
    token: 'secret-hub-tok-123456',
    requireToken: true,
    voiceConnectWs: (_url, opts) => connectWebSocket(`${mockDg.wsUrl}/listen`, opts),
  })
  await voiceVault.init()
  const dgCred = await voiceVault.upsertCredential({
    provider: 'deepgram',
    label: 'Deepgram Nova-3',
    apiKey: 'dg-live-key',
    defaultModel: 'nova-3',
  })
  await voiceVault.upsertProfile({
    name: 'Deepgram Route B',
    stt: { provider: 'deepgram', credId: dgCred.credential.id, model: 'nova-3' },
    brain: { provider: 'native' },
    tts: { provider: 'native' },
    activate: true,
  })

  const probe = await voiceCopilot.testCredential({ credId: dgCred.credential.id })
  assert.equal(probe.ok, true)
  assert.match(probe.summary, /Deepgram 实时连通正常/)

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const client = await connectWebSocket(`ws://127.0.0.1:${port}/api/voice/stream?token=secret-hub-tok-123456`)
    const readyP = waitForJsonMessage(client, m => m.type === 'ready')
    client.sendJson({ type: 'start', voiceSessionId: 'vs_dg' })
    const ready = await readyP
    assert.equal(ready.adapter, 'deepgram')

    const turnP = waitForJsonMessage(client, m => m.type === 'turn_result')
    client.sendBinary(Buffer.alloc(3200, 2))
    const turnEv = await turnP
    assert.equal(turnEv.turn.playbackControl.speechRate, 2.0)
    client.close(1000, 'done')
  } finally {
    await closeHttpServer(server)
    await mockDg.close()
  }
})
