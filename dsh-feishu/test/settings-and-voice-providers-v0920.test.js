import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PROVIDER_PRESETS,
  buildRoutingProfilePayload,
  computeSelectionAfterDelete,
  computeSmartDefaultSelection,
  formatVoiceSummaryForSettings,
  getCredentialActiveRoles,
  getStageSelectValue,
  inferStageModelForCred,
  resolveStageCred,
} from '../../hub/web/src/voice/provider-routing.js';
import {
  SETTINGS_SUBPAGE_TITLES,
  computePushBadgeMeta,
  createSettingsPanel,
} from '../../hub/web/src/settings/settings-panel.js';
import { VoiceVault } from '../../hub/voice-vault.js';
import { VoiceCopilotEngine } from '../../hub/voice-copilot.js';

test('v0.9.20 provider-routing: multiple arbitrary OpenAI-compatible providers route independently by credId', () => {
  const creds = [
    {
      id: 'cred_oai_ds',
      provider: 'openai_compat',
      label: 'DeepSeek 官方',
      baseUrl: 'https://api.deepseek.com/v1',
      defaultModel: 'deepseek-chat',
      defaultVoice: '',
      resourceId: '',
      enabled: true,
      active: false,
    },
    {
      id: 'cred_oai_relay',
      provider: 'openai_compat',
      label: '我的中转站',
      baseUrl: 'https://relay.myteam.example/v1',
      defaultModel: 'claude-3-7-sonnet',
      defaultVoice: '',
      resourceId: '',
      enabled: true,
      active: true,
    },
    {
      id: 'cred_volc_asr',
      provider: 'volcengine_asr',
      label: '火山豆包识别 (ASR)',
      baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      defaultModel: '',
      defaultVoice: '',
      resourceId: 'volc.bigasr.auc_turbo',
      enabled: true,
      active: true,
    },
    {
      id: 'cred_volc_tts',
      provider: 'volcengine_tts',
      label: '火山豆包播报 (TTS)',
      baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      defaultModel: '',
      defaultVoice: 'zh_female_vv_uranus_bigtts',
      resourceId: 'seed-tts-2.0',
      enabled: true,
      active: true,
    },
  ];

  // Bind Volc ASR + custom relay Brain + Volc TTS
  const plan = buildRoutingProfilePayload({
    sttVal: 'cred:cred_volc_asr',
    brainVal: 'cred:cred_oai_relay',
    ttsVal: 'cred:cred_volc_tts',
    credentials: creds,
    existingProfiles: [],
    activeProfile: null,
  });

  assert.equal(plan.isNativeOnly, false);
  assert.equal(plan.profilePayload.stt.credId, 'cred_volc_asr');
  assert.equal(plan.profilePayload.stt.model, 'volc.bigasr.auc_turbo');
  assert.equal(plan.profilePayload.brain.credId, 'cred_oai_relay');
  assert.equal(plan.profilePayload.brain.model, 'claude-3-7-sonnet');
  assert.equal(plan.profilePayload.tts.credId, 'cred_volc_tts');
  assert.equal(plan.profilePayload.tts.voice, 'zh_female_vv_uranus_bigtts');
  assert.equal(plan.profilePayload.activate, true);

  // Roles reflect exact bound credIds (DeepSeek cred is NOT marked active when relay is selected)
  const activeProf = { id: 'prof_1', ...plan.profilePayload };
  assert.deepEqual(getCredentialActiveRoles('cred_oai_relay', activeProf, creds), ['brain']);
  assert.deepEqual(getCredentialActiveRoles('cred_oai_ds', activeProf, creds), []);
  assert.deepEqual(getCredentialActiveRoles('cred_volc_asr', activeProf, creds), ['stt']);
  assert.deepEqual(getCredentialActiveRoles('cred_volc_tts', activeProf, creds), ['tts']);

  // Settings summary reflects custom provider labels cleanly
  const summary = formatVoiceSummaryForSettings({ activeProfile: activeProf, credentials: creds });
  assert.match(summary, /火山豆包识别/);
  assert.match(summary, /我的中转站/);
  assert.match(summary, /火山豆包播报/);
});

test('v0.9.20 provider-routing: smart defaults & stage model inference behave safely across vendors', () => {
  const dsCred = {
    id: 'cred_ds',
    provider: 'openai_compat',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  };
  const openaiCred = {
    id: 'cred_oai',
    provider: 'openai_compat',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  };
  const geminiCred = {
    id: 'cred_gem',
    provider: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    defaultVoice: 'Kore',
  };

  // DeepSeek default only replaces Brain, keeping Ear/Mouth untouched
  const dsSel = computeSmartDefaultSelection(dsCred, {
    sttVal: 'cred:cred_volc_asr',
    brainVal: 'native',
    ttsVal: 'cred:cred_volc_tts',
  });
  assert.equal(dsSel.sttVal, 'cred:cred_volc_asr');
  assert.equal(dsSel.brainVal, 'cred:cred_ds');
  assert.equal(dsSel.ttsVal, 'cred:cred_volc_tts');

  // Gemini default sets all 3 stages
  const gemSel = computeSmartDefaultSelection(geminiCred, {
    sttVal: 'native',
    brainVal: 'native',
    ttsVal: 'native',
  });
  assert.deepEqual(gemSel, {
    sttVal: 'cred:cred_gem',
    brainVal: 'cred:cred_gem',
    ttsVal: 'cred:cred_gem',
  });

  // OpenAI official maps chat model to transcribe/tts models automatically for STT/TTS
  assert.equal(inferStageModelForCred(openaiCred, 'brain'), 'gpt-4o-mini');
  assert.equal(inferStageModelForCred(openaiCred, 'stt'), 'gpt-4o-mini-transcribe');
  assert.equal(inferStageModelForCred(openaiCred, 'tts'), 'gpt-4o-mini-tts');

  // Custom Whisper model on OpenAI-compat is honored verbatim
  assert.equal(
    inferStageModelForCred({ ...dsCred, defaultModel: 'whisper-large-v3-turbo' }, 'stt'),
    'whisper-large-v3-turbo',
  );

  // Presets include custom free-form option
  assert.ok(VOICE_PROVIDER_PRESETS.some(p => p.key === 'custom'));
});

test('v0.9.20 provider-routing: deleting active credential safely falls back without dangling broken state', () => {
  const remaining = [
    { id: 'cred_ds_backup', provider: 'openai_compat', label: '备用 DS', enabled: true, active: true },
  ];
  const activeProfile = {
    id: 'prof_custom',
    stt: { provider: 'volcengine_asr', credId: 'cred_asr_deleted', model: 'volc.bigasr.auc_turbo' },
    brain: { provider: 'openai_compat', credId: 'cred_oai_deleted', model: 'gpt-4o-mini' },
    tts: { provider: 'native', credId: '', model: 'browser-speech-synthesis' },
  };

  // Before fallback, getStageSelectValue reports missing for deleted ASR cred
  assert.equal(getStageSelectValue(activeProfile.stt, remaining), 'missing:volcengine_asr');
  assert.equal(resolveStageCred(activeProfile.brain, remaining)?.id, 'cred_ds_backup');

  const res = computeSelectionAfterDelete('cred_oai_deleted', activeProfile, remaining);
  assert.equal(res.affected, true);
  assert.equal(res.nextSelection.sttVal, 'native'); // no ASR cred left -> native
  assert.equal(res.nextSelection.brainVal, 'cred:cred_ds_backup'); // remaining openai_compat cred -> backup
  assert.equal(res.nextSelection.ttsVal, 'native');

  // All-native selection produces isNativeOnly: true
  const nativePlan = buildRoutingProfilePayload({
    sttVal: 'native',
    brainVal: 'native',
    ttsVal: 'native',
    credentials: remaining,
  });
  assert.equal(nativePlan.isNativeOnly, true);
});

test('v0.9.20 VoiceVault backend supports multiple arbitrary custom OpenAI-compat providers & key preservation on edit', async () => {
  const vault = new VoiceVault({ vaultFile: '' });
  await vault.init();

  const r1 = await vault.upsertCredential({
    provider: 'openai_compat',
    label: '中转站 A',
    baseUrl: 'https://relay-a.example.com/v1',
    apiKey: 'sk-relay-a-secret-1234',
    defaultModel: 'deepseek-v3',
  });
  assert.equal(r1.ok, true);

  const r2 = await vault.upsertCredential({
    provider: 'openai_compat',
    label: '中转站 B',
    baseUrl: 'https://relay-b.example.com/v1',
    apiKey: 'sk-relay-b-secret-5678',
    defaultModel: 'qwen-max',
  });
  assert.equal(r2.ok, true);
  assert.equal(vault.toPublicState().credentials.length, 2);

  // Edit label & model of r1 without resending apiKey -> preserves existing encrypted apiKey
  const r1Edit = await vault.upsertCredential({
    id: r1.credential.id,
    provider: 'openai_compat',
    label: '中转站 A (新版)',
    baseUrl: 'https://relay-a.example.com/v1',
    defaultModel: 'deepseek-r1',
  });
  assert.equal(r1Edit.ok, true);
  const resolved = vault.resolveCredential({ credId: r1.credential.id });
  assert.equal(resolved.label, '中转站 A (新版)');
  assert.equal(resolved.defaultModel, 'deepseek-r1');
  assert.equal(resolved.apiKey, 'sk-relay-a-secret-1234');
});

test('v0.9.20 settings-panel: renders 4 grouped sections ("模型与偏好") and drills cleanly into all 7 sub-pages', () => {
  const mockViewport = {
    innerHTML: '',
    scrollTop: 120,
    querySelector(sel) {
      return sel === '.settings-wrap' && this.innerHTML.includes('settings-wrap') ? {} : null;
    },
  };

  const mockHubState = {
    build: { version: '0.9.20', uiBuild: 'TEST920', startedAt: Date.now() },
    enrollment: { code: 'AB12CD', expiresAt: Date.now() + 600000, joinedCount: 2 },
    hosts: [
      {
        hostId: 'mac-mini',
        hostName: 'mac-mini',
        online: true,
        isFeishuActive: true,
        remoteActive: true,
        runningCount: 1,
        totalBytes: 204800,
        platform: 'macOS',
        arch: 'arm64',
        fingerprint: 'fp1234567890abcd',
        hasDedicatedToken: true,
        hostTokenPreview: 'hst_ab...cd',
        bridgeState: {
          agentVersion: '0.9.20',
          turbo: { enabled: true, engineLabel: 'Rust' },
          tasks: [{ id: 't1', status: 'running' }],
          harnesses: [{ id: 'codex', label: 'Codex', installed: true, hasBinary: true, capabilities: { canApprove: true } }],
        },
      },
      {
        hostId: 'macbook-air',
        hostName: 'macbook-air',
        online: true,
        runningCount: 0,
        bridgeState: { agentVersion: '0.9.18', tasks: [] },
      },
    ],
    shares: [{ id: 'sh_1', title: '回放 1', hostName: 'mac-mini', createdAt: Date.now(), sizeBytes: 4096 }],
    securitySummary: { total24h: 0, high24h: 0, uniqueIps24h: 0, recentEvents: [] },
    accessControl: {
      deviceApprovalEnabled: true,
      trustedDevices: [{ id: 'dev_1', name: 'iPhone 16 Pro', ip: '1.2.3.4', isCurrent: true, lastSeen: Date.now() }],
      pendingDeviceLogins: [],
      pendingHosts: [],
    },
    pushSubscriptions: [{ deviceName: 'iPhone 主屏幕 App', endpointHost: 'web.push.apple.com' }],
  };

  let voiceCfg = {
    activeProfile: {
      id: 'prof_1',
      name: '豆包 + DeepSeek',
      stt: { provider: 'volcengine_asr', credId: 'c1', model: 'volc.bigasr.auc_turbo' },
      brain: { provider: 'openai_compat', credId: 'c2', model: 'deepseek-chat' },
      tts: { provider: 'volcengine_tts', credId: 'c3', model: 'seed-tts-2.0' },
    },
    credentials: [
      { id: 'c1', provider: 'volcengine_asr', label: '豆包听' },
      { id: 'c2', provider: 'openai_compat', label: 'DeepSeek' },
      { id: 'c3', provider: 'volcengine_tts', label: '豆包说' },
    ],
  };

  let pushRefreshCalls = 0;
  const panel = createSettingsPanel({
    getState: () => ({
      hubState: mockHubState,
      themePref: 'system',
      langPref: 'zh',
      cachedPushStatusText: '本机：✅ 已开启锁屏推送',
      cachedPushStatusColor: '#059669',
      cachedPushDeviceListText: '已在服务端登记 1 台设备',
      upgradingHostMap: {},
      currentDeviceId: 'dev_1',
      tokenTail: '9999',
    }),
    getViewport: () => mockViewport,
    getVoiceConfig: () => voiceCfg,
    isHostLiveOnline: h => Boolean(h.online),
    formatHostTelemetry: () => ({
      powerIcon: '🔋',
      powerShort: '88%',
      powerDetail: '88% 充电中',
      netIcon: '📶',
      netShort: '14ms',
      netDetail: 'Wi-Fi · 14ms',
      lowBattery: false,
    }),
    compareSemver: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
    formatTime: () => '刚刚',
    formatBytes: n => `${n}B`,
    renderHarnessBadgeHtml: id => `[${id}]`,
    renderCapabilityMatrixRowsHtml: () => '<tr><td>Codex</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td><td>✅</td></tr>',
    renderAddHostPanelHtml: ({ forceExpanded }) => `<div id="mockAddHost" data-expanded="${forceExpanded ? '1' : '0'}">ADD HOST CMD</div>`,
    esc: s => String(s ?? ''),
    escJsStr: s => String(s ?? ''),
    escUriJsStr: s => String(s ?? ''),
    refreshPushStatus: () => { pushRefreshCalls += 1; },
  });

  // 1. Render Settings Home (Apple Native Minimalist Design A)
  panel.render(mockViewport);
  assert.equal(panel.getActiveSubpage(), 'home');
  assert.match(mockViewport.innerHTML, /设置/);
  assert.match(mockViewport.innerHTML, /添加电脑/);
  assert.match(mockViewport.innerHTML, /模型与偏好/);
  assert.match(mockViewport.innerHTML, /安全与隐私/);
  assert.match(mockViewport.innerHTML, /更多/);
  // Compact host strip & crisp single-line values on Home
  assert.match(mockViewport.innerHTML, /mac-mini/);
  assert.match(mockViewport.innerHTML, /macbook-air/);
  assert.match(mockViewport.innerHTML, /豆包 · DeepSeek/);
  assert.match(mockViewport.innerHTML, /已开启/);
  assert.match(mockViewport.innerHTML, /1 条/);
  // Heavy capability matrix table is NOT flattened onto Settings Home
  assert.doesNotMatch(mockViewport.innerHTML, /<table/);

  // 2. Signature deduplication avoids unnecessary DOM rewrite
  const firstHtml = mockViewport.innerHTML;
  mockViewport.innerHTML = 'SENTINEL_UNTOUCHED settings-wrap';
  panel.render(mockViewport);
  assert.equal(mockViewport.innerHTML, 'SENTINEL_UNTOUCHED settings-wrap');
  mockViewport.innerHTML = firstHtml;

  // 3. Drill down into every single sub-page (including hosts_list)
  for (const page of Object.keys(SETTINGS_SUBPAGE_TITLES)) {
    panel.openSubpage(page, page === 'host_detail' ? 'mac-mini' : '');
    assert.equal(panel.getActiveSubpage(), page);
    assert.equal(mockViewport.scrollTop, 0);
    assert.match(mockViewport.innerHTML, /id="settingsSubBackBtn"/);
    assert.match(mockViewport.innerHTML, new RegExp(`data-settings-subpage="${page}"`));
  }

  // Verify capabilities subpage DOES render the full matrix table
  assert.match(mockViewport.innerHTML, /<table/);

  // Verify add_host subpage forces expanded view
  panel.openSubpage('add_host');
  assert.match(mockViewport.innerHTML, /data-expanded="1"/);

  // Verify host_detail renders full controls
  panel.openSubpage('host_detail', 'mac-mini');
  assert.match(mockViewport.innerHTML, /飞书主控电脑/);
  assert.match(mockViewport.innerHTML, /吊销凭证/);

  // 4. Close subpage restores home & scroll position
  panel.closeSubpage();
  assert.equal(panel.getActiveSubpage(), 'home');
  assert.equal(mockViewport.scrollTop, 120);
  assert.ok(pushRefreshCalls >= 2);
});

test('v0.9.20 computePushBadgeMeta maps all local push statuses accurately', () => {
  assert.deepEqual(computePushBadgeMeta(''), { text: '检测中', tone: 'muted' });
  assert.deepEqual(computePushBadgeMeta('本机：✅ 已开启锁屏推送'), { text: '已开启', tone: 'green' });
  assert.deepEqual(computePushBadgeMeta('本机：未开启（点下方「开启推送」）'), { text: '未开启', tone: 'amber' });
  assert.deepEqual(computePushBadgeMeta('本机：通知权限被拒绝'), { text: '权限被拒', tone: 'red' });
  assert.deepEqual(computePushBadgeMeta('本机：当前浏览器不支持锁屏推送'), { text: '需主屏幕', tone: 'amber' });
});

test('v0.9.23 VoiceCopilot testCredential supports unsaved draft testing, SSRF & host-change secret guard, and dual ASR+TTS diagnosis', async () => {
  const vault = new VoiceVault({ vaultFile: '' });
  await vault.init();
  const saved = await vault.upsertCredential({
    provider: 'openai_compat',
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'sk-saved-secret-key',
    defaultModel: 'doubao-seed-2-0-lite-260215',
  });
  assert.equal(saved.ok, true);

  let lastAuthSeen = '';
  const mockFetch = async (url, init) => {
    const u = String(url);
    lastAuthSeen = init?.headers?.Authorization || init?.headers?.['x-api-key'] || '';
    if (u.includes('recognize/flash')) {
      return {
        ok: true,
        status: 200,
        headers: { get: k => (k.toLowerCase() === 'x-api-status-code' ? '20000003' : '') },
        json: async () => ({}),
        text: async () => '',
      };
    }
    if (u.includes('tts/unidirectional')) {
      return {
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        text: async () => 'resource seed-tts-2.0 not granted (45000000)',
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '{"ok":true,"spokenReply":"ok"}' } }] }),
      text: async () => '',
    };
  };

  const copilot = new VoiceCopilotEngine({ vault, fetchImpl: mockFetch, hub: null });

  // 1. Unsaved draft OpenAI-compat probe succeeds directly
  const okDraft = await copilot.testCredential({
    draft: {
      provider: 'openai_compat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-draft-live-test',
      defaultModel: 'deepseek-chat',
    },
  });
  assert.equal(okDraft.ok, true);
  assert.equal(lastAuthSeen, 'Bearer sk-draft-live-test');
  assert.match(okDraft.summary, /连通正常/);

  // 2. Editing saved cred on SAME host reuses stored key safely
  const sameHost = await copilot.testCredential({
    draft: {
      id: saved.credential.id,
      provider: 'openai_compat',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: 'deepseek-v3-250324',
    },
  });
  assert.equal(sameHost.ok, true);
  assert.equal(lastAuthSeen, 'Bearer sk-saved-secret-key');

  // 3. Changing host while leaving apiKey blank MUST refuse to send stored key to new host!
  const changedHost = await copilot.testCredential({
    draft: {
      id: saved.credential.id,
      provider: 'openai_compat',
      baseUrl: 'https://evil-exfil.example.com/v1',
      defaultModel: 'gpt-4o-mini',
    },
  });
  assert.equal(changedHost.ok, false);
  assert.match(changedHost.error, /重新填写/);

  // 4. SSRF blocked metadata host rejected immediately
  const ssrf = await copilot.testCredential({
    draft: {
      provider: 'openai_compat',
      baseUrl: 'http://169.254.169.254/latest/meta-data',
      apiKey: 'sk-x',
    },
  });
  assert.equal(ssrf.ok, false);
  assert.match(ssrf.error, /安全策略拦截/);

  // 5. Volcengine dual ASR+TTS draft check surfaces partial success clearly when ASR works but TTS lacks permission
  const volcDual = await copilot.testCredential({
    draft: {
      provider: 'volcengine_asr',
      apiKey: 'volc-key-test',
      alsoTestTts: true,
    },
  });
  assert.equal(volcDual.ok, false);
  assert.equal(volcDual.partialOk, true);
  assert.equal(volcDual.asrOk, true);
  assert.equal(volcDual.ttsOk, false);
  assert.match(volcDual.summary, /听写连通/);
  assert.match(volcDual.summary, /Seed-TTS 2\.0/);

  // 6. v0.9.24 Switching saved Volcengine cred from apiKey -> appToken NEVER falls back to stale apiKey & uses exact ASR/TTS headers
  const volcSaved = await vault.upsertCredential({
    provider: 'volcengine_asr',
    label: '火山听写',
    apiKey: 'stale-wrong-api-key',
  });
  assert.equal(volcSaved.ok, true);
  let capturedHeaders = null;
  const headerProbeCopilot = new VoiceCopilotEngine({
    vault,
    hub: null,
    fetchImpl: async (_url, init) => {
      capturedHeaders = init?.headers || {};
      return {
        ok: true,
        status: 200,
        headers: { get: k => (k.toLowerCase() === 'x-api-status-code' ? '20000003' : 'audio/mpeg') },
        arrayBuffer: async () => Buffer.from('mp3bytes'),
        json: async () => ({}),
        text: async () => '',
      };
    },
  });
  const switched = await headerProbeCopilot.testCredential({
    draft: {
      id: volcSaved.credential.id,
      provider: 'volcengine_asr',
      authMode: 'appToken',
      appId: '99887766',
      accessToken: 'real-volc-token',
    },
  });
  assert.equal(switched.ok, true);
  assert.equal(capturedHeaders['X-Api-Key'], undefined, 'Stale apiKey must NOT be sent in appToken mode');
  assert.equal(capturedHeaders['X-Api-App-Key'], '99887766');
  assert.equal(capturedHeaders['X-Api-App-Id'], undefined, 'ASR uses X-Api-App-Key, not X-Api-App-Id');
  assert.equal(capturedHeaders['X-Api-Access-Key'], 'real-volc-token');

  // Verify TTS uses X-Api-App-Id + X-Api-Access-Key (no X-Api-App-Key)
  const ttsSwitched = await headerProbeCopilot.testCredential({
    draft: {
      provider: 'volcengine_tts',
      authMode: 'appToken',
      appId: '99887766',
      accessToken: 'real-volc-token',
    },
  });
  assert.equal(ttsSwitched.ok, true);
  assert.equal(capturedHeaders['X-Api-Key'], undefined);
  assert.equal(capturedHeaders['X-Api-App-Id'], '99887766');
  assert.equal(capturedHeaders['X-Api-App-Key'], undefined, 'TTS uses X-Api-App-Id, not X-Api-App-Key');
  assert.equal(capturedHeaders['X-Api-Access-Key'], 'real-volc-token');

  // 7. v0.9.25 Volcengine Seed ASR 2.0 Standard (volc.seedasr.auc) uses async /submit + /query polling automatically
  const asyncCalls = [];
  let queryStep = 0;
  const asyncAsrCopilot = new VoiceCopilotEngine({
    vault,
    hub: null,
    fetchImpl: async (url, init) => {
      const u = String(url);
      asyncCalls.push({ url: u, rid: init?.headers?.['X-Api-Resource-Id'], reqId: init?.headers?.['X-Api-Request-Id'] });
      if (u.endsWith('/submit')) {
        return {
          ok: true,
          status: 200,
          headers: { get: k => (k.toLowerCase() === 'x-api-status-code' ? '20000000' : '') },
          json: async () => ({}),
        };
      }
      if (u.endsWith('/query')) {
        queryStep += 1;
        const code = queryStep === 1 ? '20000001' : '20000000';
        return {
          ok: true,
          status: 200,
          headers: { get: k => (k.toLowerCase() === 'x-api-status-code' ? code : '') },
          json: async () => ({ result: { text: '放行第一条审批' } }),
        };
      }
      throw new Error(`Unexpected URL: ${u}`);
    },
  });
  const stdRes = await asyncAsrCopilot.runSingleStt(
    { provider: 'volcengine_asr', model: 'volc.seedasr.auc' },
    {
      audioBase64: Buffer.from('fakewav').toString('base64'),
      mimeType: 'audio/wav',
      credOverride: {
        id: 'cred_std',
        provider: 'volcengine_asr',
        baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
        resourceId: 'volc.seedasr.auc',
        appId: '1554603190',
        accessToken: 'tok-std',
      },
    },
  );
  assert.equal(stdRes.ok, true);
  assert.equal(stdRes.text, '放行第一条审批');
  assert.equal(asyncCalls.length, 3);
  assert.ok(asyncCalls[0].url.endsWith('/api/v3/auc/bigmodel/submit'));
  assert.ok(asyncCalls[1].url.endsWith('/api/v3/auc/bigmodel/query'));
  assert.ok(asyncCalls[2].url.endsWith('/api/v3/auc/bigmodel/query'));
  assert.equal(asyncCalls[0].reqId, asyncCalls[1].reqId, 'query must reuse exact submit X-Api-Request-Id');
  assert.equal(asyncCalls[0].rid, 'volc.seedasr.auc');

  // 8. v0.9.26 Network fetch errors never crash with 500; full /chat/completions Base URL suffix is normalized cleanly
  let seenBrainUrl = '';
  const netErrCopilot = new VoiceCopilotEngine({
    vault,
    hub: null,
    fetchImpl: async (url) => {
      seenBrainUrl = String(url);
      if (seenBrainUrl.includes('timeout.example')) {
        const inner = Object.assign(new Error('connect ETIMEDOUT 101.126.13.31:443'), { code: 'ETIMEDOUT' });
        const agg = new AggregateError([inner], '');
        throw Object.assign(new TypeError('fetch failed'), { cause: agg });
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    },
  });
  const timeoutRes = await netErrCopilot.testCredential({
    draft: {
      provider: 'openai_compat',
      baseUrl: 'https://timeout.example/api/v3',
      apiKey: 'sk-test',
      defaultModel: 'deepseek-v3-250324',
    },
  });
  assert.equal(timeoutRes.ok, false);
  assert.match(timeoutRes.summary, /连接超时或地址不可达/);
  assert.match(timeoutRes.summary, /ETIMEDOUT/);

  const normRes = await netErrCopilot.testCredential({
    draft: {
      provider: 'openai_compat',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions/',
      apiKey: 'sk-test',
      defaultModel: 'deepseek-v3-250324',
    },
  });
  assert.equal(normRes.ok, true);
  assert.equal(seenBrainUrl, 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');

  // 9. v0.9.28 Volcengine Seed-TTS 3.0 HTTP Streaming uses voice.cn-beijing.volces.com, X-Api-Key only, and parses JSONL audio events
  let v3Req = null;
  const v3TtsCopilot = new VoiceCopilotEngine({
    vault,
    hub: null,
    fetchImpl: async (url, init) => {
      v3Req = { url: String(url), headers: init?.headers || {}, body: JSON.parse(String(init?.body || '{}')) };
      const c1 = Buffer.from('mp3part1').toString('base64');
      const c2 = Buffer.from('mp3part2').toString('base64');
      const jsonl = [
        JSON.stringify({ event: 'ready', session_id: 's1' }),
        JSON.stringify({ event: 'audio', audio: c1 }),
        JSON.stringify({ event: 'audio', audio: c2 }),
        JSON.stringify({ event: 'final', is_final: true, reason: 'TTS_STREAM_FINAL_REASON_CLOSED' }),
      ].join('\n');
      return {
        ok: true,
        status: 200,
        headers: { get: k => (k.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : '') },
        text: async () => jsonl,
      };
    },
  });
  const v3Res = await v3TtsCopilot.testCredential({
    draft: {
      provider: 'volcengine_tts',
      authMode: 'apiKey',
      apiKey: 'v3-api-key-only',
      resourceId: 'doubao-seed-tts-3.0',
      defaultVoice: 'multi_female_tuanzi_v3_uranus_bigtts',
    },
  });
  assert.equal(v3Res.ok, true);
  assert.equal(v3Req.url, 'https://voice.cn-beijing.volces.com/api/v3/text-to-speech/multi_female_tuanzi_v3_uranus_bigtts/streaming');
  assert.equal(v3Req.headers['X-Api-Key'], 'v3-api-key-only');
  assert.equal(v3Req.headers['X-Api-App-Id'], undefined);
  assert.equal(v3Req.body.model_id, 'doubao-seed-tts-3.0');
  assert.equal(Buffer.from(v3Res.audioBase64, 'base64').toString(), 'mp3part1mp3part2');
});

test('v0.9.29 native iOS shell audio bridge hooks and background SSE keepalive exemption', async () => {
  const fs = await import('node:fs');
  const walkAudioSrc = fs.readFileSync(new URL('../../hub/web/src/voice/walkAudio.ts', import.meta.url), 'utf8');
  const voiceSheetsSrc = fs.readFileSync(new URL('../../hub/web/src/components/VoiceCopilotSheets.tsx', import.meta.url), 'utf8');
  const controllerSrc = fs.readFileSync(new URL('../../hub/web/src/controller.js', import.meta.url), 'utf8');

  assert.match(walkAudioSrc, /export function getNativeAudioBridge\(/);
  assert.match(walkAudioSrc, /export function isNativeIosShell\(/);
  assert.match(walkAudioSrc, /export async function setWalkBackgroundKeepAlive\(/);
  assert.match(walkAudioSrc, /async stopAsync\(\): Promise<WavRecordingResult \| null>/);
  assert.match(walkAudioSrc, /nativeBridge\.playBase64Audio/);
  assert.match(walkAudioSrc, /nativeBridge\.speakSystemText/);
  assert.match(walkAudioSrc, /nativeBridge\.startRecording/);
  assert.match(voiceSheetsSrc, /setWalkBackgroundKeepAlive\(true,/);
  assert.match(voiceSheetsSrc, /setWalkBackgroundKeepAlive\(false, false, false\)/);
  assert.match(voiceSheetsSrc, /🔒 后台常驻/);
  assert.match(controllerSrc, /__dshWalkKeepAliveActive/);
});
