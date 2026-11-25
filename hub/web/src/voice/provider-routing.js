// Pure, zero-DOM Voice Provider presets, stage routing, and summary helpers.
// Shared by VoiceProviderSheet.tsx, settings-panel.js, and Node unit tests.

export const PROTOCOL_LABELS = {
  native: '手机自带免费',
  openai_compat: 'OpenAI 兼容',
  gemini: 'Gemini 原生',
  volcengine_asr: '火山听写',
  volcengine_tts: '火山播报',
};

export const STAGE_CAPABILITIES = {
  openai_compat: ['stt', 'brain', 'tts'],
  gemini: ['stt', 'brain', 'tts'],
  volcengine_asr: ['stt'],
  volcengine_tts: ['tts'],
};

export const VOICE_PROVIDER_PRESETS = [
  {
    key: 'deepseek',
    icon: '🤖',
    title: 'DeepSeek',
    sub: '高性价比语音大脑',
    provider: 'openai_compat',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultVoice: '',
    resourceId: '',
    modelChips: [
      { label: 'deepseek-chat (推荐)', value: 'deepseek-chat' },
      { label: 'deepseek-reasoner', value: 'deepseek-reasoner' },
    ],
    keyPlaceholder: '粘贴 DeepSeek API Key（例：sk-...）',
  },
  {
    key: 'ark',
    icon: '🌋',
    title: '火山方舟 Ark',
    sub: '豆包 / 方舟 DeepSeek',
    provider: 'openai_compat',
    label: '火山方舟 Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-2-0-lite-260215',
    defaultVoice: '',
    resourceId: '',
    modelChips: [
      { label: '豆包 2.0 Lite (推荐)', value: 'doubao-seed-2-0-lite-260215' },
      { label: '方舟 DeepSeek V3', value: 'deepseek-v3-250324' },
      { label: '方舟 DeepSeek R1', value: 'deepseek-r1-250528' },
    ],
    keyPlaceholder: '粘贴火山方舟 API Key',
  },
  {
    key: 'gemini',
    icon: '✨',
    title: 'Google Gemini',
    sub: '1 把 Key 全包听+想+说',
    provider: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    defaultVoice: 'Kore',
    resourceId: '',
    modelChips: [
      { label: 'gemini-2.5-flash (极速推荐)', value: 'gemini-2.5-flash' },
      { label: 'gemini-3.8-flash', value: 'gemini-3.8-flash' },
    ],
    keyPlaceholder: '粘贴 Gemini Key（例：AIzaSy... 或 AQ.Ab...）',
  },
  {
    key: 'openai',
    icon: '🌐',
    title: 'OpenAI 官方',
    sub: '听写 + 大脑 + 人声全包',
    provider: 'openai_compat',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    defaultVoice: 'alloy',
    resourceId: '',
    modelChips: [
      { label: 'gpt-4o-mini (推荐)', value: 'gpt-4o-mini' },
      { label: 'gpt-4.1-mini', value: 'gpt-4.1-mini' },
    ],
    keyPlaceholder: '粘贴 OpenAI Key（例：sk-proj-...）',
  },
  {
    key: 'volcengine_voice',
    icon: '👂',
    title: '火山豆包语音',
    sub: '中文听写 ASR + 拟人播报 TTS',
    provider: 'volcengine_asr',
    label: '火山豆包识别 (ASR)',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
    defaultModel: '',
    defaultVoice: '',
    resourceId: 'volc.bigasr.auc_turbo',
    alsoCreateTts: true,
    modelChips: [],
    keyPlaceholder: '粘贴火山引擎「语音技术」API Key',
  },
  {
    key: 'siliconflow',
    icon: '⚡',
    title: '硅基流动',
    sub: '国内高速聚合接口',
    provider: 'openai_compat',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    defaultVoice: '',
    resourceId: '',
    modelChips: [
      { label: 'DeepSeek-V3', value: 'deepseek-ai/DeepSeek-V3' },
      { label: 'Qwen2.5-72B', value: 'Qwen/Qwen2.5-72B-Instruct' },
    ],
    keyPlaceholder: '粘贴 SiliconFlow API Key（例：sk-...）',
  },
  {
    key: 'openrouter',
    icon: '🔗',
    title: 'OpenRouter',
    sub: '全球多模型统一路由',
    provider: 'openai_compat',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    defaultVoice: '',
    resourceId: '',
    modelChips: [
      { label: 'openai/gpt-4o-mini', value: 'openai/gpt-4o-mini' },
      { label: 'deepseek/deepseek-chat', value: 'deepseek/deepseek-chat' },
    ],
    keyPlaceholder: '粘贴 OpenRouter API Key（例：sk-or-...）',
  },
  {
    key: 'custom',
    icon: '🔧',
    title: '完全自定义',
    sub: '任意中转站 / 智谱 / Ollama',
    provider: 'openai_compat',
    label: '',
    baseUrl: '',
    defaultModel: '',
    defaultVoice: '',
    resourceId: '',
    modelChips: [],
    keyPlaceholder: '粘贴该服务商的 API Key',
  },
];

export const TTS_VOICE_OPTIONS = {
  volcengine_tts: [
    { label: 'vv 自然女声', value: 'zh_female_vv_uranus_bigtts' },
    { label: '小荷 温柔女声', value: 'zh_female_xiaohe_uranus_bigtts' },
    { label: '阳光男声', value: 'zh_male_m191_uranus_bigtts' },
    { label: '涛诚 稳重男声', value: 'zh_male_taocheng_uranus_bigtts' },
  ],
  gemini: [
    { label: 'Kore (知性女声)', value: 'Kore' },
    { label: 'Puck (轻快)', value: 'Puck' },
    { label: 'Aoede (柔和)', value: 'Aoede' },
    { label: 'Zephyr (清亮)', value: 'Zephyr' },
  ],
  openai_compat: [
    { label: 'alloy (中性)', value: 'alloy' },
    { label: 'nova (清晰女声)', value: 'nova' },
    { label: 'shimmer (柔和)', value: 'shimmer' },
    { label: 'coral (自然)', value: 'coral' },
  ],
};

export function providerSupportsStage(provider, stage) {
  const caps = STAGE_CAPABILITIES[String(provider || '')] || [];
  return caps.includes(stage);
}

export function extractHostFromUrl(rawUrl = '') {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  try {
    return new URL(s).host;
  } catch {
    return s.replace(/^https?:\/\//i, '').split('/')[0] || s;
  }
}

export function inferDefaultBrainModel(cred) {
  if (!cred) return 'rule-router';
  if (cred.defaultModel && String(cred.defaultModel).trim()) {
    return String(cred.defaultModel).trim();
  }
  if (cred.provider === 'gemini') return 'gemini-2.5-flash';
  const u = String(cred.baseUrl || '').toLowerCase();
  if (u.includes('deepseek')) return 'deepseek-chat';
  if (u.includes('volces.com') || u.includes('ark.')) return 'doubao-seed-2-0-lite-260215';
  if (u.includes('groq.com')) return 'llama-3.3-70b-versatile';
  if (u.includes('siliconflow')) return 'deepseek-ai/DeepSeek-V3';
  if (u.includes('11434') || u.includes('ollama')) return 'qwen2.5:7b';
  return 'gpt-4o-mini';
}

export function inferStageModelForCred(cred, stage) {
  if (!cred) {
    if (stage === 'stt') return 'browser-web-speech';
    if (stage === 'brain') return 'rule-router';
    return 'browser-speech-synthesis';
  }
  const m = String(cred.defaultModel || '').trim();
  if (cred.provider === 'volcengine_asr') {
    return String(cred.resourceId || '').trim() || 'volc.bigasr.auc_turbo';
  }
  if (cred.provider === 'volcengine_tts') {
    return String(cred.resourceId || '').trim() || 'seed-tts-2.0';
  }
  if (cred.provider === 'gemini') {
    if (stage === 'tts') {
      return /tts/i.test(m) ? m : 'gemini-2.5-flash-preview-tts';
    }
    return m || 'gemini-2.5-flash';
  }
  // openai_compat
  if (stage === 'stt') {
    if (/whisper|transcribe|asr|audio|sensevoice/i.test(m)) return m;
    return 'gpt-4o-mini-transcribe';
  }
  if (stage === 'tts') {
    if (/tts|speech|cosyvoice|fish/i.test(m)) return m;
    return 'gpt-4o-mini-tts';
  }
  return inferDefaultBrainModel(cred);
}

export function inferStageVoiceForCred(cred, prevVoice = '') {
  if (!cred) return 'system-default';
  const v = String(cred.defaultVoice || '').trim();
  if (v) return v;
  const pv = String(prevVoice || '').trim();
  if (cred.provider === 'volcengine_tts') {
    const isV3 = /3\.0/i.test(String(cred.resourceId || '')) || /voice\.cn-beijing\.volces\.com|text-to-speech/i.test(String(cred.baseUrl || ''));
    if (isV3) {
      return pv && pv.includes('_v3_') ? pv : 'multi_female_tuanzi_v3_uranus_bigtts';
    }
    return pv && pv.startsWith('zh_') ? pv : 'zh_female_vv_uranus_bigtts';
  }
  if (cred.provider === 'gemini') {
    return pv && ['Kore', 'Puck', 'Aoede', 'Zephyr', 'Fenrir'].includes(pv) ? pv : 'Kore';
  }
  if (cred.provider === 'openai_compat') {
    return pv && pv !== 'system-default' ? pv : 'alloy';
  }
  return 'system-default';
}

/**
 * Resolves a stage config to a concrete PublicCredential from credentials[], or null if native / missing.
 */
export function resolveStageCred(stageCfg, credentials = []) {
  if (!stageCfg || !stageCfg.provider || stageCfg.provider === 'native') return null;
  const list = Array.isArray(credentials) ? credentials : [];
  if (stageCfg.credId) {
    const exact = list.find(c => c.id === stageCfg.credId);
    if (exact) return exact;
  }
  const active = list.find(c => c.provider === stageCfg.provider && c.active);
  if (active) return active;
  return list.find(c => c.provider === stageCfg.provider) || null;
}

/**
 * Returns select dropdown value: 'native' | 'cred:<id>' | 'missing:<provider>'
 */
export function getStageSelectValue(stageCfg, credentials = []) {
  if (!stageCfg || !stageCfg.provider || stageCfg.provider === 'native') return 'native';
  const matched = resolveStageCred(stageCfg, credentials);
  if (matched) return `cred:${matched.id}`;
  return `missing:${stageCfg.provider}`;
}

/**
 * Returns which stages ('stt' | 'brain' | 'tts') currently resolve to a given credential id.
 */
export function getCredentialActiveRoles(credId, activeProfile, credentials = []) {
  if (!credId || !activeProfile || activeProfile.id === 'native') return [];
  const roles = [];
  for (const stage of ['stt', 'brain', 'tts']) {
    const resolved = resolveStageCred(activeProfile[stage], credentials);
    if (resolved && resolved.id === credId) {
      roles.push(stage);
    }
  }
  return roles;
}

export function buildStageConfigFromSelectValue(selectVal, stage, credentials = [], prevStage = null) {
  const val = String(selectVal || 'native');
  if (!val || val === 'native' || !val.startsWith('cred:')) {
    if (stage === 'stt') {
      return {
        provider: 'native',
        credId: '',
        model: 'browser-web-speech',
        language: 'zh-CN',
        thinkingLevel: 'default',
        fallbackChain: [],
      };
    }
    if (stage === 'brain') {
      return {
        provider: 'native',
        credId: '',
        model: 'rule-router',
        thinkingLevel: 'off',
        maxTokens: 256,
      };
    }
    return {
      provider: 'native',
      credId: '',
      model: 'browser-speech-synthesis',
      voice: 'system-default',
      format: 'mp3',
      speed: 1.0,
    };
  }

  const credId = val.slice(5);
  const cred = (credentials || []).find(c => c.id === credId);
  if (!cred) {
    return buildStageConfigFromSelectValue('native', stage, credentials, prevStage);
  }

  const model = inferStageModelForCred(cred, stage);
  if (stage === 'stt') {
    return {
      provider: cred.provider,
      credId: cred.id,
      model,
      language: prevStage?.language || 'zh-CN',
      thinkingLevel: cred.provider === 'gemini' ? 'low' : 'default',
      fallbackChain: [],
    };
  }
  if (stage === 'brain') {
    return {
      provider: cred.provider,
      credId: cred.id,
      model,
      thinkingLevel: 'off',
      maxTokens: 320,
    };
  }
  return {
    provider: cred.provider,
    credId: cred.id,
    model,
    voice: inferStageVoiceForCred(cred, prevStage?.voice),
    format: 'mp3',
    speed: prevStage?.speed || 1.0,
  };
}

function shortStageLabel(stageCfg, credentials = []) {
  if (!stageCfg || !stageCfg.provider || stageCfg.provider === 'native') return '手机免费';
  const cred = resolveStageCred(stageCfg, credentials);
  if (cred?.label) return cred.label;
  return PROTOCOL_LABELS[stageCfg.provider] || stageCfg.provider;
}

export function buildAutoProfileName(stt, brain, tts, credentials = []) {
  const isAllNative = stt.provider === 'native' && brain.provider === 'native' && tts.provider === 'native';
  if (isAllNative) return '系统原生语音（免 Key 免费）';

  const sttCred = resolveStageCred(stt, credentials);
  const brainCred = resolveStageCred(brain, credentials);
  const ttsCred = resolveStageCred(tts, credentials);

  if (sttCred && brainCred && ttsCred && sttCred.id === brainCred.id && brainCred.id === ttsCred.id) {
    return `全能 · ${sttCred.label}`;
  }
  if (stt.provider === 'native' && tts.provider === 'native' && brainCred) {
    return `免费听说 + ${brainCred.label}`;
  }
  if (brainCred) {
    const voiceLabel = ttsCred?.label || sttCred?.label || '';
    return voiceLabel ? `${voiceLabel} + ${brainCred.label}` : brainCred.label;
  }
  const parts = [];
  if (stt.provider !== 'native') parts.push(shortStageLabel(stt, credentials));
  if (tts.provider !== 'native' && ttsCred?.id !== sttCred?.id) parts.push(shortStageLabel(tts, credentials));
  return parts.join(' + ') || '自定义语音路由';
}

/**
 * Builds the exact payload to persist a routing change across stt / brain / tts.
 * Returns { isNativeOnly: true } if all 3 stages are native, or { isNativeOnly: false, profilePayload }.
 */
export function buildRoutingProfilePayload({
  sttVal,
  brainVal,
  ttsVal,
  credentials = [],
  existingProfiles = [],
  activeProfile = null,
}) {
  const stt = buildStageConfigFromSelectValue(sttVal, 'stt', credentials, activeProfile?.stt);
  const brain = buildStageConfigFromSelectValue(brainVal, 'brain', credentials, activeProfile?.brain);
  const tts = buildStageConfigFromSelectValue(ttsVal, 'tts', credentials, activeProfile?.tts);

  if (stt.provider === 'native' && brain.provider === 'native' && tts.provider === 'native') {
    return { isNativeOnly: true, stt, brain, tts };
  }

  const name = buildAutoProfileName(stt, brain, tts, credentials);
  // Reuse current non-builtin profile if active, or first non-builtin profile so we don't spam endless duplicate profiles
  const targetProf = (activeProfile && !activeProfile.builtin)
    ? activeProfile
    : (existingProfiles || []).find(p => !p.builtin) || null;

  return {
    isNativeOnly: false,
    profilePayload: {
      id: targetProf?.id || '',
      name,
      stt,
      brain,
      tts,
      activate: true,
    },
  };
}

/**
 * Computes smart default stage assignment when clicking "设为默认" on a single Provider card
 * or checking "保存后立即设为默认" when adding a new Provider.
 */
export function computeSmartDefaultSelection(cred, currentSelection, extraPairedTtsCred = null) {
  const next = {
    sttVal: currentSelection.sttVal || 'native',
    brainVal: currentSelection.brainVal || 'native',
    ttsVal: currentSelection.ttsVal || 'native',
  };
  if (!cred) return next;

  const val = `cred:${cred.id}`;
  if (cred.provider === 'gemini') {
    next.sttVal = val;
    next.brainVal = val;
    next.ttsVal = val;
    return next;
  }
  if (cred.provider === 'volcengine_asr') {
    next.sttVal = val;
    if (extraPairedTtsCred?.id) {
      next.ttsVal = `cred:${extraPairedTtsCred.id}`;
    }
    return next;
  }
  if (cred.provider === 'volcengine_tts') {
    next.ttsVal = val;
    return next;
  }
  // openai_compat: always set Brain default; only set STT/TTS automatically if official OpenAI endpoint
  next.brainVal = val;
  const host = extractHostFromUrl(cred.baseUrl).toLowerCase();
  if (host === 'api.openai.com') {
    next.sttVal = val;
    next.ttsVal = val;
  }
  return next;
}

/**
 * Computes fallback routing selection when a credential is deleted so activeProfile never breaks.
 */
export function computeSelectionAfterDelete(deletedCredId, activeProfile, remainingCredentials = []) {
  const cur = {
    sttVal: getStageSelectValue(activeProfile?.stt, remainingCredentials),
    brainVal: getStageSelectValue(activeProfile?.brain, remainingCredentials),
    ttsVal: getStageSelectValue(activeProfile?.tts, remainingCredentials),
  };
  let affected = false;
  for (const [stage, key] of [['stt', 'sttVal'], ['brain', 'brainVal'], ['tts', 'ttsVal']]) {
    const st = activeProfile?.[stage];
    if (st && st.provider !== 'native') {
      const wasDirectMatch = st.credId === deletedCredId;
      const isNowMissing = cur[key].startsWith('missing:');
      if (wasDirectMatch || isNowMissing) {
        affected = true;
        // Prefer another remaining cred of the same provider if present; otherwise fall back cleanly to native
        const fallbackCred = (remainingCredentials || []).find(c => c.provider === st.provider && c.enabled !== false);
        cur[key] = fallbackCred ? `cred:${fallbackCred.id}` : 'native';
      }
    }
  }
  return { affected, nextSelection: cur };
}

/**
 * Concise 1-line voice summary displayed right on Settings Home ("模型与偏好" -> "边走边听 · 语音总管").
 */
export function formatVoiceSummaryForSettings(voiceCfg) {
  if (!voiceCfg || !voiceCfg.activeProfile) {
    return '免费本机语音 · 点此添加 Provider';
  }
  const prof = voiceCfg.activeProfile;
  const creds = Array.isArray(voiceCfg.credentials) ? voiceCfg.credentials : [];
  if (prof.id === 'native' || (prof.stt?.provider === 'native' && prof.brain?.provider === 'native' && prof.tts?.provider === 'native')) {
    return creds.length > 0
      ? `免费本机语音 · 已添加 ${creds.length} 个 Provider`
      : '免费本机语音 · 点此添加 Provider';
  }
  const sttCred = resolveStageCred(prof.stt, creds);
  const brainCred = resolveStageCred(prof.brain, creds);
  const ttsCred = resolveStageCred(prof.tts, creds);
  if (sttCred && brainCred && ttsCred && sttCred.id === brainCred.id && brainCred.id === ttsCred.id) {
    return `全能：${sttCred.label}${creds.length > 1 ? ` · 共 ${creds.length} 个 Provider` : ''}`;
  }
  const ear = shortStageLabel(prof.stt, creds);
  const brain = shortStageLabel(prof.brain, creds);
  const mouth = shortStageLabel(prof.tts, creds);
  return `听：${ear} · 想：${brain} · 说：${mouth}`;
}

/**
 * Ultra-concise right-side value for Apple-native single-line Settings row ("边走边听").
 */
export function formatVoiceCompactValue(voiceCfg) {
  if (!voiceCfg || !voiceCfg.activeProfile) {
    return '免费本机';
  }
  const prof = voiceCfg.activeProfile;
  const creds = Array.isArray(voiceCfg.credentials) ? voiceCfg.credentials : [];
  if (
    prof.id === 'native'
    || (prof.stt?.provider === 'native' && prof.brain?.provider === 'native' && prof.tts?.provider === 'native')
  ) {
    return creds.length > 0 ? `免费本机 · ${creds.length} 个` : '免费本机';
  }
  const compactName = label => {
    const raw = String(label || '').trim();
    if (!raw) return '自定义';
    if (/火山|豆包/i.test(raw)) return '豆包';
    return raw.replace(/\s*\((ASR|TTS)\)\s*/gi, '').replace(/官方$/g, '').trim() || raw;
  };
  const sttCred = resolveStageCred(prof.stt, creds);
  const brainCred = resolveStageCred(prof.brain, creds);
  const ttsCred = resolveStageCred(prof.tts, creds);
  if (sttCred && brainCred && ttsCred && sttCred.id === brainCred.id && brainCred.id === ttsCred.id) {
    return compactName(sttCred.label);
  }
  const parts = [];
  if (sttCred || ttsCred) {
    parts.push(compactName((sttCred || ttsCred).label));
  }
  if (brainCred && (!parts.length || compactName(brainCred.label) !== parts[0])) {
    parts.push(compactName(brainCred.label));
  }
  return parts.join(' · ') || '已配置';
}
