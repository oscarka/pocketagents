#!/usr/bin/env node
// scripts/passport-sim-hub.mjs
// Launches a live seeded PocketAgents Hub tailored for testing the FoloToy AI Passport
// firmware inside VOID001/FoloToy-Passport-Simulator (or on real hardware over LAN Wi-Fi).
import { networkInterfaces } from 'node:os'
import { HubCore } from '../hub/hub-core.js'
import { createHubServer } from '../hub/server.js'

const PORT = Number(process.env.PA_SIM_PORT || 8787)
const HOST = process.env.PA_SIM_HOST || '0.0.0.0'
const TOKEN = process.env.PA_SIM_TOKEN || 'passport-sim-demo'

function detectLanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return '127.0.0.1'
}

const nowMs = Date.now()
const hub = new HubCore({ stateFile: '' })

// Seed realistic multi-harness tasks + L1 command approval, L0 multi-choice question, and L2 high-risk command
const initialBridgeState = {
  tasks: [
    {
      id: 'claude:unit-tests',
      harness: 'claude',
      title: 'Fix payment tests',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 1000,
      lastOutput: 'Ready to run unit tests after patching retry backoff.',
      pendingApproval: true,
    },
    {
      id: 'agy:rollout-plan',
      harness: 'antigravity',
      title: 'Release Strategy',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 2000,
      lastOutput: 'Choose rollout target before publishing.',
      pendingApproval: true,
    },
    {
      id: 'codex:cleanup',
      harness: 'codex',
      title: 'Clean Old Cache',
      cwd: '/Users/dev/pocketagents',
      status: 'approval',
      updatedAt: nowMs - 3000,
      lastOutput: 'Requested destructive cleanup command.',
      pendingApproval: true,
    },
    {
      id: 'dsh:web-build',
      harness: 'dsh',
      title: 'Build Web Bundle',
      cwd: '/Users/dev/pocketagents',
      status: 'running',
      updatedAt: nowMs - 500,
      lastOutput: 'Bundling Vite assets...',
    },
  ],
  approvals: [
    {
      code: 'CLD-101',
      agentId: 'claude:unit-tests',
      kind: 'approval',
      toolName: 'Bash',
      promptTitle: 'Run PocketAgents unit test suite?',
      commandLine: 'npm test -- device-lite-api.test.js',
      createdAt: nowMs - 30_000,
      options: [
        { index: 1, label: 'Allow once' },
        { index: 2, label: 'Always allow' },
        { index: 3, label: 'Deny' },
      ],
    },
    {
      code: 'AGY-202',
      agentId: 'agy:rollout-plan',
      kind: 'question',
      toolName: 'ask_question',
      promptTitle: 'Select release rollout strategy',
      createdAt: nowMs - 20_000,
      questions: [
        {
          id: 'q_rollout',
          question: 'Which deployment target?',
          options: [
            { label: 'Canary staging' },
            { label: 'Full production' },
            { label: 'Hold release' },
          ],
        },
      ],
    },
    {
      code: 'CDX-303',
      agentId: 'codex:cleanup',
      kind: 'approval',
      toolName: 'Bash',
      promptTitle: 'Force push & wipe old build?',
      commandLine: 'rm -rf /tmp/old-build && git push --force origin main',
      createdAt: nowMs - 10_000,
      options: [
        { index: 1, label: 'Allow' },
        { index: 2, label: 'Deny' },
      ],
    },
  ],
}

hub.handleHeartbeat({
  hostId: 'macbook-pro',
  hostName: 'MacBook Pro',
  bridgeState: structuredClone(initialBridgeState),
})

// Simulate a live host daemon consuming queued commands every 250ms and settling approvals
const executedLog = []
setInterval(() => {
  const hb = hub.handleHeartbeat({
    hostId: 'macbook-pro',
    hostName: 'MacBook Pro',
  })
  const cmds = hb.commands || []
  if (cmds.length === 0) return

  const host = hub.hosts.get('macbook-pro')
  const curState = structuredClone(host?.bridgeState || { tasks: [], approvals: [] })
  for (const cmd of cmds) {
    executedLog.push({ at: Date.now(), ...cmd })
    console.log(`[SIM-HUB] Executed on host: ${JSON.stringify(cmd)}`)
    if (cmd.type === 'approve' || cmd.type === 'deny') {
      const code = String(cmd.code || '').toUpperCase()
      curState.approvals = (curState.approvals || []).filter(
        a => String(a?.code || '').toUpperCase() !== code,
      )
      for (const t of curState.tasks || []) {
        if (t.id === cmd.agentId) {
          t.pendingApproval = false
          t.status = cmd.type === 'approve' ? 'running' : 'idle'
          t.updatedAt = Date.now()
        }
      }
      hub.handleHeartbeat({
        hostId: 'macbook-pro',
        hostName: 'MacBook Pro',
        bridgeState: curState,
        commandResults: [{ id: cmd.id, ok: true, code, decision: cmd.type }],
      })
    }
  }
}, 250)

const { server } = createHubServer({
  hub,
  token: TOKEN,
  requireToken: true,
  voiceVaultFile: '',
})

// Expose a tiny read-only test inspection hook for automated E2E verification
const origEmit = server.listeners('request')[0]
server.removeAllListeners('request')
server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/__sim_log') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, executed: executedLog }))
    return
  }
  return origEmit(req, res)
})

server.listen(PORT, HOST, () => {
  const lanIp = detectLanIp()
  console.log(`[SIM-HUB] PocketAgents Sim Hub listening on http://${lanIp}:${PORT}`)
  console.log(`[SIM-HUB] Token: ${TOKEN}`)
  console.log(`[SIM-HUB] Digest URL: http://${lanIp}:${PORT}/api/device/digest`)
})
