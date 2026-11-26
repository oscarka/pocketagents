import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  AGY_INSTALL_URL_UNIX,
  AGY_INSTALL_URL_WIN,
  AntigravityAcpClient,
  detectAntigravityHostStatus,
  installAntigravityCli,
} from '../lib/antigravity-acp.js'
import {
  executeAntigravityIdeAction,
  resolveAntigravityModelSlug,
} from '../lib/antigravity-ide.js'
import { translateZhStringToEn } from '../../hub/web/src/utils/i18n.js'

function createFakeAcpProcess(onRequest) {
  const proc = new EventEmitter()
  proc.killed = false
  proc.exitCode = null
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  const received = []
  let buf = ''
  proc.stdin.setEncoding('utf8')
  proc.stdin.on('data', chunk => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      received.push(msg)
      onRequest?.(msg, proc)
    }
  })
  proc.kill = () => {
    proc.killed = true
    proc.exitCode = 0
    proc.emit('exit', 0)
  }
  proc.pushStdout = obj => {
    proc.stdout.write(`${JSON.stringify(obj)}\n`)
  }
  return { proc, received }
}

test('v0.9.34 AntigravityAcpClient handles initialize, resume, model switch, prompt, permission approval, and cancel', async () => {
  const { proc, received } = createFakeAcpProcess((msg, child) => {
    if (msg.method === 'initialize') {
      child.pushStdout({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
      })
      return
    }
    if (msg.method === 'session/resume') {
      child.pushStdout({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId,
          models: {
            currentModelId: 'gemini-4-neon-high',
            availableModels: [
              { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
              { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
            ],
          },
        },
      })
      return
    }
    if (msg.method === 'session/set_model') {
      child.pushStdout({ jsonrpc: '2.0', id: msg.id, result: {} })
      return
    }
    if (msg.method === 'session/prompt') {
      // Stream a thought/message chunk and then request permission from the client
      child.pushStdout({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: msg.params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '正在检查项目配置...' },
          },
        },
      })
      child.pushStdout({
        jsonrpc: '2.0',
        id: 777,
        method: 'session/request_permission',
        params: {
          sessionId: msg.params.sessionId,
          toolCall: {
            kind: 'run_command',
            title: 'Run npm test',
            rawInput: { CommandLine: 'npm test' },
          },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
          ],
        },
      })
      return
    }
    if (msg.method === 'session/new') {
      child.pushStdout({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'new-acp-conv-9999',
          models: {
            currentModelId: 'gemini-4-neon-high',
            availableModels: [{ modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }],
          },
        },
      })
    }
  })

  const client = new AntigravityAcpClient({
    cliPath: '/mock/agy',
    spawnImpl: () => proc,
    modelSlugResolver: resolveAntigravityModelSlug,
  })
  // Stub resolveCliPath to avoid real fs.access check
  client.resolveCliPath = async () => '/mock/agy'

  const sendRes = await client.sendPrompt({
    sessionId: 'agy-ide:conv-abc-1234',
    text: '帮我跑一下测试',
    cwd: '/Users/cc/demo',
    model: 'MODEL_PLACEHOLDER_M535',
  })
  assert.equal(sendRes.ok, true)
  assert.equal(sendRes.method, 'agy-acp')

  // Verify model placeholder was translated to official slug before calling session/set_model
  const setModelMsg = received.find(m => m.method === 'session/set_model')
  assert.ok(setModelMsg)
  assert.equal(setModelMsg.params.modelId, 'gemini-4-neon-xhigh')

  // Verify live model catalog was captured from session/resume
  assert.equal(client.liveModelCatalog.models.length, 2)

  // Allow microtasks/streams to flush permission request
  await new Promise(r => setTimeout(r, 30))
  const overlays = client.getActiveOverlays()
  assert.equal(overlays.approvals.length, 1)
  const perm = overlays.approvals[0]
  assert.match(perm.code, /^AGY-ACP-CONV-A-777$/)
  assert.equal(perm.commandLine, 'npm test')
  assert.equal(overlays.runningByRawId.get('conv-abc-1234')?.status, 'approval')

  // Resolve permission via executeAntigravityIdeAction (verifies priority routing to ACP!)
  const approveRes = await executeAntigravityIdeAction(
    { type: 'approve', code: perm.code, agentId: 'agy-ide:conv-abc-1234', optionIndex: 2 },
    {
      acpClient: client,
      execImpl: async () => {
        throw new Error('should not fall back to applescript')
      },
      fetchImpl: async () => {
        throw new Error('no rpc')
      },
    },
  )
  assert.equal(approveRes.ok, true)
  assert.equal(approveRes.engine, 'agy-acp')
  const permReply = received.find(m => m.id === 777)
  assert.deepEqual(permReply?.result, {
    outcome: { outcome: 'selected', optionId: 'allow_always' },
  })

  // Cancel active session cleanly
  const stopRes = await executeAntigravityIdeAction(
    { type: 'stop', agentId: 'agy-ide:conv-abc-1234' },
    {
      acpClient: client,
      execImpl: async () => {
        throw new Error('should not use applescript')
      },
      fetchImpl: async () => {
        throw new Error('no rpc')
      },
    },
  )
  assert.equal(stopRes.ok, true)
  assert.equal(stopRes.method, 'agy-acp')
  assert.ok(received.some(m => m.method === 'session/cancel' && m.params.sessionId === 'conv-abc-1234'))

  // New session via ACP
  const newRes = await executeAntigravityIdeAction(
    { type: 'new_session', title: '新任务', prompt: '你好', cwd: '/Users/cc/demo', model: 'MODEL_PLACEHOLDER_M532' },
    {
      acpClient: client,
      execImpl: async bin => (bin === 'ps' ? { stdout: '' } : { stdout: '' }),
      fetchImpl: async () => {
        throw new Error('no rpc')
      },
    },
  )
  assert.equal(newRes.ok, true)
  assert.equal(newRes.method, 'agy-acp')
  assert.equal(newRes.agentId, 'agy-ide:new-acp-conv-9999')

  client.shutdown()
})

test('v0.9.34 detectAntigravityHostStatus distinguishes connect-rpc, acp, acp-needs-login, and desktop-only', async () => {
  const desktopOnly = await detectAntigravityHostStatus({
    hasLiveRpc: false,
    hasAntigravitySessions: true,
    platform: 'darwin',
    accessImpl: async p => {
      if (p === '/Applications/Antigravity.app') return
      throw new Error('ENOENT')
    },
    execImpl: async () => {
      throw new Error('not found')
    },
  })
  assert.equal(desktopOnly.mode, 'desktop-only')
  assert.equal(desktopOnly.needsCliInstall, true)
  assert.equal(desktopOnly.needsCliLogin, false)

  const rpcReady = await detectAntigravityHostStatus({
    hasLiveRpc: true,
    hasAntigravitySessions: true,
    platform: 'darwin',
    accessImpl: async p => {
      if (p === '/Applications/Antigravity.app' || p.endsWith('/.gemini/bin/agy')) return
      throw new Error('ENOENT')
    },
    execImpl: async () => ({ stdout: 'agy 1.5.17\n' }),
  })
  assert.equal(rpcReady.mode, 'connect-rpc')
  assert.equal(rpcReady.needsCliInstall, false)
  assert.equal(rpcReady.cliVersion, 'agy 1.5.17')

  const acpNeedsLogin = await detectAntigravityHostStatus({
    hasLiveRpc: false,
    hasAntigravitySessions: true,
    acpClient: { authenticated: false },
    platform: 'darwin',
    accessImpl: async p => {
      if (p.endsWith('/.local/bin/agy')) return
      throw new Error('ENOENT')
    },
    execImpl: async () => ({ stdout: 'agy 1.5.17\n' }),
  })
  assert.equal(acpNeedsLogin.mode, 'acp-needs-login')
  assert.equal(acpNeedsLogin.needsCliLogin, true)
  assert.equal(acpNeedsLogin.needsCliInstall, false)
})

test('v0.9.34 installAntigravityCli runs official installer and activates ACP when auth is shared', async () => {
  const calls = []
  let installed = false
  const fakeAcp = {
    cliPath: '',
    authenticated: null,
    lastAuthCheckAt: 0,
    checkAuthAndSessions: async () => ({ ok: true, authenticated: true }),
  }

  const res = await installAntigravityCli({
    acpClient: fakeAcp,
    platform: 'darwin',
    home: '/Users/test',
    execImpl: async (bin, args) => {
      calls.push([bin, args])
      if (bin === '/bin/bash' && String(args[1] || '').includes(AGY_INSTALL_URL_UNIX)) {
        installed = true
        return { stdout: 'Installed agy' }
      }
      if (bin === '/Users/test/.local/bin/agy' && args[0] === '--version') {
        return { stdout: 'agy 1.5.17\n' }
      }
      return { stdout: '' }
    },
    accessImpl: async p => {
      if (installed && p === '/Users/test/.local/bin/agy') return
      throw new Error('ENOENT')
    },
  })

  assert.equal(res.ok, true)
  assert.equal(res.mode, 'acp')
  assert.equal(res.authenticated, true)
  assert.equal(res.cliPath, '/Users/test/.local/bin/agy')
  assert.ok(calls.some(([bin, args]) => bin === '/bin/bash' && String(args[1]).includes(AGY_INSTALL_URL_UNIX)))
  assert.match(AGY_INSTALL_URL_WIN, /^https:\/\/antigravity\.google\/cli\/install\.ps1$/)
})

test('v0.9.34 mobile UI wiring and English i18n cover degraded-mode banners and 1-tap CLI install', async () => {
  const [settingsSrc, controllerSrc, chatStageSrc] = await Promise.all([
    readFile(resolve(process.cwd(), 'hub/web/src/settings/settings-panel.js'), 'utf8'),
    readFile(resolve(process.cwd(), 'hub/web/src/controller.js'), 'utf8'),
    readFile(resolve(process.cwd(), 'hub/web/src/components/ChatStage.tsx'), 'utf8'),
  ])

  assert.match(chatStageSrc, /id="chatAgyCliBanner"/)
  assert.match(settingsSrc, /installHostAgyCli\(/)
  assert.match(settingsSrc, /loginHostAgyCli\(/)
  assert.match(controllerSrc, /async function installHostAgyCli\(/)
  assert.match(controllerSrc, /type: 'install_agy_cli'/)

  const zhSamples = [
    '缺 agy CLI',
    '⚠️ 建议安装官方 agy CLI 以解锁完整遥控',
    '当前仅检测到 Antigravity 桌面端，发消息只能依赖窗口模拟粘贴：锁屏或关窗口发不出、易串到当前桌面窗口、切模型不生效且无手机审批弹窗。装好官方 agy CLI 即可自动切回直连模式。',
    '⚡ 一键为此电脑安装 agy CLI',
    '✅ Antigravity 完整遥控已就绪',
    'Antigravity · 受限模式 (缺CLI)',
    'Antigravity · ACP直连',
    '⚠️ Mac mini 仅装了 Antigravity 桌面端：锁屏发不出、易串窗口且切模型不生效',
    '⚡ 一键装 CLI',
    '🚀 先升级客户端 (v0.9.34) 再一键装 CLI',
  ]
  for (const s of zhSamples) {
    const en = translateZhStringToEn(s)
    assert.equal(/[\u4e00-\u9fa5]/.test(en), false, `Leftover Chinese in EN translation for "${s}" -> "${en}"`)
  }
})
