import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubCore } from '../../hub/hub-core.js'
import { createHubServer, isBlockedHubFsPath } from '../../hub/server.js'
import {
  isSensitiveHostPath,
  listWorkspaceFiles,
  prepareWorkspaceFileStream,
  readWorkspaceFileFastMeta,
} from '../lib/workspace-ops.js'

async function readFirstSseChunk(url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { status: res.status, text }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let collected = ''
    while (collected.length < 4096) {
      const { done, value } = await reader.read()
      if (done) break
      collected += decoder.decode(value, { stream: true })
      if (collected.includes('\n\n') && collected.includes('event:')) break
    }
    controller.abort()
    return { status: res.status, text: collected }
  } catch (err) {
    if (err?.name === 'AbortError') return { status: 200, text: '' }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

test('Security Hardening: forged hst_<48hex> token cannot bypass /api/heartbeat, /api/events, or shared host endpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sec-hardening-'))
  const stateFile = join(root, 'hub-state.json')
  const adminToken = 'super-strong-admin-token-2026-xyz'
  const hub = new HubCore({ stateFile })
  await hub.init()
  const { server, fetchAdapter } = createHubServer({
    hub,
    token: adminToken,
    requireToken: true,
    logger: { info() {}, warn() {}, error() {} },
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // Seed a legitimate host first
    const enrollRes = await fetchAdapter(`${baseUrl}/api/hosts/enrollment`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}` },
      body: { forceNew: true },
    })
    const { enrollment } = await enrollRes.json()
    const joinRes = await fetchAdapter(`${baseUrl}/api/hosts/join`, {
      method: 'POST',
      remoteAddress: '10.0.0.1',
      body: { code: enrollment.code, hostId: 'real-mac', hostName: 'Real Mac', platform: 'darwin' },
    })
    assert.equal(joinRes.status, 200)
    const realJoin = await joinRes.json()
    assert.match(realJoin.hostToken, /^hst_[0-9a-f]{48}$/)

    // 1. Forged random hst_<48hex> token MUST be rejected everywhere (exact replay of 45.137.180.141 attack!)
    const forgedToken = `hst_${'54f1'.repeat(12)}`
    assert.equal(hub.verifyHostCredential('', forgedToken), false)
    assert.equal(hub.verifyHostCredential('zzz-not-host', forgedToken), false)
    assert.equal(hub.verifyHostCredential('real-mac', forgedToken), false)

    const forgedHb = await fetchAdapter(`${baseUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedToken}` },
      body: { hostId: 'zzz-not-host', hostName: 'x', bridgeState: { tasks: [] } },
    })
    assert.equal(forgedHb.status, 401)
    assert.equal(hub.hosts.has('zzz-not-host'), false)

    const forgedEmptyHostHb = await fetchAdapter(`${baseUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedToken}` },
      body: { hostId: '', hostName: 'x' },
    })
    assert.equal(forgedEmptyHostHb.status, 401)

    const forgedSse = await readFirstSseChunk(`${baseUrl}/api/events`, {
      authorization: `Bearer ${forgedToken}`,
      'user-agent': 'Mozilla/5.0',
    })
    assert.equal(forgedSse.status, 401)

    const forgedHostSse = await readFirstSseChunk(
      `${baseUrl}/api/events?mode=host&hostId=zzz-not-host&token=${forgedToken}`,
      { 'user-agent': 'node' },
    )
    assert.equal(forgedHostSse.status, 401)

    const forgedSnap = await fetchAdapter(`${baseUrl}/api/snapshots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedToken}` },
      body: { hostId: 'zzz-not-host', dataBase64: 'AAAA' },
    })
    assert.equal(forgedSnap.status, 401)

    const forgedShare = await fetchAdapter(`${baseUrl}/api/shares`, {
      method: 'POST',
      headers: { authorization: `Bearer ${forgedToken}` },
      body: { ivBase64: 'a', ciphertextBase64: 'b' },
    })
    assert.equal(forgedShare.status, 401)

    // 2. Even a LEGITIMATE enrolled Host Token MUST NEVER access admin full-state /api/events!
    const hostAdminSseAttempt = await readFirstSseChunk(`${baseUrl}/api/events`, {
      authorization: `Bearer ${realJoin.hostToken}`,
      'user-agent': 'Mozilla/5.0',
    })
    assert.equal(hostAdminSseAttempt.status, 401)
    assert.doesNotMatch(hostAdminSseAttempt.text, /mediaTicket|enrollment/)

    // A legitimate Host Token CANNOT spy on another host's mode=host SSE stream
    const hostCrossWatch = await readFirstSseChunk(
      `${baseUrl}/api/events?mode=host&hostId=other-mac`,
      { authorization: `Bearer ${realJoin.hostToken}`, 'user-agent': 'node' },
    )
    assert.equal(hostCrossWatch.status, 401)

    // A legitimate Host Token CAN subscribe to its OWN mode=host stream, and only sees mode: 'host'
    const hostOwnSse = await readFirstSseChunk(
      `${baseUrl}/api/events?mode=host&hostId=real-mac`,
      { authorization: `Bearer ${realJoin.hostToken}`, 'user-agent': 'node' },
    )
    assert.equal(hostOwnSse.status, 200)
    assert.match(hostOwnSse.text, /"mode":"host"/)
    assert.doesNotMatch(hostOwnSse.text, /mediaTicket|enrollment/)

    // Admin HUB_TOKEN CAN still subscribe to full-state /api/events
    const adminSse = await readFirstSseChunk(`${baseUrl}/api/events`, {
      authorization: `Bearer ${adminToken}`,
      'user-agent': 'Mozilla/5.0',
    })
    assert.equal(adminSse.status, 200)
    assert.match(adminSse.text, /mediaTicket/)

    // 3. Stateless Cloud Run cold-start recovery ONLY works for legitimately HMAC-signed tokens matching BOTH secret & hostId!
    const coldHub = new HubCore({ tokenSecret: adminToken })
    assert.equal(coldHub.verifyHostCredential('real-mac', realJoin.hostToken), true)
    assert.equal(coldHub.verifyHostCredential('spoofed-mac', realJoin.hostToken), false)
    assert.equal(coldHub.verifyHostCredential('real-mac', forgedToken), false)
    assert.equal(coldHub.verifyHostCredential('', realJoin.hostToken), false)

    // Rotating HUB_TOKEN on cold restart invalidates stateless recovery of tokens signed under the old secret
    const rotatedHub = new HubCore({ tokenSecret: 'brand-new-admin-token-999' })
    assert.equal(rotatedHub.verifyHostCredential('real-mac', realJoin.hostToken), false)

    // 4. mediaTicket MUST NOT authorize /fs/list or /fs/read, and sensitive paths MUST be blocked with 403
    const mt = hub.getFullState().mediaTicket
    const listWithMt = await fetchAdapter(`${baseUrl}/api/hosts/real-mac/fs/list?cwd=~&path=.dsh&mt=${encodeURIComponent(mt)}`)
    assert.equal(listWithMt.status, 401)
    const readWithMt = await fetchAdapter(`${baseUrl}/api/hosts/real-mac/fs/read?cwd=~&path=.dsh/.credentials.yaml&mt=${encodeURIComponent(mt)}`)
    assert.equal(readWithMt.status, 401)

    // Even with valid Admin HUB_TOKEN or valid mediaTicket, Hub blocks sensitive credential/session paths BEFORE tunneling!
    const sensitiveCases = [
      `/api/hosts/real-mac/fs/list?cwd=~&path=.dsh`,
      `/api/hosts/real-mac/fs/list?cwd=~&path=.dsh/sessions`,
      `/api/hosts/real-mac/fs/list?cwd=~&path=.ssh`,
      `/api/hosts/real-mac/fs/list?cwd=~&path=Library/LaunchAgents`,
      `/api/hosts/real-mac/fs/read?cwd=~&path=.dsh/.credentials.yaml`,
      `/api/hosts/real-mac/fs/read?cwd=~&path=.DSH/FEISHU.ENV`,
      `/api/hosts/real-mac/fs/read?cwd=~&path=.zshenv`,
      `/api/hosts/real-mac/fs/read?cwd=~&path=./.zshenv`,
      `/api/hosts/real-mac/fs/read?cwd=/Users/cc/proj&path=../.zshenv`,
      `/api/hosts/real-mac/fs/read?cwd=/&path=/etc/passwd`,
      `/api/hosts/real-mac/fs/read?cwd=/&path=/var/lib/dsh-hub/dsh-hub-state.json`,
      `/api/hosts/real-mac/fs/read?cwd=~&path=.zsh_history`,
      `/api/hosts/real-mac/fs/stream?cwd=~&path=.dsh/.credentials.yaml&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=~&path=.dsh/feishu.env&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=~&path=.dsh/hub-daemon.log&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=~&path=.dsh/sessions/--Users-cc--/session-1/session.v4.jsonl.zstd&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=~&path=.zshenv&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=/Users/cc/proj&path=.env&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=/Users/cc/proj&path=.deploy.env&mt=${encodeURIComponent(mt)}`,
      `/api/hosts/real-mac/fs/stream?cwd=~&path=.local/bin/env&mt=${encodeURIComponent(mt)}`,
    ]
    for (const reqPath of sensitiveCases) {
      const res = await fetchAdapter(`${baseUrl}${reqPath}`, {
        headers: reqPath.includes('mt=') ? {} : { authorization: `Bearer ${adminToken}` },
      })
      assert.equal(res.status, 403, `Expected 403 for sensitive path: ${reqPath}, got ${res.status}`)
    }

    // 5. Brute-force protection on POST /api/auth/verify throttles repeated failed attempts with 429
    for (let i = 0; i < 10; i += 1) {
      const bad = await fetchAdapter(`${baseUrl}/api/auth/verify`, {
        method: 'POST',
        remoteAddress: '45.137.180.141',
        headers: { authorization: `Bearer wrong-guess-${i}` },
      })
      assert.equal(bad.status, 401)
    }
    const throttled = await fetchAdapter(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      remoteAddress: '45.137.180.141',
      headers: { authorization: `Bearer wrong-guess-11` },
    })
    assert.equal(throttled.status, 429)
    // Different IP is unaffected
    const cleanIpOk = await fetchAdapter(`${baseUrl}/api/auth/verify`, {
      method: 'POST',
      remoteAddress: '10.0.0.99',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(cleanIpOk.status, 200)
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})

test('Security Hardening: daemon workspace-ops blocks sensitive credential files/dirs locally while allowing normal project files', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-sec-home-'))
  try {
    await mkdir(join(fakeHome, '.dsh', 'sessions', 'proj', 's1'), { recursive: true })
    await mkdir(join(fakeHome, '.ssh'), { recursive: true })
    await mkdir(join(fakeHome, 'my-app'), { recursive: true })

    await writeFile(join(fakeHome, '.dsh', '.credentials.yaml'), 'token: secret_ds\n')
    await writeFile(join(fakeHome, '.dsh', 'feishu.env'), 'FEISHU_HUB_TOKEN=master_secret\n')
    await writeFile(join(fakeHome, '.dsh', 'feishu-host.json'), '{"privateKey":"secret"}\n')
    await writeFile(join(fakeHome, '.dsh', 'sessions', 'proj', 's1', 'session.v4.jsonl.zstd'), 'zstd-data')
    await writeFile(join(fakeHome, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    await writeFile(join(fakeHome, 'my-app', '.env'), 'API_KEY=sk-secret\n')
    await writeFile(join(fakeHome, 'my-app', '.env.example'), 'API_KEY=your-key\n')
    await writeFile(join(fakeHome, 'my-app', 'README.md'), '# Safe Project File\n')

    // Sensitive path classifier checks
    assert.equal(isSensitiveHostPath(join(fakeHome, '.zshenv'), { homeRoot: fakeHome }), true)
    assert.equal(isSensitiveHostPath(join(fakeHome, '.zsh_history'), { homeRoot: fakeHome }), true)
    assert.equal(isSensitiveHostPath(join(fakeHome, '.dsh', 'feishu.env'), { homeRoot: fakeHome }), true)
    assert.equal(isSensitiveHostPath(join(fakeHome, '.ssh', 'id_ed25519'), { homeRoot: fakeHome }), true)
    assert.equal(isSensitiveHostPath(join(fakeHome, 'my-app', '.env'), { isStream: true, homeRoot: fakeHome }), true)
    assert.equal(isSensitiveHostPath(join(fakeHome, 'my-app', '.env.example'), { isStream: true, homeRoot: fakeHome }), false)
    assert.equal(isSensitiveHostPath(join(fakeHome, 'my-app', 'README.md'), { isStream: true, homeRoot: fakeHome }), false)

    // Hub path guard allows safe project files and Antigravity brain media
    assert.equal(isBlockedHubFsPath({ cwd: '/Users/cc/my-app', path: 'README.md', op: 'read', isAdmin: true }), false)
    assert.equal(isBlockedHubFsPath({ cwd: '/Users/cc/my-app', path: 'shots/demo.png', op: 'stream', isAdmin: false }), false)
    assert.equal(isBlockedHubFsPath({ cwd: '/Users/cc/my-app', path: '/Users/cc/.gemini/antigravity/brain/conv-1/shot.png', op: 'stream', isAdmin: false }), false)
    assert.equal(isBlockedHubFsPath({ cwd: '~', path: '', op: 'list', isAdmin: true }), false)

    // listWorkspaceFiles hides .dsh and .ssh when listing parent dir and blocks listing into them directly
    const homeList = await listWorkspaceFiles(fakeHome, '')
    assert.equal(homeList.ok, true)
    assert.equal(homeList.entries.some(e => e.name === 'my-app'), true)
    assert.equal(homeList.entries.some(e => e.name === '.dsh'), false)
    assert.equal(homeList.entries.some(e => e.name === '.ssh'), false)

    const dshList = await listWorkspaceFiles(fakeHome, '.dsh')
    assert.equal(dshList.ok, false)
    assert.equal(dshList.status, 403)

    // readWorkspaceFileFastMeta & prepareWorkspaceFileStream block credential files & raw session archives
    const credRead = await readWorkspaceFileFastMeta(fakeHome, '.dsh/.credentials.yaml')
    assert.equal(credRead.ok, false)
    assert.equal(credRead.status, 403)

    const envStream = await prepareWorkspaceFileStream(join(fakeHome, 'my-app'), '.env')
    assert.equal(envStream.ok, false)
    assert.equal(envStream.status, 403)

    const sessStream = await prepareWorkspaceFileStream(fakeHome, '.dsh/sessions/proj/s1/session.v4.jsonl.zstd')
    assert.equal(sessStream.ok, false)
    assert.equal(sessStream.status, 403)

    // Safe project files & .env.example remain readable and streamable
    const readmeRead = await readWorkspaceFileFastMeta(join(fakeHome, 'my-app'), 'README.md')
    assert.equal(readmeRead.ok, true)
    assert.match(readmeRead.content, /Safe Project File/)

    const exampleStream = await prepareWorkspaceFileStream(join(fakeHome, 'my-app'), '.env.example')
    assert.equal(exampleStream.ok, true)
  } finally {
    await rm(fakeHome, { recursive: true, force: true })
  }
})


test('v0.9.10 Phone-Approved Access Gate: new browser/computer requires trusted phone approval even with valid HUB_TOKEN, plus SSRF/redact/health/intrusion-monitor checks', async () => {
  const { VoiceVault } = await import('../../hub/voice-vault.js')
  const { redactText } = await import('../lib/redact.js')

  // 1. VoiceVault blocks cloud metadata SSRF URLs while allowing local Ollama
  const vault = new VoiceVault({ vaultFile: '' })
  await vault.init()
  const ssrf1 = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'bad-metadata',
    baseUrl: 'http://169.254.169.254/latest/meta-data',
    apiKey: 'test-key-123',
  })
  assert.equal(ssrf1.ok, false)
  const ssrf2 = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'bad-gcp',
    baseUrl: 'http://metadata.google.internal/computeMetadata/v1',
    apiKey: 'test-key-123',
  })
  assert.equal(ssrf2.ok, false)
  const localOllama = await vault.upsertCredential({
    provider: 'openai_compat',
    label: 'local-ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'ollama',
  })
  assert.equal(localOllama.ok, true)

  // 2. redactText masks Volcengine Ark, Host Token, Gemini AIza/AQ.Ab, GitHub token, mediaTicket
  const sampleLog =
    'ark-1234567890abcdef hst_0123456789abcdef0123456789abcdef0123456789abcdef AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz AQ.AbTestKey9876543210 ghp_abcdefghijklmnopqrstuvwxyz123456 mt1.1795000000000.abcdef1234567890abcdef'
  const redacted = redactText(sampleLog)
  assert.equal(redacted.includes('ark-1234567890abcdef'), false)
  assert.equal(redacted.includes('hst_0123456789abcdef'), false)
  assert.equal(redacted.includes('AIzaSyAbCdEf'), false)
  assert.equal(redacted.includes('AQ.AbTestKey'), false)
  assert.equal(redacted.includes('ghp_abcdef'), false)
  assert.equal(redacted.includes('mt1.1795000000000'), false)

  // 3. Phone-approved zero-trust device login & host join + intrusion push alerts
  let pushCalls = []
  const hub = new HubCore({
    pushFetch: async (url, init) => {
      pushCalls.push({ url, init })
      return { ok: true, status: 201 }
    },
  })
  const adminToken = 'MasterStrongToken_2026_v0910'
  const { dispatchRequest } = createHubServer({
    hub,
    token: adminToken,
    requireToken: true,
    voiceVaultFile: '',
  })

  // Unauthenticated /api/health hides internal host details
  const pubHealth = await dispatchRequest({ method: 'GET', url: '/api/health', remoteAddress: '8.8.8.8' })
  assert.equal(pubHealth.status, 200)
  assert.equal(pubHealth.json.ok, true)
  assert.equal(pubHealth.json.hostsCount, undefined)
  assert.equal(pubHealth.json.activeHostId, undefined)

  // Trusted iPhone enables Device Approval Guard -> receives dedicated dev_... token
  const enableRes = await dispatchRequest({
    method: 'POST',
    url: '/api/security/device-approval',
    headers: { authorization: `Bearer ${adminToken}`, 'user-agent': 'iPhone Safari' },
    remoteAddress: '1.1.1.1',
    body: { enabled: true, deviceId: 'iphone-owner', deviceName: 'Owner iPhone' },
  })
  assert.equal(enableRes.status, 200)
  assert.equal(enableRes.json.deviceApprovalEnabled, true)
  const ownerDevToken = enableRes.json.deviceToken
  assert.ok(ownerDevToken.startsWith('dev_'))

  // Attacker holding LEAKED master HUB_TOKEN tries calling /api/state directly -> BLOCKED with 403 + security event!
  const directSteal = await dispatchRequest({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${adminToken}` },
    remoteAddress: '104.190.190.167',
  })
  assert.equal(directSteal.status, 403)
  assert.equal(directSteal.json.code, 'DEVICE_APPROVAL_REQUIRED')
  assert.ok(hub.getSecuritySummary().total24h >= 1)

  // New browser enters master HUB_TOKEN at /api/auth/verify -> 202 pendingApproval (NOT logged in!)
  const newLogin = await dispatchRequest({
    method: 'POST',
    url: '/api/auth/verify',
    headers: { authorization: `Bearer ${adminToken}`, 'user-agent': 'Chrome macOS' },
    remoteAddress: '203.0.113.55',
    body: { deviceId: 'mac-chrome-new', deviceName: 'Mac Chrome' },
  })
  assert.equal(newLogin.status, 202)
  assert.equal(newLogin.json.pendingApproval, true)
  assert.match(newLogin.json.verifyCode, /^\d{6}$/)
  const reqId = newLogin.json.requestId

  // Poll before approval -> still pending
  const pollBefore = await dispatchRequest({ method: 'GET', url: `/api/auth/device-request/${reqId}` })
  assert.equal(pollBefore.json.status, 'pending')

  // Owner phone sees pendingDeviceLogins in /api/state and taps Approve!
  const ownerState = await dispatchRequest({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${ownerDevToken}` },
  })
  assert.equal(ownerState.status, 200)
  assert.equal(ownerState.json.accessControl.pendingDeviceLogins.length, 1)

  const approveDev = await dispatchRequest({
    method: 'POST',
    url: '/api/security/device-login/decide',
    headers: { authorization: `Bearer ${ownerDevToken}` },
    body: { requestId: reqId, allow: true },
  })
  assert.equal(approveDev.status, 200)

  // Waiting browser polls -> gets one-time dev_... token, can now access /api/state!
  const pollAfter = await dispatchRequest({ method: 'GET', url: `/api/auth/device-request/${reqId}` })
  assert.equal(pollAfter.json.status, 'approved')
  assert.ok(pollAfter.json.token.startsWith('dev_'))
  const newDevState = await dispatchRequest({
    method: 'GET',
    url: '/api/state',
    headers: { authorization: `Bearer ${pollAfter.json.token}` },
  })
  assert.equal(newDevState.status, 200)

  // New computer joining via enrollment code enters pending_approval until phone approves!
  const enroll = hub.getOrCreateEnrollmentCode({ forceNew: true })
  const joinRes = await dispatchRequest({
    method: 'POST',
    url: '/api/hosts/join',
    remoteAddress: '198.51.100.7',
    body: { code: enroll.code, hostId: 'new-mac-mini', hostName: 'New Mac mini', platform: 'darwin' },
  })
  assert.equal(joinRes.status, 200)
  assert.equal(joinRes.json.pendingApproval, true)
  const newHostToken = joinRes.json.hostToken

  // Pending host heartbeat stays quarantined in pendingApproval mode (cannot sync tasks or pull commands)
  const pendingHb = await dispatchRequest({
    method: 'POST',
    url: '/api/heartbeat',
    headers: { authorization: `Bearer ${newHostToken}` },
    body: { hostId: 'new-mac-mini', hostName: 'New Mac mini' },
  })
  assert.equal(pendingHb.status, 200)
  assert.equal(pendingHb.json.pendingApproval, true)

  // Owner phone rejects & revokes the suspicious host
  const rejectHost = await dispatchRequest({
    method: 'POST',
    url: '/api/security/host-join/decide',
    headers: { authorization: `Bearer ${ownerDevToken}` },
    body: { hostId: 'new-mac-mini', allow: false },
  })
  assert.equal(rejectHost.status, 200)
  const afterRevokeHb = await dispatchRequest({
    method: 'POST',
    url: '/api/heartbeat',
    headers: { authorization: `Bearer ${newHostToken}` },
    body: { hostId: 'new-mac-mini', hostName: 'New Mac mini' },
  })
  assert.equal(afterRevokeHb.status, 401)
})
