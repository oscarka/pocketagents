import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { GoalCopilotBridge, isLoopbackPluginUrl, sanitizePluginPanel } from '../../hub/goal-copilot-bridge.js'
import { VoiceVault } from '../../hub/voice-vault.js'

test('Generic External Reply-Slot Plugin Bridge', async t => {
  const workDir = mkdtempSync(join(tmpdir(), 'pa-plugin-slot-test-'))
  t.after(() => {
    try { rmSync(workDir, { recursive: true, force: true }) } catch { }
  })

  await t.test('stays completely inert when disabled, blocks cloud-metadata SSRF, and masks authToken', async () => {
    let fetchCalls = 0
    const bridge = new GoalCopilotBridge({
      hub: { hosts: new Map() },
      configFile: join(workDir, 'plugin.json'),
      fetchImpl: async () => {
        fetchCalls += 1
        throw new Error('must not be called when disabled or SSRF blocked')
      },
    })

    assert.equal(isLoopbackPluginUrl('http://127.0.0.1:8789'), true)
    assert.equal(isLoopbackPluginUrl('http://localhost:8789'), true)
    assert.equal(isLoopbackPluginUrl('https://plugin.example.com'), false)

    // Inert when disabled
    assert.equal(bridge.getConfig().enabled, false)
    assert.deepEqual(bridge.getCachedPanel({ hostId: 'h1', agentId: 's1' }), { ok: true, enabled: false, panel: null })
    await bridge.handleTaskCompleted({ hostId: 'h1', task: { id: 's1' } })
    assert.equal(fetchCalls, 0)

    // Blocks SSRF cloud metadata URLs on both updateConfig and checkHealth
    const badMeta = bridge.updateConfig({ enabled: true, pluginUrl: 'http://169.254.169.254/latest' })
    assert.equal(badMeta.ok, false)
    const badHealth = await bridge.checkHealth('http://169.254.169.254')
    assert.equal(badHealth.connected, false)
    assert.match(badHealth.error, /SSRF/)
    assert.equal(fetchCalls, 0)

    // Saves authToken masked and keeps brainTarget='none' by default
    const saved = bridge.updateConfig({
      enabled: true,
      pluginUrl: 'http://127.0.0.1:8789',
      authToken: 'secret-plugin-bearer-9999',
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.config.hasAuthToken, true)
    assert.equal(saved.config.brainTarget, 'none')
    assert.doesNotMatch(saved.config.authTokenPreview, /secret-plugin-bearer-9999/)
  })

  await t.test('keeps model routing independent from Walk Mode and forwards key ONLY to loopback when explicitly selected', async () => {
    const vault = new VoiceVault()
    await vault.init()
    const walkBrain = await vault.upsertCredential({
      provider: 'openai_compat',
      label: 'Walk Brain',
      baseUrl: 'https://walk.example/v1',
      apiKey: 'sk-walk-only',
      defaultModel: 'walk-model',
    })
    const pluginBrain = await vault.upsertCredential({
      provider: 'openai_compat',
      label: 'Plugin Brain',
      baseUrl: 'https://plugin-llm.example/v1',
      apiKey: 'sk-plugin-explicit',
      defaultModel: 'plugin-model',
    })
    await vault.upsertProfile({
      name: 'Walk Profile',
      activate: true,
      brain: { provider: 'openai_compat', credId: walkBrain.credential.id, model: 'walk-model' },
    })

    const receivedBodies = []
    const receivedAuth = []
    const mockFetch = async (url, init) => {
      receivedAuth.push(init?.headers?.Authorization || '')
      if (url.endsWith('/api/panel/stream')) {
        receivedBodies.push(JSON.parse(init.body))
        return { ok: false, status: 404, headers: new Headers(), text: async () => '' }
      }
      if (url.endsWith('/api/panel')) {
        receivedBodies.push(JSON.parse(init.body))
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            ok: true,
            panel: {
              title: '🎯 外部复核',
              badge: '有建议',
              tone: 'info',
              body: '建议补一个单测',
              options: [
                { id: 'o1', label: '填入建议', kind: 'fill', style: 'primary', text: '请补充边界单测' },
              ],
            },
          }),
        }
      }
      throw new Error(`unexpected url ${url}`)
    }

    const hub = {
      hosts: new Map([
        ['mac1', {
          hostName: 'Mac1',
          bridgeState: {
            tasks: [{ id: 't1', title: 'Fix API', lastOutput: 'Done.', transcript: [{ role: 'assistant', text: 'Done.' }] }],
            approvals: [],
          },
        }],
      ]),
    }

    const bridge = new GoalCopilotBridge({
      hub,
      voiceVault: vault,
      configFile: join(workDir, 'plugin2.json'),
      fetchImpl: mockFetch,
    })

    // Case 1: brainTarget === 'none' -> NEVER leaks Walk Mode's brain key even on loopback!
    bridge.updateConfig({
      enabled: true,
      pluginUrl: 'http://127.0.0.1:8789',
      authToken: 'tok-abc',
      brainTarget: 'none',
    })
    const res1 = await bridge.streamPanel({ hostId: 'mac1', agentId: 't1' })
    assert.equal(res1.status, 200)
    assert.equal(res1.json.panel.options[0].kind, 'fill')
    assert.equal(res1.json.panel.options[0].text, '请补充边界单测')
    assert.equal(receivedBodies[0].llmConfig, undefined)
    assert.equal(receivedAuth[0], 'Bearer tok-abc')

    // Case 2: Explicit brainTarget on loopback -> forwards ONLY pluginBrain, NOT walkBrain!
    receivedBodies.length = 0
    bridge.updateConfig({ brainTarget: `cred:${pluginBrain.credential.id}` })
    await bridge.streamPanel({ hostId: 'mac1', agentId: 't1' })
    assert.equal(receivedBodies[0].llmConfig?.apiKey, 'sk-plugin-explicit')
    assert.equal(receivedBodies[0].llmConfig?.model, 'plugin-model')

    // Case 3: Remote HTTPS URL -> NEVER forwards API key even when brainTarget is set!
    receivedBodies.length = 0
    bridge.updateConfig({ pluginUrl: 'https://plugin.example.com' })
    await bridge.streamPanel({ hostId: 'mac1', agentId: 't1' })
    assert.equal(receivedBodies[0].llmConfig, undefined)
  })

  await t.test('supports SSE streaming, /api/action callbacks, and background task_completed cache + push notify', async () => {
    const pushed = []
    const hub = {
      hosts: new Map([
        ['mac1', {
          hostName: 'Mac1',
          bridgeState: {
            tasks: [{ id: 't2', title: 'Refactor', lastOutput: 'Refactored.', transcript: [] }],
            approvals: [],
          },
        }],
      ]),
      broadcastWebPush: async payload => { pushed.push(payload) },
    }

    const mockFetch = async (url, init) => {
      if (url.endsWith('/api/panel/stream')) {
        const sse = [
          'event: status\ndata: {"text":"分析中..."}\n\n',
          'event: thinking\ndata: {"delta":"步骤1 "}\n\n',
          'event: result\ndata: {"panel":{"title":"🎯 插件流式","badge":"完成","tone":"success","body":"可以合并","options":[{"label":"合并","kind":"fill","text":"直接合并吧"}]}}\n\n',
        ].join('')
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse))
            controller.close()
          },
        })
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: stream,
        }
      }
      if (url.endsWith('/api/panel')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            ok: true,
            panel: { title: '🎯 后台复核', body: '发现 1 个建议', options: [{ label: '填入', kind: 'fill', text: '优化一下' }] },
            notify: { title: '🎯 副驾有新建议', body: '发现 1 个建议' },
          }),
        }
      }
      if (url.endsWith('/api/action')) {
        const b = JSON.parse(init.body)
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({
            ok: true,
            toast: `收到 ${b.actionId}`,
            fillText: `按偏好处理：${b.inputText}`,
            panel: null,
          }),
        }
      }
      throw new Error(`unexpected url ${url}`)
    }

    const bridge = new GoalCopilotBridge({
      hub,
      configFile: join(workDir, 'plugin3.json'),
      fetchImpl: mockFetch,
    })
    bridge.updateConfig({ enabled: true, pluginUrl: 'http://127.0.0.1:8789' })

    // 1. SSE stream passthrough + cache capture
    const sRes = await bridge.streamPanel({ hostId: 'mac1', agentId: 't2' })
    assert.equal(sRes.status, 200)
    let rawSse = ''
    for await (const chunk of sRes.stream) rawSse += chunk.toString('utf8')
    assert.match(rawSse, /event: thinking/)
    assert.equal(bridge.getCachedPanel({ hostId: 'mac1', agentId: 't2' }).panel?.title, '🎯 插件流式')

    // 2. Callback action returns fillText, toast, and clears cached panel when panel: null
    const actRes = await bridge.runAction({ hostId: 'mac1', agentId: 't2', actionId: 'feedback', inputText: '少写废话' })
    assert.equal(actRes.ok, true)
    assert.equal(actRes.toast, '收到 feedback')
    assert.equal(actRes.fillText, '按偏好处理：少写废话')
    assert.equal(bridge.getCachedPanel({ hostId: 'mac1', agentId: 't2' }).panel, null)

    // 3. Background task_completed caches panel AND fans out notify via broadcastWebPush (Web Push + APNs)
    await bridge.handleTaskCompleted({ hostId: 'mac1', hostName: 'Mac1', task: { id: 't2', title: 'Refactor' } })
    assert.equal(bridge.getCachedPanel({ hostId: 'mac1', agentId: 't2' }).panel?.title, '🎯 后台复核')
    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].title, '🎯 副驾有新建议')

    // 4. sanitizePluginPanel ignores empty objects cleanly
    assert.equal(sanitizePluginPanel({}), null)
  })

  await t.test('keeps open-source hub, frontend, and protocol doc completely free of private personal terminology', () => {
    const files = [
      resolve(process.cwd(), 'hub/goal-copilot-bridge.js'),
      resolve(process.cwd(), 'hub/web/src/copilot/goal-copilot-ui.js'),
      resolve(process.cwd(), 'hub/server.js'),
      resolve(process.cwd(), 'docs/EXTERNAL_PLUGIN_PROTOCOL.md'),
    ]
    for (const f of files) {
      const content = readFileSync(f, 'utf8')
      assert.doesNotMatch(content, /master-reflection/i, `${f} must not reference private repo`)
      assert.doesNotMatch(content, /个人尺子/, `${f} must not contain private terminology`)
      assert.doesNotMatch(content, /playbooksCount|dshReadonlyAvailable/, `${f} must not couple private schema`)
    }
  })
})
