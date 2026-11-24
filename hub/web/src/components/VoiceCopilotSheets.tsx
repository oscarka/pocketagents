import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  WalkWavRecorder,
  WalkSpeechPlayer,
  WalkWakeLockManager,
  bindWalkMediaSession,
  playEarcon,
  setWalkAudioSessionMode,
} from '../voice/walkAudio';

interface ProviderCatalogItem {
  id: string;
  name: string;
  shortName: string;
  capabilities: string[];
  authMode: 'apiKey' | 'volcengine';
  defaultBaseUrl: string;
  defaultResourceId?: string;
  baseUrlExamples?: Array<{ label: string; url: string }>;
  sampleModels?: { stt?: string[]; brain?: string[]; tts?: string[] };
  sampleVoices?: string[];
  hint?: string;
}

interface PublicCredential {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  resourceId: string;
  defaultModel: string;
  defaultVoice: string;
  enabled: boolean;
  active: boolean;
  authSummary: string;
}

interface StageConfig {
  provider: string;
  credId: string;
  model: string;
  language?: string;
  thinkingLevel?: string;
  maxTokens?: number;
  voice?: string;
  format?: string;
  speed?: number;
  fallbackChain?: Array<{ provider: string; credId: string; model: string; thinkingLevel?: string }>;
}

interface VoiceProfile {
  id: string;
  name: string;
  builtin?: boolean;
  stt: StageConfig;
  brain: StageConfig;
  tts: StageConfig;
}

interface VoicePrefs {
  activeProfileId: string;
  l2Policy: 'pin' | 'screen_only';
  proactiveBriefing: 'approvals' | 'all' | 'manual';
  autoVad: boolean;
  vadSilenceMs: number;
  autoListenAfterBriefing: boolean;
  duckMusicMode: boolean;
  useByokForChatStt: boolean;
  useByokForChatTts: boolean;
  autoPlayWalkReplies: boolean;
  speechRate: number;
}

interface VoiceConfigState {
  storageMode: string;
  catalog: ProviderCatalogItem[];
  credentials: PublicCredential[];
  profiles: VoiceProfile[];
  prefs: VoicePrefs;
  activeProfile: VoiceProfile;
  activePin?: PinChallenge | null;
}

interface PinChallenge {
  id: string;
  pin: string;
  hostId: string;
  code: string;
  agentId: string;
  summary: string;
  reason: string;
  expiresAt: number;
}

const DEFAULT_CONFIG: VoiceConfigState = {
  storageMode: 'memory',
  catalog: [],
  credentials: [],
  profiles: [
    {
      id: 'native',
      name: '系统原生语音（免 Key 免费）',
      builtin: true,
      stt: { provider: 'native', credId: '', model: 'browser-web-speech', language: 'zh-CN', thinkingLevel: 'default', fallbackChain: [] },
      brain: { provider: 'native', credId: '', model: 'rule-router', thinkingLevel: 'off', maxTokens: 256 },
      tts: { provider: 'native', credId: '', model: 'browser-speech-synthesis', voice: 'system-default', format: 'mp3', speed: 1.0 },
    },
  ],
  prefs: {
    activeProfileId: 'native',
    l2Policy: 'pin',
    proactiveBriefing: 'approvals',
    autoVad: true,
    vadSilenceMs: 850,
    autoListenAfterBriefing: true,
    duckMusicMode: true,
    useByokForChatStt: false,
    useByokForChatTts: false,
    autoPlayWalkReplies: true,
    speechRate: 1.0,
  },
  activeProfile: {
    id: 'native',
    name: '系统原生语音（免 Key 免费）',
    builtin: true,
    stt: { provider: 'native', credId: '', model: 'browser-web-speech', language: 'zh-CN', thinkingLevel: 'default', fallbackChain: [] },
    brain: { provider: 'native', credId: '', model: 'rule-router', thinkingLevel: 'off', maxTokens: 256 },
    tts: { provider: 'native', credId: '', model: 'browser-speech-synthesis', voice: 'system-default', format: 'mp3', speed: 1.0 },
  },
};

function apiCall(path: string, options: RequestInit = {}) {
  const bridge = (window as any).__dshVoiceApiFetch;
  if (typeof bridge === 'function') {
    return bridge(path, options);
  }
  const token = (() => {
    try { return localStorage.getItem('dsh_hub_token') || ''; } catch { return ''; }
  })();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['x-hub-token'] = token;
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  return fetch(path, { ...options, headers });
}

function toast(msg: string) {
  try {
    (window as any).showToast?.(msg);
  } catch {}
}

function summarizeHubState(state: any) {
  const hosts = Array.isArray(state?.hosts) ? state.hosts : [];
  const approvals: Array<{ hostId: string; hostName: string; agentId: string; code: string; title: string; risk: string }> = [];
  let runningCount = 0;
  const completedKeys: Array<{ key: string; hostId: string; agentId: string; title: string; hostName: string }> = [];
  for (const h of hosts) {
    const hostName = h?.hostName || h?.hostId || '';
    const bridge = h?.bridgeState || {};
    for (const a of bridge.approvals || []) {
      if (!a) continue;
      approvals.push({
        hostId: h.hostId,
        hostName,
        agentId: String(a.agentId || ''),
        code: String(a.code || ''),
        title: String(a.promptTitle || a.title || a.summary || a.toolName || '工具审批'),
        risk: String(a.risk || ''),
      });
    }
    for (const t of bridge.tasks || []) {
      if (!t) continue;
      if (t.status === 'running') runningCount += 1;
      if (t.status === 'idle' && t.lastConclusionAt) {
        completedKeys.push({
          key: `${h.hostId}:${t.id}:${t.lastConclusionAt}`,
          hostId: h.hostId,
          agentId: String(t.id),
          title: String(t.title || t.id),
          hostName,
        });
      }
    }
  }
  return {
    activeHostId: String(state?.activeHostId || hosts[0]?.hostId || ''),
    activeSessionId: String((window as any).__dshActiveSessionId || ''),
    approvals,
    runningCount,
    completedKeys,
  };
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  native: '系统免费原生',
  gemini: 'Google Gemini',
  openai_compat: 'OpenAI 兼容',
  volcengine_asr: '火山豆包识别',
  volcengine_tts: '火山豆包播报',
};

const PROVIDER_PICKER_CARDS: Array<{ id: string; icon: string; title: string; sub: string; example: string }> = [
  {
    id: 'volcengine_asr',
    icon: '👂',
    title: '火山豆包语音 (听/说)',
    sub: '中文极速听写 + Seed-TTS 2.0 拟人播报',
    example: '在火山引擎控制台「语音技术」创建 API Key；勾选下方选项可一次同时用于听写(ASR)与播报(TTS)，不用贴两遍。',
  },
  {
    id: 'openai_compat',
    icon: '🤖',
    title: 'DeepSeek / 方舟 / OpenAI',
    sub: '语音大脑（总结内容、听懂口令）',
    example: '例：DeepSeek 官方选快捷按钮填 sk-...；火山方舟 Ark 选方舟按钮填方舟 API Key（支持豆包或 DeepSeek 模型）。',
  },
  {
    id: 'gemini',
    icon: '✨',
    title: 'Google Gemini',
    sub: '1 把 Key 全包听 + 想 + 说',
    example: '例：AIzaSy... 或 AQ.Ab...，同一把 Key 可直接搞定听写、大脑和播报。',
  },
  {
    id: 'volcengine_tts',
    icon: '🗣️',
    title: '火山豆包播报 (仅 TTS)',
    sub: '如只开通了语音合成单独填这里',
    example: '默认资源 ID 为 seed-tts-2.0，默认音色 vv 自然女声，无需手填参数。',
  },
];

const SIMPLE_VENDOR_CARDS: Array<{
  id: 'native' | 'gemini' | 'deepseek' | 'ark' | 'openai' | 'mix_volc_ds';
  icon: string;
  title: string;
  sub: string;
}> = [
  { id: 'native', icon: '🆓', title: '免费本机', sub: '免 Key · 手机自带听写播报' },
  { id: 'gemini', icon: '✨', title: 'Gemini（推荐）', sub: '1 把 Key 全包听+想+说' },
  { id: 'deepseek', icon: '🤖', title: 'DeepSeek', sub: '1 把 Key 做大脑 · 免费听说' },
  { id: 'ark', icon: '🌋', title: '火山方舟 Ark', sub: '1 把方舟 Key（豆包/DS）' },
  { id: 'openai', icon: '🌐', title: 'OpenAI', sub: '1 把 Key 全包听+想+说' },
  { id: 'mix_volc_ds', icon: '🔀', title: '火山+DeepSeek混搭', sub: '豆包人声 + DS大脑 ›' },
];

const ARK_MODEL_CHIPS: Array<{ label: string; value: string }> = [
  { label: '豆包 2.0 Lite (推荐)', value: 'doubao-seed-2-0-lite-260215' },
  { label: '方舟 DeepSeek V3', value: 'deepseek-v3-250324' },
  { label: '方舟 DeepSeek R1', value: 'deepseek-r1-250528' },
];

const BRAIN_MODEL_CHIPS: Record<string, Array<{ label: string; value: string }>> = {
  gemini: [
    { label: 'gemini-2.5-flash (极速推荐)', value: 'gemini-2.5-flash' },
    { label: 'gemini-3.8-flash', value: 'gemini-3.8-flash' },
  ],
  openai_compat: [
    { label: 'deepseek-chat (DS官方)', value: 'deepseek-chat' },
    { label: 'doubao-seed-2-0-lite-260215 (豆包)', value: 'doubao-seed-2-0-lite-260215' },
    { label: 'deepseek-v3-250324 (方舟DS)', value: 'deepseek-v3-250324' },
    { label: 'gpt-4o-mini (OpenAI)', value: 'gpt-4o-mini' },
  ],
};

function findSimpleVendorCred(
  vendor: 'gemini' | 'deepseek' | 'ark' | 'openai',
  credentials: PublicCredential[],
): PublicCredential | undefined {
  if (vendor === 'gemini') {
    return credentials.find(c => c.provider === 'gemini' && c.active) || credentials.find(c => c.provider === 'gemini');
  }
  const oaiList = credentials.filter(c => c.provider === 'openai_compat');
  if (vendor === 'deepseek') {
    return oaiList.find(c => String(c.baseUrl || '').toLowerCase().includes('deepseek'));
  }
  if (vendor === 'ark') {
    return oaiList.find(c => /volces\.com|ark\./i.test(String(c.baseUrl || '')));
  }
  return oaiList.find(c => String(c.baseUrl || '').toLowerCase().includes('openai.com'));
}

function inferSimpleVendorFromConfig(cfg: VoiceConfigState): 'native' | 'gemini' | 'deepseek' | 'ark' | 'openai' {
  const prof = cfg.activeProfile;
  if (!prof || prof.id === 'native') {
    if (cfg.credentials.some(c => c.provider === 'gemini')) return 'gemini';
    if (cfg.credentials.some(c => c.provider === 'openai_compat' && /volces\.com|ark\./i.test(c.baseUrl || ''))) return 'ark';
    if (cfg.credentials.some(c => c.provider === 'openai_compat' && /deepseek/i.test(c.baseUrl || ''))) return 'deepseek';
    return 'native';
  }
  if (prof.brain?.provider === 'gemini') return 'gemini';
  if (prof.brain?.provider === 'openai_compat') {
    const cred = cfg.credentials.find(c => c.id === prof.brain?.credId) || cfg.credentials.find(c => c.provider === 'openai_compat' && c.active);
    const u = String(cred?.baseUrl || '').toLowerCase();
    if (u.includes('volces.com') || u.includes('ark.')) return 'ark';
    if (u.includes('deepseek')) return 'deepseek';
    if (u.includes('openai.com')) return 'openai';
  }
  return 'native';
}

const TTS_VOICE_CHIPS: Record<string, Array<{ label: string; value: string }>> = {
  gemini: [
    { label: 'Kore (知性女声)', value: 'Kore' },
    { label: 'Puck (轻快)', value: 'Puck' },
    { label: 'Aoede (柔和)', value: 'Aoede' },
    { label: 'Zephyr (清亮)', value: 'Zephyr' },
  ],
  volcengine_tts: [
    { label: 'vv 自然女声', value: 'zh_female_vv_uranus_bigtts' },
    { label: '小荷 温柔女声', value: 'zh_female_xiaohe_uranus_bigtts' },
    { label: '阳光男声', value: 'zh_male_m191_uranus_bigtts' },
    { label: '涛诚 稳重男声', value: 'zh_male_taocheng_uranus_bigtts' },
  ],
  openai_compat: [
    { label: 'alloy (中性)', value: 'alloy' },
    { label: 'nova (清晰女声)', value: 'nova' },
    { label: 'shimmer (柔和)', value: 'shimmer' },
    { label: 'coral (自然)', value: 'coral' },
  ],
};

function formatStageSummary(
  provider: string,
  model: string | undefined,
  stage: 'stt' | 'brain' | 'tts',
  credId?: string,
  credentials?: PublicCredential[],
): string {
  if (provider === 'native') {
    return stage === 'brain' ? '本地基础口令' : '系统免费原生';
  }
  const matchedCred = credentials?.length
    ? (credentials.find(c => credId && c.id === credId) || credentials.find(c => c.provider === provider && c.active))
    : undefined;
  const base = (provider === 'openai_compat' && matchedCred?.label)
    ? matchedCred.label
    : (PROVIDER_DISPLAY_NAMES[provider] || provider);
  const m = String(model || '').trim();
  if (!m || m === 'default' || m === 'browser-web-speech' || m === 'browser-speech-synthesis' || m === 'rule-router') {
    return base;
  }
  if (stage === 'brain') return `${base} (${m})`;
  return base;
}

function inferOpenAiCompatModel(cred?: PublicCredential | null): string {
  if (cred?.defaultModel) return cred.defaultModel;
  const u = String(cred?.baseUrl || '').toLowerCase();
  if (u.includes('deepseek')) return 'deepseek-chat';
  if (u.includes('volces.com') || u.includes('ark.')) return 'doubao-seed-2-0-lite-260215';
  if (u.includes('groq.com')) return 'llama-3.3-70b-versatile';
  if (u.includes('siliconflow')) return 'deepseek-ai/DeepSeek-V3';
  if (u.includes('11434') || u.includes('ollama')) return 'qwen2.5:7b';
  return 'gpt-4o-mini';
}

function inferDefaultCredLabel(provider: string, baseUrl: string): string {
  if (provider === 'gemini') return 'Google Gemini 主密钥';
  if (provider === 'volcengine_asr') return '火山豆包识别 (ASR)';
  if (provider === 'volcengine_tts') return '火山豆包播报 (TTS)';
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('deepseek')) return 'DeepSeek 官方';
  if (u.includes('volces.com') || u.includes('ark.')) return '火山方舟 Ark';
  if (u.includes('openrouter')) return 'OpenRouter';
  if (u.includes('siliconflow')) return 'SiliconFlow';
  if (u.includes('groq.com')) return 'Groq';
  if (u.includes('11434')) return '本机 Ollama';
  return 'OpenAI 兼容密钥';
}

function getMissingProvidersForProfile(profile: VoiceProfile, credentials: PublicCredential[]): string[] {
  const missing = new Set<string>();
  for (const prov of [profile.stt?.provider, profile.brain?.provider, profile.tts?.provider]) {
    if (!prov || prov === 'native') continue;
    if (!credentials.some(c => c.provider === prov)) {
      missing.add(prov);
    }
  }
  return [...missing];
}

function createSmartProfileDraft(credentials: PublicCredential[]): VoiceProfile {
  const hasAsr = credentials.some(c => c.provider === 'volcengine_asr');
  const hasTts = credentials.some(c => c.provider === 'volcengine_tts');
  const hasGemini = credentials.some(c => c.provider === 'gemini');
  const oaiCred = credentials.find(c => c.provider === 'openai_compat' && c.active) || credentials.find(c => c.provider === 'openai_compat');

  const sttProv = hasAsr ? 'volcengine_asr' : hasGemini ? 'gemini' : 'native';
  const brainProv = hasGemini ? 'gemini' : oaiCred ? 'openai_compat' : 'gemini';
  const ttsProv = hasTts ? 'volcengine_tts' : hasGemini ? 'gemini' : 'native';

  return {
    id: '',
    name: hasAsr && hasTts
      ? `豆包极速听/说 + ${brainProv === 'gemini' ? 'Gemini' : (oaiCred?.label || 'OpenAI')} 大脑`
      : hasGemini
        ? '全 Gemini 极速随行'
        : oaiCred
          ? `免费原生听/说 + ${oaiCred.label} 大脑`
          : '自定义随行方案',
    builtin: false,
    stt: {
      provider: sttProv,
      credId: '',
      model: sttProv === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : sttProv === 'gemini' ? 'gemini-2.5-flash' : 'browser-web-speech',
      language: 'zh-CN',
      thinkingLevel: 'low',
      fallbackChain: [],
    },
    brain: {
      provider: brainProv,
      credId: '',
      model: brainProv === 'gemini' ? 'gemini-2.5-flash' : inferOpenAiCompatModel(oaiCred),
      thinkingLevel: 'off',
      maxTokens: 320,
    },
    tts: {
      provider: ttsProv,
      credId: '',
      model: ttsProv === 'volcengine_tts' ? 'seed-tts-2.0' : ttsProv === 'gemini' ? 'gemini-2.5-flash-preview-tts' : 'browser-speech-synthesis',
      voice: ttsProv === 'volcengine_tts' ? 'zh_female_vv_uranus_bigtts' : ttsProv === 'gemini' ? 'Kore' : 'system-default',
      format: 'mp3',
      speed: 1.0,
    },
  };
}

interface QuickPresetItem {
  key: string;
  badge: string;
  title: string;
  sub: string;
  profile: VoiceProfile;
}

function buildRecommendedQuickProfiles(credentials: PublicCredential[]): QuickPresetItem[] {
  const presets: QuickPresetItem[] = [];
  const geminiCred = credentials.find(c => c.provider === 'gemini' && c.active) || credentials.find(c => c.provider === 'gemini');
  const oaiCred = credentials.find(c => c.provider === 'openai_compat' && c.active) || credentials.find(c => c.provider === 'openai_compat');
  const asrCred = credentials.find(c => c.provider === 'volcengine_asr' && c.active) || credentials.find(c => c.provider === 'volcengine_asr');
  const ttsCred = credentials.find(c => c.provider === 'volcengine_tts' && c.active) || credentials.find(c => c.provider === 'volcengine_tts');

  if ((asrCred || ttsCred) && oaiCred) {
    const brainModel = inferOpenAiCompatModel(oaiCred);
    const brainName = oaiCred.label || 'DeepSeek / 方舟';
    const hasBothVolc = Boolean(asrCred && ttsCred);
    presets.push({
      key: `flagship-volc-oai-${oaiCred.id}`,
      badge: '🏆 推荐混搭',
      title: hasBothVolc ? `豆包极速听/说 + ${brainName} 大脑` : `豆包人声 + ${brainName} 大脑`,
      sub: `耳朵：${asrCred ? '火山 ASR' : '系统免费'} · 大脑：${brainModel} · 嘴巴：${ttsCred ? '火山 Seed-TTS' : '系统免费'}`,
      profile: {
        id: '',
        name: hasBothVolc ? `豆包极速听/说 + ${brainName} 大脑` : `豆包人声 + ${brainName} 大脑`,
        builtin: false,
        stt: asrCred
          ? { provider: 'volcengine_asr', credId: asrCred.id, model: asrCred.resourceId || 'volc.bigasr.auc_turbo', language: 'zh-CN', thinkingLevel: 'low', fallbackChain: geminiCred ? [{ provider: 'gemini', credId: geminiCred.id, model: 'gemini-2.5-flash', thinkingLevel: 'low' }] : [] }
          : { provider: 'native', credId: '', model: 'browser-web-speech', language: 'zh-CN', thinkingLevel: 'default', fallbackChain: [] },
        brain: { provider: 'openai_compat', credId: oaiCred.id, model: brainModel, thinkingLevel: 'off', maxTokens: 320 },
        tts: ttsCred
          ? { provider: 'volcengine_tts', credId: ttsCred.id, model: ttsCred.resourceId || 'seed-tts-2.0', voice: ttsCred.defaultVoice || 'zh_female_vv_uranus_bigtts', format: 'mp3', speed: 1.0 }
          : { provider: 'native', credId: '', model: 'browser-speech-synthesis', voice: 'system-default', format: 'mp3', speed: 1.0 },
      },
    });
  }

  if (asrCred && ttsCred && geminiCred) {
    const brainModel = geminiCred.defaultModel || 'gemini-2.5-flash';
    presets.push({
      key: 'flagship-volc-gemini',
      badge: '🏆 旗舰混搭',
      title: '豆包极速听/说 + Gemini 大脑',
      sub: `耳朵：火山 ASR · 大脑：${brainModel} · 嘴巴：火山 Seed-TTS`,
      profile: {
        id: '',
        name: '豆包极速听/说 + Gemini 大脑',
        builtin: false,
        stt: { provider: 'volcengine_asr', credId: asrCred.id, model: asrCred.resourceId || 'volc.bigasr.auc_turbo', language: 'zh-CN', thinkingLevel: 'low', fallbackChain: [{ provider: 'gemini', credId: geminiCred.id, model: 'gemini-2.5-flash', thinkingLevel: 'low' }] },
        brain: { provider: 'gemini', credId: geminiCred.id, model: brainModel, thinkingLevel: 'off', maxTokens: 320 },
        tts: { provider: 'volcengine_tts', credId: ttsCred.id, model: ttsCred.resourceId || 'seed-tts-2.0', voice: ttsCred.defaultVoice || 'zh_female_vv_uranus_bigtts', format: 'mp3', speed: 1.0 },
      },
    });
  }

  if (geminiCred) {
    const model = geminiCred.defaultModel || 'gemini-2.5-flash';
    const voice = geminiCred.defaultVoice || 'Kore';
    presets.push({
      key: 'all-gemini',
      badge: '✨ 1 把 Key 全包',
      title: '全 Gemini 极速随行',
      sub: `耳朵 + 大脑 + 嘴巴全用 Gemini（${model}），省心零混搭`,
      profile: {
        id: '',
        name: '全 Gemini 极速随行',
        builtin: false,
        stt: { provider: 'gemini', credId: geminiCred.id, model, language: 'zh-CN', thinkingLevel: 'low', fallbackChain: [] },
        brain: { provider: 'gemini', credId: geminiCred.id, model, thinkingLevel: 'off', maxTokens: 320 },
        tts: { provider: 'gemini', credId: geminiCred.id, model: 'gemini-2.5-flash-preview-tts', voice, format: 'mp3', speed: 1.0 },
      },
    });
  }

  if (oaiCred) {
    const model = inferOpenAiCompatModel(oaiCred);
    const shortName = oaiCred.label || 'OpenAI 兼容';
    presets.push({
      key: `native-plus-oai-${oaiCred.id}`,
      badge: '🤖 1 把 Key 省心配',
      title: `免费系统听/说 + ${shortName} 大脑`,
      sub: `手机自带听写播报（免费）+ ${shortName}（${model}）`,
      profile: {
        id: '',
        name: `免费系统听/说 + ${shortName} 大脑`,
        builtin: false,
        stt: { provider: 'native', credId: '', model: 'browser-web-speech', language: 'zh-CN', thinkingLevel: 'default', fallbackChain: [] },
        brain: { provider: 'openai_compat', credId: oaiCred.id, model, thinkingLevel: 'off', maxTokens: 320 },
        tts: { provider: 'native', credId: '', model: 'browser-speech-synthesis', voice: 'system-default', format: 'mp3', speed: 1.0 },
      },
    });
  }

  return presets.slice(0, 4);
}

type MixEarVendor = 'native' | 'volcengine_asr' | 'gemini' | 'openai';
type MixBrainVendor = 'deepseek' | 'ark' | 'gemini' | 'openai' | 'custom' | 'native';
type MixMouthVendor = 'native' | 'volcengine_tts' | 'gemini' | 'openai';

interface MixDraft {
  earVendor: MixEarVendor;
  earApiKey: string;
  earVolcMode: 'apiKey' | 'appToken';
  earAppId: string;
  earAccessToken: string;
  earResourceId: string;

  brainVendor: MixBrainVendor;
  brainReuseEarGemini: boolean;
  brainApiKey: string;
  brainBaseUrl: string;
  brainModel: string;

  mouthVendor: MixMouthVendor;
  mouthReuseKey: boolean;
  mouthApiKey: string;
  mouthVolcMode: 'apiKey' | 'appToken';
  mouthAppId: string;
  mouthAccessToken: string;
  mouthResourceId: string;
  mouthVoice: string;
}

const MIX_COMBO_CARDS: Array<{
  id: 'volc_ds' | 'volc_all' | 'gemini_all' | 'free_voice_brain';
  icon: string;
  title: string;
  sub: string;
}> = [
  { id: 'volc_ds', icon: '🌋', title: '火山豆包 + DeepSeek', sub: '豆包听/说 · DS 大脑' },
  { id: 'volc_all', icon: '🔥', title: '全火山全家桶', sub: '豆包听/说 · 方舟大模型' },
  { id: 'gemini_all', icon: '✨', title: '全 Gemini 极速', sub: '1 把 Key 三段全包' },
  { id: 'free_voice_brain', icon: '💸', title: '免费听/说 + 大脑', sub: '手机听说 · 最省额度' },
];

const DEEPSEEK_MODEL_CHIPS: Array<{ label: string; value: string }> = [
  { label: 'deepseek-chat (推荐)', value: 'deepseek-chat' },
  { label: 'deepseek-reasoner', value: 'deepseek-reasoner' },
];

const OPENAI_MODEL_CHIPS: Array<{ label: string; value: string }> = [
  { label: 'gpt-4o-mini (推荐)', value: 'gpt-4o-mini' },
  { label: 'gpt-4.1-mini', value: 'gpt-4.1-mini' },
];

function findMixCred(
  kind: 'volcengine_asr' | 'volcengine_tts' | 'gemini' | 'deepseek' | 'ark' | 'openai' | 'custom',
  credentials: PublicCredential[],
  customBaseUrl = '',
): PublicCredential | undefined {
  if (kind === 'volcengine_asr' || kind === 'volcengine_tts' || kind === 'gemini') {
    return credentials.find(c => c.provider === kind && c.active) || credentials.find(c => c.provider === kind);
  }
  const oaiList = credentials.filter(c => c.provider === 'openai_compat');
  if (kind === 'deepseek') return oaiList.find(c => String(c.baseUrl || '').toLowerCase().includes('deepseek'));
  if (kind === 'ark') return oaiList.find(c => /volces\.com|ark\./i.test(String(c.baseUrl || '')));
  if (kind === 'openai') return oaiList.find(c => String(c.baseUrl || '').toLowerCase().includes('openai.com'));
  if (customBaseUrl.trim()) {
    const clean = customBaseUrl.trim().replace(/\/+$/, '').toLowerCase();
    const byUrl = oaiList.find(c => String(c.baseUrl || '').replace(/\/+$/, '').toLowerCase() === clean);
    if (byUrl) return byUrl;
  }
  return oaiList.find(c => !/deepseek|volces\.com|ark\.|openai\.com/i.test(String(c.baseUrl || '')));
}

function buildMixDraftFromConfig(cfg: VoiceConfigState): MixDraft {
  const prof = cfg.activeProfile || DEFAULT_CONFIG.activeProfile;
  const creds = cfg.credentials || [];

  const earVendor: MixEarVendor = prof.stt?.provider === 'volcengine_asr'
    ? 'volcengine_asr'
    : prof.stt?.provider === 'gemini'
      ? 'gemini'
      : prof.stt?.provider === 'openai_compat'
        ? 'openai'
        : 'native';

  let brainVendor: MixBrainVendor = 'native';
  let brainBaseUrl = '';
  let brainModel = prof.brain?.model || '';
  if (prof.brain?.provider === 'gemini') {
    brainVendor = 'gemini';
    brainModel = brainModel || 'gemini-2.5-flash';
  } else if (prof.brain?.provider === 'openai_compat') {
    const cred = creds.find(c => c.id === prof.brain?.credId) || creds.find(c => c.provider === 'openai_compat' && c.active) || creds.find(c => c.provider === 'openai_compat');
    const u = String(cred?.baseUrl || '').toLowerCase();
    if (u.includes('deepseek')) {
      brainVendor = 'deepseek';
      brainModel = brainModel || 'deepseek-chat';
    } else if (u.includes('volces.com') || u.includes('ark.')) {
      brainVendor = 'ark';
      brainModel = brainModel || cred?.defaultModel || 'doubao-seed-2-0-lite-260215';
    } else if (u.includes('openai.com')) {
      brainVendor = 'openai';
      brainModel = brainModel || 'gpt-4o-mini';
    } else {
      brainVendor = 'custom';
      brainBaseUrl = cred?.baseUrl || '';
      brainModel = brainModel || cred?.defaultModel || 'deepseek-chat';
    }
  } else {
    brainVendor = 'native';
    brainModel = 'rule-router';
  }

  const mouthVendor: MixMouthVendor = prof.tts?.provider === 'volcengine_tts'
    ? 'volcengine_tts'
    : prof.tts?.provider === 'gemini'
      ? 'gemini'
      : prof.tts?.provider === 'openai_compat'
        ? 'openai'
        : 'native';

  const defaultVoice = mouthVendor === 'volcengine_tts'
    ? 'zh_female_vv_uranus_bigtts'
    : mouthVendor === 'gemini'
      ? 'Kore'
      : mouthVendor === 'openai'
        ? 'alloy'
        : 'system-default';

  const earAsrCred = findMixCred('volcengine_asr', creds);
  const mouthTtsCred = findMixCred('volcengine_tts', creds);

  return {
    earVendor,
    earApiKey: '',
    earVolcMode: 'apiKey',
    earAppId: '',
    earAccessToken: '',
    earResourceId: (earVendor === 'volcengine_asr' && prof.stt?.model && prof.stt.model !== 'browser-web-speech')
      ? prof.stt.model
      : (earAsrCred?.resourceId || 'volc.bigasr.auc_turbo'),

    brainVendor,
    brainReuseEarGemini: earVendor === 'gemini' && brainVendor === 'gemini',
    brainApiKey: '',
    brainBaseUrl,
    brainModel,

    mouthVendor,
    mouthReuseKey: (mouthVendor === 'volcengine_tts' && earVendor === 'volcengine_asr')
      || (mouthVendor === 'gemini' && (earVendor === 'gemini' || brainVendor === 'gemini'))
      || (mouthVendor === 'openai' && (earVendor === 'openai' || brainVendor === 'openai')),
    mouthApiKey: '',
    mouthVolcMode: 'apiKey',
    mouthAppId: '',
    mouthAccessToken: '',
    mouthResourceId: (mouthVendor === 'volcengine_tts' && prof.tts?.model && prof.tts.model !== 'browser-speech-synthesis')
      ? prof.tts.model
      : (mouthTtsCred?.resourceId || 'seed-tts-2.0'),
    mouthVoice: (prof.tts?.voice && prof.tts.voice !== 'system-default') ? prof.tts.voice : defaultVoice,
  };
}

function buildMixProfileName(draft: MixDraft): string {
  if (draft.earVendor === 'native' && draft.brainVendor === 'native' && draft.mouthVendor === 'native') {
    return '系统原生语音（免 Key 免费）';
  }
  if (draft.earVendor === 'gemini' && draft.brainVendor === 'gemini' && draft.mouthVendor === 'gemini') {
    return '全 Gemini 极速随行';
  }
  if (draft.earVendor === 'volcengine_asr' && draft.mouthVendor === 'volcengine_tts') {
    if (draft.brainVendor === 'deepseek') return '火山豆包 + DeepSeek';
    if (draft.brainVendor === 'ark') return '全火山（豆包 + 方舟）';
    if (draft.brainVendor === 'gemini') return '火山豆包 + Gemini';
    if (draft.brainVendor === 'openai') return '火山豆包 + OpenAI';
    if (draft.brainVendor === 'custom') return '火山豆包 + 自定义大脑';
    return '火山豆包语音';
  }
  const brainLabels: Record<MixBrainVendor, string> = {
    deepseek: 'DeepSeek',
    ark: '火山方舟',
    gemini: 'Gemini',
    openai: 'OpenAI',
    custom: '自定义大脑',
    native: '本地口令',
  };
  if (draft.earVendor === 'native' && draft.mouthVendor === 'native') {
    return `免费听/说 + ${brainLabels[draft.brainVendor]}`;
  }
  if (draft.mouthVendor === 'volcengine_tts') {
    return `豆包人声 + ${brainLabels[draft.brainVendor]}`;
  }
  return `自定义混搭 · ${brainLabels[draft.brainVendor]}`;
}

export function VoiceCopilotSheets() {
  const [walkOpen, setWalkOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [labView, setLabView] = useState<'simple' | 'advanced'>('simple');
  const [config, setConfig] = useState<VoiceConfigState>(DEFAULT_CONFIG);
  const [loadingCfg, setLoadingCfg] = useState(false);

  // Level 1 (Simple 1-screen config) state
  const [simpleVendor, setSimpleVendor] = useState<'native' | 'gemini' | 'deepseek' | 'ark' | 'openai'>('gemini');
  const [simpleApiKey, setSimpleApiKey] = useState('');
  const [simpleArkModel, setSimpleArkModel] = useState('doubao-seed-2-0-lite-260215');
  const [simpleSaving, setSimpleSaving] = useState(false);
  const [soundChecking, setSoundChecking] = useState(false);
  const [soundCheckMsg, setSoundCheckMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Level 2 (方案 1+2 合体: 顶部套餐快选 + 3 张就地填 Key 积木卡) state
  const [mix, setMix] = useState<MixDraft>(() => buildMixDraftFromConfig(DEFAULT_CONFIG));
  const [mixSaving, setMixSaving] = useState(false);
  const [mixStatusMsg, setMixStatusMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [geekOpen, setGeekOpen] = useState(false);

  // Walk mode live state
  const [walkPhase, setWalkPhase] = useState<'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'>('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [wakeLocked, setWakeLocked] = useState(false);
  const [lastUserText, setLastUserText] = useState('');
  const [lastReplyText, setLastReplyText] = useState('戴上耳机，轻点下方大圆球，问我进度、审批或直接下达新任务。');
  const [lastActionBadge, setLastActionBadge] = useState('');
  const [lastLatencyBadge, setLastLatencyBadge] = useState('');
  const [activePin, setActivePin] = useState<PinChallenge | null>(null);
  const [pinSecLeft, setPinSecLeft] = useState(0);
  const [walkTextInputOpen, setWalkTextInputOpen] = useState(false);
  const [walkTextDraft, setWalkTextDraft] = useState('');
  const [hubSummary, setHubSummary] = useState(() => summarizeHubState((window as any).__dshLastHubState));

  // Inline test & Bench / Dry-Run Lab state
  const [testingCredId, setTestingCredId] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; summary: string }>>({});
  const [benchDryRun, setBenchDryRun] = useState(true);
  const [benchText, setBenchText] = useState('现在有哪些待审批和运行中的任务？');
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchRecording, setBenchRecording] = useState(false);
  const [benchReport, setBenchReport] = useState<any>(null);

  const recorderRef = useRef<WalkWavRecorder | null>(null);
  const playerRef = useRef<WalkSpeechPlayer | null>(null);
  const wakeRef = useRef<WalkWakeLockManager | null>(null);
  const nativeRecRef = useRef<any>(null);
  const voiceSessionIdRef = useRef(`walk_${Math.random().toString(36).slice(2, 10)}`);
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  const seenCompletedRef = useRef<Set<string>>(new Set());
  const focusedApprovalRef = useRef<{ hostId: string; code: string; slot?: number; announcedAt?: number } | null>(null);
  const briefingQueueRef = useRef<Array<{ kind: 'approval' | 'completed'; key: string; hostId: string; hostName: string; code?: string; agentId?: string; title?: string }>>([]);
  const drainingBriefingRef = useRef(false);
  const walkOpenRef = useRef(false);
  const walkPhaseRef = useRef(walkPhase);
  const configRef = useRef(config);

  useEffect(() => { walkOpenRef.current = walkOpen; }, [walkOpen]);
  useEffect(() => { walkPhaseRef.current = walkPhase; }, [walkPhase]);
  useEffect(() => { configRef.current = config; }, [config]);

  if (!recorderRef.current) recorderRef.current = new WalkWavRecorder();
  if (!playerRef.current) playerRef.current = new WalkSpeechPlayer();
  if (!wakeRef.current) wakeRef.current = new WalkWakeLockManager();

  const refreshConfig = async (silent = false) => {
    if (!silent) setLoadingCfg(true);
    try {
      const res = await apiCall(`/api/voice/config?sessionId=${encodeURIComponent(voiceSessionIdRef.current)}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const next: VoiceConfigState = {
          storageMode: data.storageMode || 'memory',
          catalog: Array.isArray(data.catalog) ? data.catalog : [],
          credentials: Array.isArray(data.credentials) ? data.credentials : [],
          profiles: Array.isArray(data.profiles) && data.profiles.length ? data.profiles : DEFAULT_CONFIG.profiles,
          prefs: { ...DEFAULT_CONFIG.prefs, ...(data.prefs || {}) },
          activeProfile: data.activeProfile || DEFAULT_CONFIG.activeProfile,
          activePin: data.activePin || null,
        };
        setConfig(next);
        if (data.activePin) setActivePin(data.activePin);
        (window as any).__dshVoiceConfig = next;
        window.dispatchEvent(new CustomEvent('dsh:voice-config', { detail: next }));
      }
    } catch {
      // keep fallback native config when offline / unauthenticated
    } finally {
      if (!silent) setLoadingCfg(false);
    }
  };

  // Expose global openers & chat BYOK helpers on window
  useEffect(() => {
    (window as any).openWalkMode = () => {
      setWalkOpen(true);
      void refreshConfig(true);
    };
    (window as any).closeWalkMode = () => {
      setWalkOpen(false);
    };
    (window as any).openVoiceLab = (tab?: 'simple' | 'profiles' | 'keys' | 'bench') => {
      if (!tab || tab === 'simple') {
        setLabView('simple');
        setSimpleVendor(inferSimpleVendorFromConfig(configRef.current));
        setSoundCheckMsg(null);
      } else {
        setLabView('advanced');
        setMix(buildMixDraftFromConfig(configRef.current));
        setMixStatusMsg(null);
        setGeekOpen(tab === 'bench');
      }
      setLabOpen(true);
      void refreshConfig(false);
    };
    (window as any).closeVoiceLab = () => {
      setLabOpen(false);
    };
    (window as any).__dshRefreshVoiceConfig = () => refreshConfig(true);

    // Optional BYOK chat TTS helper invoked by controller.js ONLY when user enables `useByokForChatTts`
    (window as any).__dshVoiceByokSpeak = async (text: string, onDone?: () => void) => {
      const cfg = configRef.current;
      if (!cfg?.prefs?.useByokForChatTts || !cfg?.activeProfile || cfg.activeProfile.tts?.provider === 'native') {
        return false;
      }
      const chunks = String(text || '')
        .split(/(?<=[。！？.!?\n])\s*/)
        .map(s => s.trim())
        .filter(Boolean)
        .reduce<string[]>((acc, s) => {
          const lim = acc.length === 0 ? 48 : 160;
          if (!acc.length || acc[acc.length - 1].length + s.length > lim) acc.push(s);
          else acc[acc.length - 1] += s;
          return acc;
        }, []);
      if (!chunks.length) return false;
      await playerRef.current!.speakChunksProgressive(chunks, {
        useCloudTts: true,
        speechRate: cfg.prefs.speechRate || 1.0,
        fetchTts: async (chunk, signal) => {
          const r = await apiCall('/api/voice/tts', {
            method: 'POST',
            signal,
            body: JSON.stringify({ text: chunk, profileId: cfg.activeProfile.id }),
          });
          return r.json().catch(() => ({ ok: false }));
        },
        onStateChange: playing => {
          if (!playing) onDone?.();
        },
      });
      return true;
    };
    (window as any).__dshVoiceByokStopSpeak = () => {
      playerRef.current?.stop();
    };

    // Optional BYOK chat STT dictation helper (strictly opt-in via `useByokForChatStt`, OFF by default)
    let chatDictRecorder: WalkWavRecorder | null = null;
    let chatDictBtnId = '';
    (window as any).__dshVoiceByokToggleDictation = (
      targetInputId: string,
      btnId: string,
      showToastFn: (m: string) => void,
      onComposerInputFn: () => void,
    ) => {
      const cfg = configRef.current;
      if (!cfg?.prefs?.useByokForChatStt || !cfg?.activeProfile || cfg.activeProfile.stt?.provider === 'native') {
        return false;
      }
      const btn = document.getElementById(btnId);
      const input = document.getElementById(targetInputId) as HTMLTextAreaElement | HTMLInputElement | null;
      if (!input) return false;

      if (chatDictRecorder?.isRecording()) {
        const prevBtn = document.getElementById(chatDictBtnId || btnId);
        prevBtn?.classList.remove('recording');
        const rec = chatDictRecorder.stop();
        chatDictRecorder = null;
        chatDictBtnId = '';
        if (!rec || rec.byteLength < 1200) {
          showToastFn('⏹ 录音太短，已取消');
          return true;
        }
        showToastFn('👂 BYOK 云端识别中…');
        void apiCall('/api/voice/stt', {
          method: 'POST',
          body: JSON.stringify({
            audioBase64: rec.wavBase64,
            mimeType: 'audio/wav',
            profileId: cfg.activeProfile.id,
          }),
        })
          .then(r => r.json().catch(() => ({ ok: false })))
          .then(data => {
            if (data?.ok && String(data.text || '').trim()) {
              const sep = input.value && !/\s$/.test(input.value) ? ' ' : '';
              input.value = `${input.value}${sep}${String(data.text).trim()}`;
              onComposerInputFn();
              showToastFn(`✅ 识别完成 (${data.latencyMs ?? 0}ms)`);
            } else if (data?.silence) {
              showToastFn('未检测到清晰人声');
            } else {
              showToastFn(`⚠️ 云端识别失败：${data?.error || '请检查密钥'}`);
            }
          })
          .catch(() => showToastFn('⚠️ 网络异常，云端识别失败'));
        return true;
      }

      chatDictRecorder = new WalkWavRecorder();
      chatDictBtnId = btnId;
      btn?.classList.add('recording');
      showToastFn('🎙️ BYOK 录音中…说完再点一次发送转写');
      void chatDictRecorder.start({ autoVad: false }).catch((err: any) => {
        btn?.classList.remove('recording');
        chatDictRecorder = null;
        chatDictBtnId = '';
        showToastFn(err?.message || '无法打开麦克风');
      });
      return true;
    };

    // Initial background sync once authenticated
    const initTimer = setTimeout(() => {
      void refreshConfig(true);
    }, 800);

    return () => {
      clearTimeout(initTimer);
      playerRef.current?.stop();
      recorderRef.current?.stop();
      void wakeRef.current?.disable();
    };
  }, []);

  // Track PIN countdown timer
  useEffect(() => {
    if (!activePin) {
      setPinSecLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((activePin.expiresAt - Date.now()) / 1000));
      setPinSecLeft(left);
      if (left <= 0) setActivePin(null);
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [activePin]);

  // WakeLock + AirPods MediaSession + Safari AudioSession lifecycle when Walk Mode opens/closes
  useEffect(() => {
    if (!walkOpen) {
      playerRef.current?.stop();
      stopAllListening();
      briefingQueueRef.current = [];
      drainingBriefingRef.current = false;
      focusedApprovalRef.current = null;
      setWalkAudioSessionMode('auto');
      void wakeRef.current?.disable();
      setWakeLocked(false);
      setWalkPhase('idle');
      return;
    }
    // Seed seen approvals/completions so opening Walk Mode doesn't spam old items
    const snap = summarizeHubState((window as any).__dshLastHubState);
    setHubSummary(snap);
    seenApprovalsRef.current = new Set(snap.approvals.map(a => `${a.hostId}:${a.code}`));
    seenCompletedRef.current = new Set(snap.completedKeys.map(c => c.key));

    // Keep background music playing at full stereo quality while Walk Mode is idle
    if (configRef.current?.prefs?.duckMusicMode !== false) {
      setWalkAudioSessionMode('ambient');
    }

    void wakeRef.current?.enable().then(ok => setWakeLocked(ok));
    const unbindMedia = bindWalkMediaSession({
      onToggleListen: () => { void toggleWalkMic(); },
      onNextBriefing: () => { void runBriefingTurn(); },
      onStopSpeaking: () => {
        playerRef.current?.stop();
        if (configRef.current?.prefs?.duckMusicMode !== false) {
          setWalkAudioSessionMode('ambient');
        }
        if (walkPhaseRef.current === 'speaking') setWalkPhase('idle');
      },
    });
    return () => {
      unbindMedia();
    };
  }, [walkOpen]);

  const drainBriefingQueue = async () => {
    if (drainingBriefingRef.current || !walkOpenRef.current) return;
    if (walkPhaseRef.current !== 'idle') return;
    const nextItem = briefingQueueRef.current.shift();
    if (!nextItem) return;
    drainingBriefingRef.current = true;
    try {
      const cfg = configRef.current;
      const duckMusic = cfg.prefs.duckMusicMode !== false;
      const res = await apiCall('/api/voice/briefing', {
        method: 'POST',
        body: JSON.stringify({
          kind: nextItem.kind,
          hostId: nextItem.hostId,
          code: nextItem.code || '',
          agentId: nextItem.agentId || '',
          profileId: cfg.activeProfile.id,
          voiceSessionId: voiceSessionIdRef.current,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!walkOpenRef.current) return;

      const fallbackText = nextItem.kind === 'approval'
        ? `注意，${nextItem.hostName} 收到新的审批请求：${nextItem.title || nextItem.code}。请说放行或拒绝。`
        : `${nextItem.hostName} 上的任务「${nextItem.title || ''}」已完成。`;
      const spokenText = String(data?.spokenReply || fallbackText).trim();
      const chunks = Array.isArray(data?.spokenChunks) && data.spokenChunks.length > 0 ? data.spokenChunks : [spokenText];
      if (data?.focusedApproval) {
        focusedApprovalRef.current = data.focusedApproval;
      }

      if (duckMusic) {
        setWalkAudioSessionMode('transient');
      }
      playEarcon(nextItem.kind === 'approval' ? 'approval' : 'done');
      setLastReplyText(spokenText);
      setLastActionBadge(
        nextItem.kind === 'approval'
          ? `🔔 ${data?.approval?.slot ? `${data.approval.slot}号` : '新'}待审批 ${nextItem.code || ''}`
          : `✅ 任务完成${data?.summarizedByBrain ? ' · AI 摘要' : ''}`,
      );

      const shouldAutoListen = Boolean(
        (data?.expectReply ?? nextItem.kind === 'approval')
        && cfg.prefs.autoListenAfterBriefing
        && walkOpenRef.current,
      );

      await speakWalkReply(chunks, undefined, { keepAudioSessionAfter: shouldAutoListen });

      if (shouldAutoListen && walkOpenRef.current && walkPhaseRef.current === 'idle') {
        void startWalkListening({ isAutoFollowUp: true });
      }
    } catch {
      if (configRef.current?.prefs?.duckMusicMode !== false && walkOpenRef.current) {
        setWalkAudioSessionMode('ambient');
      }
    } finally {
      drainingBriefingRef.current = false;
      if (walkOpenRef.current && walkPhaseRef.current === 'idle' && briefingQueueRef.current.length > 0) {
        setTimeout(() => { void drainBriefingQueue(); }, 250);
      }
    }
  };

  // Subscribe to live Hub SSE state updates for proactive Walk Mode briefings
  useEffect(() => {
    const onHubState = (ev: any) => {
      const snap = summarizeHubState(ev?.detail || (window as any).__dshLastHubState);
      setHubSummary(snap);
      if (!walkOpenRef.current) return;

      const mode = configRef.current?.prefs?.proactiveBriefing || 'approvals';
      if (mode === 'manual') return;

      let enqueued = false;
      for (const a of snap.approvals) {
        const k = `${a.hostId}:${a.code}`;
        if (seenApprovalsRef.current.has(k)) continue;
        seenApprovalsRef.current.add(k);
        briefingQueueRef.current.push({
          kind: 'approval',
          key: k,
          hostId: a.hostId,
          hostName: a.hostName,
          code: a.code,
          agentId: a.agentId,
          title: a.title,
        });
        enqueued = true;
      }

      if (mode === 'all') {
        for (const c of snap.completedKeys) {
          if (seenCompletedRef.current.has(c.key)) continue;
          seenCompletedRef.current.add(c.key);
          briefingQueueRef.current.push({
            kind: 'completed',
            key: c.key,
            hostId: c.hostId,
            hostName: c.hostName,
            agentId: c.agentId,
            title: c.title,
          });
          enqueued = true;
        }
      }

      if (briefingQueueRef.current.length > 12) {
        briefingQueueRef.current.splice(0, briefingQueueRef.current.length - 12);
      }
      if (enqueued && walkPhaseRef.current === 'idle') {
        void drainBriefingQueue();
      }
    };
    window.addEventListener('dsh:hub-state', onHubState);
    return () => window.removeEventListener('dsh:hub-state', onHubState);
  }, []);

  const stopAllListening = () => {
    if (recorderRef.current?.isRecording()) {
      recorderRef.current.stop();
    }
    if (nativeRecRef.current) {
      try { nativeRecRef.current.stop(); } catch {}
      nativeRecRef.current = null;
    }
    setMicLevel(0);
  };

  const speakWalkReply = async (
    chunks: string[],
    onFirstTtsMs?: (ms: number) => void,
    opts: { keepAudioSessionAfter?: boolean } = {},
  ) => {
    const cfg = configRef.current;
    const duckMusic = cfg.prefs.duckMusicMode !== false;
    if (!cfg.prefs.autoPlayWalkReplies) {
      setWalkPhase('idle');
      if (duckMusic && !opts.keepAudioSessionAfter) {
        setWalkAudioSessionMode('ambient');
      }
      return;
    }
    const useCloud = cfg.activeProfile?.tts?.provider && cfg.activeProfile.tts.provider !== 'native';
    setWalkPhase('speaking');
    await playerRef.current!.speakChunksProgressive(chunks, {
      useCloudTts: Boolean(useCloud),
      speechRate: cfg.prefs.speechRate || 1.0,
      duckMusicMode: duckMusic,
      keepAudioSessionAfter: Boolean(opts.keepAudioSessionAfter),
      fetchTts: async (text, signal) => {
        const r = await apiCall('/api/voice/tts', {
          method: 'POST',
          signal,
          body: JSON.stringify({ text, profileId: cfg.activeProfile.id }),
        });
        return r.json().catch(() => ({ ok: false }));
      },
      onFirstLatency: onFirstTtsMs,
      onStateChange: playing => {
        if (!playing && walkPhaseRef.current === 'speaking') {
          setWalkPhase('idle');
        }
      },
    });
  };

  const handleWalkUserText = async (spokenText: string, sttMs: number | null = null, wavKb: number | null = null) => {
    const clean = String(spokenText || '').trim();
    const duckMusic = configRef.current?.prefs?.duckMusicMode !== false;
    if (!clean) {
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
      setLastReplyText('刚才没有听到清晰人声，轻点圆球再说一次。');
      return;
    }
    setLastUserText(clean);
    setWalkPhase('thinking');
    setLastActionBadge('');

    try {
      const snap = summarizeHubState((window as any).__dshLastHubState);
      const res = await apiCall('/api/voice/turn', {
        method: 'POST',
        body: JSON.stringify({
          text: clean,
          voiceSessionId: voiceSessionIdRef.current,
          activeHostId: snap.activeHostId,
          activeSessionId: snap.activeSessionId,
          focusedApproval: focusedApprovalRef.current,
          profileId: configRef.current.activeProfile.id,
          dryRun: false,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || !data?.ok) {
        playEarcon('alert');
        setWalkPhase('idle');
        if (duckMusic) setWalkAudioSessionMode('ambient');
        const errMsg = data?.error || '语音大脑调用失败，请检查密钥与网络';
        setLastReplyText(errMsg);
        setLastActionBadge('❌ 调用失败');
        return;
      }

      const reply = String(data.spokenReply || '已处理。');
      const chunks = Array.isArray(data.spokenChunks) && data.spokenChunks.length ? data.spokenChunks : [reply];
      setLastReplyText(reply);
      setActivePin(data.pinChallenge || null);
      if (data.nextFocusedApproval !== undefined) {
        focusedApprovalRef.current = data.nextFocusedApproval || null;
      } else if (data.execution?.executed) {
        focusedApprovalRef.current = null;
      }

      if (data.fastPath === 'l2_pin_matched') {
        playEarcon('pin_ok');
        setLastActionBadge(`🔓 确认码通过 · 已放行 ${data.action?.code || ''}`);
      } else if (data.execution?.requiresPin) {
        playEarcon('alert');
        setLastActionBadge(`⚠️ L2 高危拦截 · 需念出 ${data.pinChallenge?.pin || ''}`);
      } else if (data.execution?.ambiguousApprovals || data.action?.ambiguousApprovals) {
        playEarcon('alert');
        setLastActionBadge('🔢 多条待审批 · 请说编号');
      } else if (data.execution?.executed) {
        playEarcon('done');
        const mapLabel: Record<string, string> = {
          approve: '✅ 已放行审批',
          reject: '🚫 已拒绝审批',
          answer_question: '✅ 已提交选择',
          send_prompt: '📤 已发送追问',
          create_task: '✨ 已新建任务',
          stop_session: '⏹ 已发送停止指令',
        };
        setLastActionBadge(mapLabel[data.execution.type] || `✅ ${data.execution.type}`);
      } else if (data.action?.type === 'query_status') {
        setLastActionBadge('📊 状态播报');
      }

      const baseMetrics: string[] = [];
      if (wavKb !== null) baseMetrics.push(`WAV ${wavKb}KB`);
      if (sttMs !== null) baseMetrics.push(`STT ${sttMs}ms`);
      baseMetrics.push(`大脑 ${data.latencyMs ?? 0}ms${data.fastPath ? ' ⚡' : ''}`);
      setLastLatencyBadge(baseMetrics.join(' · '));

      const shouldAutoListen = Boolean(
        data.expectReply
        && configRef.current.prefs.autoListenAfterBriefing
        && walkOpenRef.current,
      );

      await speakWalkReply(
        chunks,
        ttsMs => {
          setLastLatencyBadge([...baseMetrics, `TTS ${ttsMs}ms`].join(' · '));
        },
        { keepAudioSessionAfter: shouldAutoListen },
      );

      if (shouldAutoListen && walkOpenRef.current && walkPhaseRef.current === 'idle') {
        void startWalkListening({ isAutoFollowUp: true });
      } else if (walkOpenRef.current && walkPhaseRef.current === 'idle' && briefingQueueRef.current.length > 0) {
        setTimeout(() => { void drainBriefingQueue(); }, 350);
      }
    } catch (err: any) {
      playEarcon('alert');
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
      setLastReplyText(err?.message || '网络异常，请稍后再试');
      setLastActionBadge('❌ 网络异常');
    }
  };

  const handleWalkWavReady = async (
    rec: { wavBase64: string; byteLength: number; hadSpeech: boolean; silentTimeout?: boolean },
    isAutoFollowUp = false,
  ) => {
    setMicLevel(0);
    const duckMusic = configRef.current?.prefs?.duckMusicMode !== false;
    if (rec.silentTimeout || (isAutoFollowUp && !rec.hadSpeech)) {
      // User stayed silent during auto-listen window -> quietly restore background music!
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
      if (walkOpenRef.current && briefingQueueRef.current.length > 0) {
        setTimeout(() => { void drainBriefingQueue(); }, 350);
      }
      return;
    }
    const wavKb = Math.max(1, Math.round(rec.byteLength / 1024));
    if (rec.byteLength < 1600) {
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
      return;
    }
    setWalkPhase('transcribing');
    try {
      const res = await apiCall('/api/voice/stt', {
        method: 'POST',
        body: JSON.stringify({
          audioBase64: rec.wavBase64,
          mimeType: 'audio/wav',
          profileId: configRef.current.activeProfile.id,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || !data?.ok) {
        playEarcon('alert');
        setWalkPhase('idle');
        if (duckMusic) setWalkAudioSessionMode('ambient');
        setLastReplyText(data?.error || '云端语音识别失败，请在语音配置检查密钥');
        setLastActionBadge('❌ STT 失败');
        return;
      }
      if (data.silence || !String(data.text || '').trim()) {
        setWalkPhase('idle');
        if (duckMusic) setWalkAudioSessionMode('ambient');
        if (!isAutoFollowUp) {
          setLastReplyText('没有检测到清晰人声（静音），轻点圆球重新说。');
          setLastLatencyBadge(`WAV ${wavKb}KB · STT ${data.latencyMs ?? 0}ms · 静音`);
        }
        return;
      }
      await handleWalkUserText(data.text, data.latencyMs ?? 0, wavKb);
    } catch (err: any) {
      playEarcon('alert');
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
      setLastReplyText(err?.message || '语音上传失败');
      setLastActionBadge('❌ 网络失败');
    }
  };

  const startNativeWalkSpeech = (isAutoFollowUp = false) => {
    const duckMusic = configRef.current?.prefs?.duckMusicMode !== false;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      if (!isAutoFollowUp) {
        toast('当前浏览器不支持原生语音识别，可在「配置」添加云端 STT 密钥或使用下方文字输入');
        setWalkTextInputOpen(true);
      }
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
      return;
    }
    setWalkAudioSessionMode('play-and-record');
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    let gotAnyResult = false;
    const t0 = Date.now();
    const silenceGuard = isAutoFollowUp
      ? setTimeout(() => {
          if (!gotAnyResult && nativeRecRef.current === rec) {
            try { rec.stop(); } catch {}
          }
        }, 5500)
      : null;
    rec.onresult = (ev: any) => {
      gotAnyResult = true;
      let txt = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        txt += ev.results[i][0]?.transcript || '';
      }
      finalText = txt.trim();
      if (finalText) setLastUserText(finalText);
    };
    rec.onerror = () => {
      if (silenceGuard) clearTimeout(silenceGuard);
      nativeRecRef.current = null;
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
    };
    rec.onend = () => {
      if (silenceGuard) clearTimeout(silenceGuard);
      nativeRecRef.current = null;
      const elapsed = Date.now() - t0;
      if (finalText) {
        void handleWalkUserText(finalText, elapsed, null);
      } else {
        setWalkPhase('idle');
        if (duckMusic) setWalkAudioSessionMode('ambient');
        if (walkOpenRef.current && briefingQueueRef.current.length > 0) {
          setTimeout(() => { void drainBriefingQueue(); }, 350);
        }
      }
    };
    nativeRecRef.current = rec;
    setWalkPhase('listening');
    playEarcon('listen');
    try {
      rec.start();
    } catch {
      if (silenceGuard) clearTimeout(silenceGuard);
      nativeRecRef.current = null;
      setWalkPhase('idle');
      if (duckMusic) setWalkAudioSessionMode('ambient');
    }
  };

  const startWalkListening = async ({ isAutoFollowUp = false }: { isAutoFollowUp?: boolean } = {}) => {
    if (!walkOpenRef.current) return;
    if (walkPhaseRef.current === 'transcribing' || walkPhaseRef.current === 'thinking' || walkPhaseRef.current === 'listening') {
      return;
    }
    const sttProvider = configRef.current.activeProfile?.stt?.provider || 'native';
    if (sttProvider === 'native') {
      startNativeWalkSpeech(isAutoFollowUp);
      return;
    }
    try {
      playEarcon('listen');
      setWalkPhase('listening');
      await recorderRef.current!.start({
        autoVad: isAutoFollowUp ? true : configRef.current.prefs.autoVad,
        vadSilenceMs: configRef.current.prefs.vadSilenceMs || 850,
        noSpeechTimeoutMs: isAutoFollowUp ? 5500 : 0,
        onLevel: lvl => setMicLevel(lvl),
        onAutoStop: res => {
          void handleWalkWavReady(res, isAutoFollowUp);
        },
      });
    } catch (err: any) {
      setWalkPhase('idle');
      if (configRef.current?.prefs?.duckMusicMode !== false) {
        setWalkAudioSessionMode('ambient');
      }
      if (!isAutoFollowUp) {
        toast(err?.message || '无法打开麦克风，请检查浏览器权限');
      }
    }
  };

  const toggleWalkMic = async () => {
    // Instant Barge-in: tapping orb while speaking cuts off TTS immediately and starts listening!
    if (walkPhaseRef.current === 'speaking') {
      playerRef.current?.stop();
    }
    if (walkPhaseRef.current === 'listening') {
      if (recorderRef.current?.isRecording()) {
        const res = recorderRef.current.stop();
        if (res) void handleWalkWavReady(res, false);
      } else if (nativeRecRef.current) {
        try { nativeRecRef.current.stop(); } catch {}
      }
      return;
    }
    if (walkPhaseRef.current === 'transcribing' || walkPhaseRef.current === 'thinking') {
      return;
    }
    await startWalkListening({ isAutoFollowUp: false });
  };

  const runBriefingTurn = async () => {
    playerRef.current?.stop();
    stopAllListening();
    await handleWalkUserText('汇报一下当前所有电脑的待审批和任务进度');
  };

  const handleClearPin = async (rejectAlso = false) => {
    if (rejectAlso && activePin) {
      await handleWalkUserText('拒绝');
      return;
    }
    await apiCall('/api/voice/pin/clear', {
      method: 'POST',
      body: JSON.stringify({ sessionId: voiceSessionIdRef.current }),
    }).catch(() => {});
    setActivePin(null);
  };

  const updatePrefPatch = async (patch: Partial<VoicePrefs>) => {
    const res = await apiCall('/api/voice/prefs', {
      method: 'POST',
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && data.config) {
      setConfig(prev => ({ ...prev, ...data.config }));
      (window as any).__dshVoiceConfig = data.config;
      window.dispatchEvent(new CustomEvent('dsh:voice-config', { detail: data.config }));
      toast('✅ 语音偏好已保存');
    } else {
      toast(`❌ ${data?.error || '保存失败'}`);
    }
  };

  const handleQuickSoundCheck = async () => {
    const prof = configRef.current.activeProfile || DEFAULT_CONFIG.activeProfile;
    const sampleLine = '你好，随行语音已就绪，戴上耳机随时说话。';
    setSoundChecking(true);
    setSoundCheckMsg(null);
    try {
      const useCloudTts = Boolean(prof.tts?.provider && prof.tts.provider !== 'native');
      if (useCloudTts) {
        const res = await apiCall('/api/voice/tts', {
          method: 'POST',
          body: JSON.stringify({ text: sampleLine, profileId: prof.id }),
        });
        const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        if (!res.ok || !data?.ok) {
          setSoundCheckMsg({ ok: false, text: `❌ 播报失败：${data?.error || '请检查密钥与余额'}` });
          return;
        }
        if (data.audioBase64) {
          await playerRef.current?.playAudioBase64(data.audioBase64, data.mimeType);
        }
        setSoundCheckMsg({ ok: true, text: `✅ 云端人声正常 (${data.latencyMs ?? 0}ms)` });
        return;
      }

      // Native TTS playback + optional brain connectivity check if a cloud brain is active
      void playerRef.current?.speakChunksProgressive([sampleLine], {
        useCloudTts: false,
        speechRate: configRef.current.prefs.speechRate || 1.0,
      });

      if (prof.brain?.provider && prof.brain.provider !== 'native') {
        const brainCred = configRef.current.credentials.find(c => c.id === prof.brain?.credId)
          || configRef.current.credentials.find(c => c.provider === prof.brain?.provider && c.active)
          || configRef.current.credentials.find(c => c.provider === prof.brain?.provider);
        if (brainCred) {
          const testRes = await apiCall('/api/voice/test', {
            method: 'POST',
            body: JSON.stringify({ credId: brainCred.id }),
          });
          const testData = await testRes.json().catch(() => ({ ok: false, error: `HTTP ${testRes.status}` }));
          if (testRes.ok && testData?.ok) {
            setSoundCheckMsg({ ok: true, text: `✅ 手机播报正常 · 大脑已连通 (${testData.latencyMs ?? 0}ms)` });
          } else {
            setSoundCheckMsg({ ok: false, text: `⚠️ 手机已出声，但大脑密钥异常：${testData?.error || '请检查 Key'}` });
          }
          return;
        }
      }
      setSoundCheckMsg({ ok: true, text: '✅ 免费本机播报已出声' });
    } catch (err: any) {
      setSoundCheckMsg({ ok: false, text: `❌ 试听异常：${err?.message || '网络失败'}` });
    } finally {
      setSoundChecking(false);
    }
  };

  const handleSimpleQuickActivate = async () => {
    if (simpleVendor === 'native') {
      await updatePrefPatch({ activeProfileId: 'native' });
      setSoundCheckMsg({ ok: true, text: '✅ 已切换为免费本机语音（零 Key）' });
      return;
    }

    const existingCred = findSimpleVendorCred(simpleVendor, config.credentials);
    const keyTrimmed = simpleApiKey.trim();
    if (!keyTrimmed && !existingCred) {
      toast('⚠️ 请先粘贴 API Key');
      return;
    }

    setSimpleSaving(true);
    setSoundCheckMsg(null);
    try {
      let credId = existingCred?.id || '';
      const vendorSpec = {
        gemini: {
          provider: 'gemini',
          label: 'Google Gemini',
          baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
          model: 'gemini-2.5-flash',
          voice: 'Kore',
          profileName: '全 Gemini 极速随行',
        },
        deepseek: {
          provider: 'openai_compat',
          label: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          voice: '',
          profileName: 'DeepSeek 智能语音',
        },
        ark: {
          provider: 'openai_compat',
          label: '火山方舟 Ark',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          model: simpleArkModel.trim() || 'doubao-seed-2-0-lite-260215',
          voice: '',
          profileName: '火山方舟智能语音',
        },
        openai: {
          provider: 'openai_compat',
          label: 'OpenAI 官方',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
          voice: 'alloy',
          profileName: '全 OpenAI 极速随行',
        },
      }[simpleVendor];

      let latestConfig = config;
      if (keyTrimmed) {
        const credRes = await apiCall('/api/voice/credentials', {
          method: 'POST',
          body: JSON.stringify({
            id: existingCred?.id || '',
            provider: vendorSpec.provider,
            label: vendorSpec.label,
            baseUrl: vendorSpec.baseUrl,
            apiKey: keyTrimmed,
            defaultModel: vendorSpec.model,
            defaultVoice: vendorSpec.voice,
            active: true,
          }),
        });
        const credData = await credRes.json().catch(() => null);
        if (!credRes.ok || !credData?.ok) {
          toast(`❌ ${credData?.error || '保存密钥失败'}`);
          return;
        }
        credId = credData.credential?.id || credId;
        if (credData.config) latestConfig = { ...latestConfig, ...credData.config };
      }

      const existingProf = latestConfig.profiles.find(p => !p.builtin && p.name === vendorSpec.profileName);
      const profilePayload: VoiceProfile & { activate: boolean } = simpleVendor === 'gemini'
        ? {
            id: existingProf?.id || '',
            name: vendorSpec.profileName,
            builtin: false,
            activate: true,
            stt: { provider: 'gemini', credId, model: 'gemini-2.5-flash', language: 'zh-CN', thinkingLevel: 'low', fallbackChain: [] },
            brain: { provider: 'gemini', credId, model: 'gemini-2.5-flash', thinkingLevel: 'off', maxTokens: 320 },
            tts: { provider: 'gemini', credId, model: 'gemini-2.5-flash-preview-tts', voice: 'Kore', format: 'mp3', speed: 1.0 },
          }
        : simpleVendor === 'openai'
          ? {
              id: existingProf?.id || '',
              name: vendorSpec.profileName,
              builtin: false,
              activate: true,
              stt: { provider: 'openai_compat', credId, model: 'gpt-4o-mini-transcribe', language: 'zh-CN', thinkingLevel: 'default', fallbackChain: [] },
              brain: { provider: 'openai_compat', credId, model: 'gpt-4o-mini', thinkingLevel: 'off', maxTokens: 320 },
              tts: { provider: 'openai_compat', credId, model: 'gpt-4o-mini-tts', voice: 'alloy', format: 'mp3', speed: 1.0 },
            }
          : {
              id: existingProf?.id || '',
              name: vendorSpec.profileName,
              builtin: false,
              activate: true,
              stt: { provider: 'native', credId: '', model: 'browser-web-speech', language: 'zh-CN', thinkingLevel: 'default', fallbackChain: [] },
              brain: { provider: 'openai_compat', credId, model: vendorSpec.model, thinkingLevel: 'off', maxTokens: 320 },
              tts: { provider: 'native', credId: '', model: 'browser-speech-synthesis', voice: 'system-default', format: 'mp3', speed: 1.0 },
            };

      const profRes = await apiCall('/api/voice/profiles', {
        method: 'POST',
        body: JSON.stringify(profilePayload),
      });
      const profData = await profRes.json().catch(() => null);
      if (!profRes.ok || !profData?.ok) {
        toast(`❌ ${profData?.error || '启用方案失败'}`);
        return;
      }
      setConfig(prev => ({ ...prev, ...profData.config }));
      setSimpleApiKey('');
      setSoundCheckMsg({ ok: true, text: `✅ 已启用「${vendorSpec.profileName}」，点右边「🔊 试听」即可验证` });
      toast(`✅ 已自动配好并启用「${vendorSpec.profileName}」`);
    } finally {
      setSimpleSaving(false);
    }
  };

  const applyMixCombo = (comboId: 'volc_ds' | 'volc_all' | 'gemini_all' | 'free_voice_brain') => {
    setMixStatusMsg(null);
    const arkCred = findMixCred('ark', config.credentials);
    const asrCred = findMixCred('volcengine_asr', config.credentials);
    const ttsCred = findMixCred('volcengine_tts', config.credentials);
    if (comboId === 'volc_ds') {
      setMix(prev => ({
        ...prev,
        earVendor: 'volcengine_asr',
        earResourceId: asrCred?.resourceId || prev.earResourceId || 'volc.bigasr.auc_turbo',
        brainVendor: 'deepseek',
        brainReuseEarGemini: false,
        brainModel: 'deepseek-chat',
        mouthVendor: 'volcengine_tts',
        mouthReuseKey: true,
        mouthResourceId: ttsCred?.resourceId || prev.mouthResourceId || 'seed-tts-2.0',
        mouthVoice: (prev.mouthVoice && prev.mouthVoice.startsWith('zh_')) ? prev.mouthVoice : (ttsCred?.defaultVoice || 'zh_female_vv_uranus_bigtts'),
      }));
      return;
    }
    if (comboId === 'volc_all') {
      setMix(prev => ({
        ...prev,
        earVendor: 'volcengine_asr',
        earResourceId: asrCred?.resourceId || prev.earResourceId || 'volc.bigasr.auc_turbo',
        brainVendor: 'ark',
        brainReuseEarGemini: false,
        brainModel: arkCred?.defaultModel || 'doubao-seed-2-0-lite-260215',
        mouthVendor: 'volcengine_tts',
        mouthReuseKey: true,
        mouthResourceId: ttsCred?.resourceId || prev.mouthResourceId || 'seed-tts-2.0',
        mouthVoice: (prev.mouthVoice && prev.mouthVoice.startsWith('zh_')) ? prev.mouthVoice : (ttsCred?.defaultVoice || 'zh_female_vv_uranus_bigtts'),
      }));
      return;
    }
    if (comboId === 'gemini_all') {
      setMix(prev => ({
        ...prev,
        earVendor: 'gemini',
        brainVendor: 'gemini',
        brainReuseEarGemini: true,
        brainModel: 'gemini-2.5-flash',
        mouthVendor: 'gemini',
        mouthReuseKey: true,
        mouthVoice: (prev.mouthVoice && ['Kore', 'Puck', 'Aoede', 'Zephyr'].includes(prev.mouthVoice)) ? prev.mouthVoice : 'Kore',
      }));
      return;
    }
    setMix(prev => ({
      ...prev,
      earVendor: 'native',
      brainVendor: prev.brainVendor === 'native' ? 'deepseek' : prev.brainVendor,
      brainReuseEarGemini: false,
      brainModel: prev.brainVendor === 'native' ? 'deepseek-chat' : (prev.brainModel || 'deepseek-chat'),
      mouthVendor: 'native',
      mouthReuseKey: false,
    }));
  };

  const handleSaveMixDraft = async () => {
    setMixSaving(true);
    setMixStatusMsg(null);
    try {
      let latestCfg = config;
      const upsertCred = async (body: Record<string, any>) => {
        const res = await apiCall('/api/voice/credentials', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || '保存密钥失败');
        }
        if (data.config) latestCfg = { ...latestCfg, ...data.config };
        return data.credential?.id as string;
      };

      // 1. Ear (STT)
      let earCredId = '';
      let sttStage: StageConfig = {
        provider: 'native',
        credId: '',
        model: 'browser-web-speech',
        language: 'zh-CN',
        thinkingLevel: 'default',
        fallbackChain: [],
      };

      if (mix.earVendor === 'volcengine_asr') {
        const existing = findMixCred('volcengine_asr', latestCfg.credentials);
        const hasNewKey = mix.earVolcMode === 'appToken'
          ? Boolean(mix.earAppId.trim() && mix.earAccessToken.trim())
          : Boolean(mix.earApiKey.trim());
        if (hasNewKey) {
          earCredId = await upsertCred({
            id: existing?.id || '',
            provider: 'volcengine_asr',
            label: existing?.label || '火山豆包语音 (ASR)',
            baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
            apiKey: mix.earVolcMode === 'appToken' ? '' : mix.earApiKey.trim(),
            appId: mix.earVolcMode === 'appToken' ? mix.earAppId.trim() : '',
            accessToken: mix.earVolcMode === 'appToken' ? mix.earAccessToken.trim() : '',
            resourceId: mix.earResourceId.trim() || 'volc.bigasr.auc_turbo',
            active: true,
          });
        } else if (existing) {
          earCredId = existing.id;
        } else {
          setMixStatusMsg({ ok: false, text: '⚠️ 请在「👂 1. 听我说话」粘贴火山语音 Key，或改选「手机自带免费」' });
          return;
        }
        sttStage = {
          provider: 'volcengine_asr',
          credId: earCredId,
          model: mix.earResourceId.trim() || 'volc.bigasr.auc_turbo',
          language: 'zh-CN',
          thinkingLevel: 'low',
          fallbackChain: [],
        };
      } else if (mix.earVendor === 'gemini') {
        const existing = findMixCred('gemini', latestCfg.credentials);
        if (mix.earApiKey.trim()) {
          earCredId = await upsertCred({
            id: existing?.id || '',
            provider: 'gemini',
            label: existing?.label || 'Google Gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: mix.earApiKey.trim(),
            defaultModel: 'gemini-2.5-flash',
            defaultVoice: 'Kore',
            active: true,
          });
        } else if (existing) {
          earCredId = existing.id;
        } else {
          setMixStatusMsg({ ok: false, text: '⚠️ 请在「👂 1. 听我说话」粘贴 Gemini Key，或改选「手机自带免费」' });
          return;
        }
        sttStage = {
          provider: 'gemini',
          credId: earCredId,
          model: 'gemini-2.5-flash',
          language: 'zh-CN',
          thinkingLevel: 'low',
          fallbackChain: [],
        };
      } else if (mix.earVendor === 'openai') {
        const existing = findMixCred('openai', latestCfg.credentials);
        if (mix.earApiKey.trim()) {
          earCredId = await upsertCred({
            id: existing?.id || '',
            provider: 'openai_compat',
            label: existing?.label || 'OpenAI 官方',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: mix.earApiKey.trim(),
            defaultModel: 'gpt-4o-mini',
            defaultVoice: 'alloy',
            active: true,
          });
        } else if (existing) {
          earCredId = existing.id;
        } else {
          setMixStatusMsg({ ok: false, text: '⚠️ 请在「👂 1. 听我说话」粘贴 OpenAI Key，或改选「手机自带免费」' });
          return;
        }
        sttStage = {
          provider: 'openai_compat',
          credId: earCredId,
          model: 'gpt-4o-mini-transcribe',
          language: 'zh-CN',
          thinkingLevel: 'default',
          fallbackChain: [],
        };
      }

      // 2. Brain (LLM)
      let brainCredId = '';
      let brainStage: StageConfig = {
        provider: 'native',
        credId: '',
        model: 'rule-router',
        thinkingLevel: 'off',
        maxTokens: 256,
      };

      if (mix.brainVendor === 'gemini') {
        if (mix.earVendor === 'gemini' && mix.brainReuseEarGemini && earCredId) {
          brainCredId = earCredId;
        } else {
          const existing = findMixCred('gemini', latestCfg.credentials);
          if (mix.brainApiKey.trim()) {
            brainCredId = await upsertCred({
              id: existing?.id || '',
              provider: 'gemini',
              label: existing?.label || 'Google Gemini',
              baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
              apiKey: mix.brainApiKey.trim(),
              defaultModel: mix.brainModel.trim() || 'gemini-2.5-flash',
              defaultVoice: 'Kore',
              active: true,
            });
          } else if (existing) {
            brainCredId = existing.id;
          } else {
            setMixStatusMsg({ ok: false, text: '⚠️ 请在「🧠 2. 帮我思考」粘贴 Gemini Key' });
            return;
          }
        }
        brainStage = {
          provider: 'gemini',
          credId: brainCredId,
          model: mix.brainModel.trim() || 'gemini-2.5-flash',
          thinkingLevel: 'off',
          maxTokens: 320,
        };
      } else if (mix.brainVendor !== 'native') {
        if (mix.brainVendor === 'custom' && !mix.brainBaseUrl.trim()) {
          setMixStatusMsg({ ok: false, text: '⚠️ 自定义中转站请填写接口地址（Base URL）' });
          return;
        }
        const meta = {
          deepseek: { label: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1', defModel: 'deepseek-chat' },
          ark: { label: '火山方舟 Ark', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defModel: 'doubao-seed-2-0-lite-260215' },
          openai: { label: 'OpenAI 官方', baseUrl: 'https://api.openai.com/v1', defModel: 'gpt-4o-mini' },
          custom: { label: '自定义中转', baseUrl: mix.brainBaseUrl.trim(), defModel: 'deepseek-chat' },
        }[mix.brainVendor];
        const modelVal = mix.brainModel.trim() || meta.defModel;
        const existing = findMixCred(mix.brainVendor, latestCfg.credentials, meta.baseUrl);
        if (mix.brainApiKey.trim()) {
          brainCredId = await upsertCred({
            id: existing?.id || '',
            provider: 'openai_compat',
            label: existing?.label || meta.label,
            baseUrl: meta.baseUrl,
            apiKey: mix.brainApiKey.trim(),
            defaultModel: modelVal,
            active: true,
          });
        } else if (existing) {
          brainCredId = existing.id;
        } else {
          setMixStatusMsg({ ok: false, text: `⚠️ 请在「🧠 2. 帮我思考」粘贴 ${meta.label} 的 API Key` });
          return;
        }
        brainStage = {
          provider: 'openai_compat',
          credId: brainCredId,
          model: modelVal,
          thinkingLevel: 'off',
          maxTokens: 320,
        };
      }

      // 3. Mouth (TTS)
      let mouthCredId = '';
      let ttsStage: StageConfig = {
        provider: 'native',
        credId: '',
        model: 'browser-speech-synthesis',
        voice: 'system-default',
        format: 'mp3',
        speed: 1.0,
      };

      if (mix.mouthVendor === 'volcengine_tts') {
        const existingTts = findMixCred('volcengine_tts', latestCfg.credentials);
        const voiceVal = mix.mouthVoice.trim() || 'zh_female_vv_uranus_bigtts';
        const resVal = mix.mouthResourceId.trim() || 'seed-tts-2.0';
        const reusingEar = mix.mouthReuseKey && mix.earVendor === 'volcengine_asr';

        if (reusingEar && earCredId) {
          const earHasFreshKey = mix.earVolcMode === 'appToken'
            ? Boolean(mix.earAppId.trim() && mix.earAccessToken.trim())
            : Boolean(mix.earApiKey.trim());
          mouthCredId = await upsertCred({
            id: existingTts?.id || '',
            provider: 'volcengine_tts',
            label: existingTts?.label || '火山豆包播报 (TTS)',
            baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
            ...(earHasFreshKey
              ? {
                  apiKey: mix.earVolcMode === 'appToken' ? '' : mix.earApiKey.trim(),
                  appId: mix.earVolcMode === 'appToken' ? mix.earAppId.trim() : '',
                  accessToken: mix.earVolcMode === 'appToken' ? mix.earAccessToken.trim() : '',
                }
              : { cloneSecretFromCredId: earCredId }),
            resourceId: resVal,
            defaultVoice: voiceVal,
            active: true,
          });
        } else {
          const hasNewMouthKey = mix.mouthVolcMode === 'appToken'
            ? Boolean(mix.mouthAppId.trim() && mix.mouthAccessToken.trim())
            : Boolean(mix.mouthApiKey.trim());
          if (hasNewMouthKey) {
            mouthCredId = await upsertCred({
              id: existingTts?.id || '',
              provider: 'volcengine_tts',
              label: existingTts?.label || '火山豆包播报 (TTS)',
              baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
              apiKey: mix.mouthVolcMode === 'appToken' ? '' : mix.mouthApiKey.trim(),
              appId: mix.mouthVolcMode === 'appToken' ? mix.mouthAppId.trim() : '',
              accessToken: mix.mouthVolcMode === 'appToken' ? mix.mouthAccessToken.trim() : '',
              resourceId: resVal,
              defaultVoice: voiceVal,
              active: true,
            });
          } else if (existingTts) {
            mouthCredId = existingTts.id;
          } else {
            setMixStatusMsg({ ok: false, text: '⚠️ 请在「🗣️ 3. 念给我听」粘贴火山语音 Key，或改选「手机自带免费」' });
            return;
          }
        }
        ttsStage = {
          provider: 'volcengine_tts',
          credId: mouthCredId,
          model: resVal,
          voice: voiceVal,
          format: 'mp3',
          speed: 1.0,
        };
      } else if (mix.mouthVendor === 'gemini') {
        const voiceVal = mix.mouthVoice.trim() || 'Kore';
        const sharedGeminiId = (mix.mouthReuseKey && (mix.earVendor === 'gemini' ? earCredId : mix.brainVendor === 'gemini' ? brainCredId : '')) || '';
        if (sharedGeminiId) {
          mouthCredId = sharedGeminiId;
        } else {
          const existing = findMixCred('gemini', latestCfg.credentials);
          if (mix.mouthApiKey.trim()) {
            mouthCredId = await upsertCred({
              id: existing?.id || '',
              provider: 'gemini',
              label: existing?.label || 'Google Gemini',
              baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
              apiKey: mix.mouthApiKey.trim(),
              defaultModel: 'gemini-2.5-flash',
              defaultVoice: voiceVal,
              active: true,
            });
          } else if (existing) {
            mouthCredId = existing.id;
          } else {
            setMixStatusMsg({ ok: false, text: '⚠️ 请在「🗣️ 3. 念给我听」粘贴 Gemini Key' });
            return;
          }
        }
        ttsStage = {
          provider: 'gemini',
          credId: mouthCredId,
          model: 'gemini-2.5-flash-preview-tts',
          voice: voiceVal,
          format: 'mp3',
          speed: 1.0,
        };
      } else if (mix.mouthVendor === 'openai') {
        const voiceVal = mix.mouthVoice.trim() || 'alloy';
        const sharedOaiId = (mix.mouthReuseKey && (mix.earVendor === 'openai' ? earCredId : mix.brainVendor === 'openai' ? brainCredId : '')) || '';
        if (sharedOaiId) {
          mouthCredId = sharedOaiId;
        } else {
          const existing = findMixCred('openai', latestCfg.credentials);
          if (mix.mouthApiKey.trim()) {
            mouthCredId = await upsertCred({
              id: existing?.id || '',
              provider: 'openai_compat',
              label: existing?.label || 'OpenAI 官方',
              baseUrl: 'https://api.openai.com/v1',
              apiKey: mix.mouthApiKey.trim(),
              defaultModel: 'gpt-4o-mini',
              defaultVoice: voiceVal,
              active: true,
            });
          } else if (existing) {
            mouthCredId = existing.id;
          } else {
            setMixStatusMsg({ ok: false, text: '⚠️ 请在「🗣️ 3. 念给我听」粘贴 OpenAI Key' });
            return;
          }
        }
        ttsStage = {
          provider: 'openai_compat',
          credId: mouthCredId,
          model: 'gpt-4o-mini-tts',
          voice: voiceVal,
          format: 'mp3',
          speed: 1.0,
        };
      }

      // 4. Save & activate unified profile
      if (mix.earVendor === 'native' && mix.brainVendor === 'native' && mix.mouthVendor === 'native') {
        await updatePrefPatch({ activeProfileId: 'native' });
        setMixStatusMsg({ ok: true, text: '✅ 已切换为免费本机语音' });
        return;
      }

      const profName = buildMixProfileName(mix);
      const existingProf = latestCfg.profiles.find(p => !p.builtin && p.name === profName);
      const profRes = await apiCall('/api/voice/profiles', {
        method: 'POST',
        body: JSON.stringify({
          id: existingProf?.id || '',
          name: profName,
          stt: sttStage,
          brain: brainStage,
          tts: ttsStage,
          activate: true,
        }),
      });
      const profData = await profRes.json().catch(() => null);
      if (!profRes.ok || !profData?.ok) {
        throw new Error(profData?.error || '保存混搭方案失败');
      }

      setConfig(prev => ({ ...prev, ...profData.config }));
      setMix(prev => ({
        ...prev,
        earApiKey: '',
        earAppId: '',
        earAccessToken: '',
        brainApiKey: '',
        mouthApiKey: '',
        mouthAppId: '',
        mouthAccessToken: '',
      }));
      setMixStatusMsg({ ok: true, text: `✅ 已生效：「${profName}」，点右边「🔊 试听」立刻听效果` });
      toast(`✅ 已保存并启用「${profName}」`);
    } catch (err: any) {
      setMixStatusMsg({ ok: false, text: `❌ ${err?.message || '保存失败'}` });
    } finally {
      setMixSaving(false);
    }
  };

  const handleTestCredential = async (credId: string) => {
    setTestingCredId(credId);
    try {
      const res = await apiCall('/api/voice/test', {
        method: 'POST',
        body: JSON.stringify({ credId }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      setTestResults(prev => ({
        ...prev,
        [credId]: {
          ok: Boolean(data?.ok),
          summary: data?.summary || (data?.ok ? `✅ 连通 (${data.latencyMs}ms)` : `❌ ${data?.error || '测试失败'}`),
        },
      }));
    } finally {
      setTestingCredId('');
    }
  };

  const handleDeleteCredential = async (credId: string) => {
    const res = await apiCall(`/api/voice/credentials/${encodeURIComponent(credId)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && data.config) {
      setConfig(prev => ({ ...prev, ...data.config }));
      toast('🗑️ 密钥已移除');
    }
  };

  const runBenchTurn = async (textOverride?: string, sttMeta?: { latencyMs: number; wavKb: number; provider: string }) => {
    const input = String(textOverride ?? benchText).trim();
    if (!input) return;
    setBenchRunning(true);
    try {
      const snap = summarizeHubState((window as any).__dshLastHubState);
      const turnRes = await apiCall('/api/voice/turn', {
        method: 'POST',
        body: JSON.stringify({
          text: input,
          voiceSessionId: `bench_${voiceSessionIdRef.current}`,
          activeHostId: snap.activeHostId,
          activeSessionId: snap.activeSessionId,
          profileId: config.activeProfile.id,
          dryRun: benchDryRun,
        }),
      });
      const turnData = await turnRes.json().catch(() => ({ ok: false, error: `HTTP ${turnRes.status}` }));

      let ttsData: any = null;
      if (turnData?.ok && turnData.spokenReply) {
        const ttsRes = await apiCall('/api/voice/tts', {
          method: 'POST',
          body: JSON.stringify({
            text: turnData.spokenChunks?.[0] || turnData.spokenReply,
            profileId: config.activeProfile.id,
          }),
        });
        ttsData = await ttsRes.json().catch(() => ({ ok: false }));
      }
      setBenchReport({
        stt: sttMeta || null,
        turn: turnData,
        tts: ttsData,
      });
    } finally {
      setBenchRunning(false);
    }
  };

  const toggleBenchVoiceCapture = async () => {
    if (benchRecording) {
      const rec = recorderRef.current?.stop();
      setBenchRecording(false);
      if (!rec) return;
      const wavKb = Math.max(1, Math.round(rec.byteLength / 1024));
      setBenchRunning(true);
      try {
        const sttRes = await apiCall('/api/voice/stt', {
          method: 'POST',
          body: JSON.stringify({
            audioBase64: rec.wavBase64,
            mimeType: 'audio/wav',
            profileId: config.activeProfile.id,
          }),
        });
        const sttData = await sttRes.json().catch(() => ({ ok: false, error: `HTTP ${sttRes.status}` }));
        if (!sttData?.ok) {
          setBenchReport({ stt: { ok: false, error: sttData?.error || 'STT 失败', wavKb, latencyMs: sttData?.latencyMs || 0 } });
          setBenchRunning(false);
          return;
        }
        setBenchText(sttData.text || '');
        await runBenchTurn(sttData.text || '', {
          latencyMs: sttData.latencyMs || 0,
          wavKb,
          provider: `${sttData.provider}/${sttData.model || ''}`,
        });
      } catch (err: any) {
        setBenchReport({ stt: { ok: false, error: err?.message || '录音失败', wavKb } });
        setBenchRunning(false);
      }
      return;
    }
    if (config.activeProfile.stt?.provider === 'native') {
      toast('当前方案耳朵为手机自带免费；切换到云端听写即可测试 WAV 延迟');
      return;
    }
    try {
      setBenchRecording(true);
      await recorderRef.current!.start({ autoVad: false });
    } catch (err: any) {
      setBenchRecording(false);
      toast(err?.message || '无法打开麦克风');
    }
  };

  const openAdvancedMixView = (presetCombo?: 'volc_ds' | 'volc_all') => {
    const base = buildMixDraftFromConfig(config);
    setMixStatusMsg(null);
    setLabView('advanced');
    if (presetCombo === 'volc_ds') {
      const asrCred = findMixCred('volcengine_asr', config.credentials);
      const ttsCred = findMixCred('volcengine_tts', config.credentials);
      setMix({
        ...base,
        earVendor: 'volcengine_asr',
        earResourceId: asrCred?.resourceId || 'volc.bigasr.auc_turbo',
        brainVendor: 'deepseek',
        brainReuseEarGemini: false,
        brainModel: 'deepseek-chat',
        mouthVendor: 'volcengine_tts',
        mouthReuseKey: true,
        mouthResourceId: ttsCred?.resourceId || 'seed-tts-2.0',
        mouthVoice: ttsCred?.defaultVoice || 'zh_female_vv_uranus_bigtts',
      });
    } else {
      setMix(base);
    }
  };

  const activeProf = config.activeProfile || DEFAULT_CONFIG.activeProfile;
  const activeMissingProviders = getMissingProvidersForProfile(activeProf, config.credentials);
  const simpleMatchedCred = simpleVendor === 'native' ? undefined : findSimpleVendorCred(simpleVendor, config.credentials);
  const earSavedCred = mix.earVendor === 'native' ? undefined : findMixCred(mix.earVendor, config.credentials);
  const brainSavedCred = mix.brainVendor === 'native'
    ? undefined
    : findMixCred(mix.brainVendor, config.credentials, mix.brainBaseUrl);
  const mouthSavedCred = mix.mouthVendor === 'native' ? undefined : findMixCred(mix.mouthVendor, config.credentials);
  const activeComboId = (mix.earVendor === 'volcengine_asr' && mix.mouthVendor === 'volcengine_tts' && mix.brainVendor === 'deepseek')
    ? 'volc_ds'
    : (mix.earVendor === 'volcengine_asr' && mix.mouthVendor === 'volcengine_tts' && mix.brainVendor === 'ark')
      ? 'volc_all'
      : (mix.earVendor === 'gemini' && mix.brainVendor === 'gemini' && mix.mouthVendor === 'gemini')
        ? 'gemini_all'
        : (mix.earVendor === 'native' && mix.mouthVendor === 'native' && mix.brainVendor !== 'native')
          ? 'free_voice_brain'
          : '';
  const orbScale = walkPhase === 'listening' ? 1 + Math.min(0.18, micLevel * 0.22) : 1;

  return (
    <Fragment>
      {/* 1. 全屏 OLED 随行耳机模式 Overlay */}
      {walkOpen && (
        <div id="walkModeOverlay" class="walk-mode-overlay" role="dialog" aria-label="随行耳机模式">
          <div class="walk-top-bar">
            <div class="walk-top-left">
              <button
                type="button"
                class="walk-profile-pill"
                onClick={() => { setLabView('simple'); setSimpleVendor(inferSimpleVendorFromConfig(config)); setSoundCheckMsg(null); setLabOpen(true); }}
                title="点击快速切换语音配置"
              >
                <span>🎧</span>
                <span class="walk-profile-name">{activeProf.name}</span>
                <span>▾</span>
              </button>
              {hubSummary.approvals.length > 0 && (
                <span class="walk-badge-warn">⚠️ {hubSummary.approvals.length} 待审批</span>
              )}
              {wakeLocked && <span class="walk-badge-subtle">🔆 常亮</span>}
            </div>
            <div class="walk-top-right">
              <button
                type="button"
                class="walk-top-btn"
                id="walkOpenLabBtn"
                onClick={() => { setLabView('simple'); setSimpleVendor(inferSimpleVendorFromConfig(config)); setSoundCheckMsg(null); setLabOpen(true); }}
              >
                ⚙️ 配置
              </button>
              <button
                type="button"
                class="walk-top-btn walk-exit-btn"
                id="walkExitBtn"
                onClick={() => setWalkOpen(false)}
              >
                退出 ✕
              </button>
            </div>
          </div>

          {/* 上半屏：大字字幕与轻点静音区 */}
          <div
            class="walk-stage"
            onClick={() => {
              if (walkPhase === 'speaking') {
                playerRef.current?.stop();
                setWalkPhase('idle');
                toast('🔇 已跳过当前播报');
              }
            }}
          >
            <div class={`walk-phase-pill phase-${walkPhase}`}>
              {walkPhase === 'idle' && '🟢 就绪 · 戴耳机随时说'}
              {walkPhase === 'listening' && '🎙️ 正在聆听（说完自动停顿或再点圆球）'}
              {walkPhase === 'transcribing' && '👂 正在高速转写…'}
              {walkPhase === 'thinking' && '🧠 随行总管思考中…'}
              {walkPhase === 'speaking' && '🔊 正在播报（轻点字幕静音 / 点圆球直接插话）'}
            </div>

            {activePin && (
              <div class="walk-pin-card" onClick={e => e.stopPropagation()}>
                <div class="walk-pin-head">
                  <span>🔐 高危操作确认码</span>
                  <span class="walk-pin-timer">{pinSecLeft}s 后过期</span>
                </div>
                <div class="walk-pin-digits">{activePin.pin.split('').join('  ')}</div>
                <div class="walk-pin-desc">
                  {activePin.summary || activePin.code} · 请念出上方 3 位数字放行，或说「拒绝」
                </div>
                <div class="walk-pin-actions">
                  <button type="button" class="walk-chip-danger" onClick={() => void handleClearPin(true)}>
                    🚫 立即拒绝
                  </button>
                  <button type="button" class="walk-chip-btn" onClick={() => void handleClearPin(false)}>
                    ✕ 取消本次弹窗
                  </button>
                </div>
              </div>
            )}

            <div class="walk-subtitle-box">
              {lastUserText && <div class="walk-user-line">你：{lastUserText}</div>}
              <div class="walk-reply-line">{lastReplyText}</div>
              {(lastActionBadge || lastLatencyBadge) && (
                <div class="walk-meta-row">
                  {lastActionBadge && <span class="walk-action-tag">{lastActionBadge}</span>}
                  {lastLatencyBadge && <span class="walk-latency-tag">{lastLatencyBadge}</span>}
                </div>
              )}
            </div>

            <div class="walk-quick-strip" onClick={e => e.stopPropagation()}>
              <button type="button" class="walk-chip-btn" onClick={() => void runBriefingTurn()}>
                ⏭ 汇报最新进度 ({hubSummary.approvals.length} 审批 · {hubSummary.runningCount} 运行中)
              </button>
              <button
                type="button"
                class="walk-chip-btn"
                onClick={() => setWalkTextInputOpen(v => !v)}
              >
                ⌨️ {walkTextInputOpen ? '收起打字' : '静音打字'}
              </button>
            </div>

            {walkTextInputOpen && (
              <div class="walk-text-composer" onClick={e => e.stopPropagation()}>
                <input
                  type="text"
                  class="walk-text-input"
                  placeholder="地铁/会议中不便说话时可直接发口令..."
                  value={walkTextDraft}
                  onInput={(e: any) => setWalkTextDraft(e.target.value)}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter' && walkTextDraft.trim()) {
                      const t = walkTextDraft.trim();
                      setWalkTextDraft('');
                      void handleWalkUserText(t);
                    }
                  }}
                />
                <button
                  type="button"
                  class="walk-text-send"
                  onClick={() => {
                    if (!walkTextDraft.trim()) return;
                    const t = walkTextDraft.trim();
                    setWalkTextDraft('');
                    void handleWalkUserText(t);
                  }}
                >
                  发送
                </button>
              </div>
            )}
          </div>

          {/* 下半屏：超大盲操麦克风圆球 */}
          <div class="walk-orb-dock">
            <button
              type="button"
              id="walkMicOrbBtn"
              class={`walk-mic-orb phase-${walkPhase}`}
              style={`transform: scale(${orbScale.toFixed(3)});`}
              onClick={() => void toggleWalkMic()}
            >
              <span class="walk-orb-icon">
                {walkPhase === 'listening' ? '⏹' : walkPhase === 'speaking' ? '🎙️' : walkPhase === 'thinking' || walkPhase === 'transcribing' ? '⏳' : '🎙️'}
              </span>
              <span class="walk-orb-label">
                {walkPhase === 'listening'
                  ? '说完再点发送'
                  : walkPhase === 'speaking'
                    ? '点此随时插话'
                    : walkPhase === 'transcribing' || walkPhase === 'thinking'
                      ? '处理中…'
                      : '盲点开始说话'}
              </span>
            </button>

            <div class="walk-footer-toggles">
              <button
                type="button"
                class={`walk-mini-toggle ${config.prefs.proactiveBriefing !== 'manual' ? 'on' : ''}`}
                onClick={() => {
                  const order: Array<'approvals' | 'all' | 'manual'> = ['approvals', 'all', 'manual'];
                  const next = order[(order.indexOf(config.prefs.proactiveBriefing) + 1) % order.length];
                  void updatePrefPatch({ proactiveBriefing: next });
                }}
              >
                🔔 播报：{config.prefs.proactiveBriefing === 'approvals' ? '仅审批' : config.prefs.proactiveBriefing === 'all' ? '审批+完成' : '手动'}
              </button>
              <button
                type="button"
                class={`walk-mini-toggle ${config.prefs.autoListenAfterBriefing ? 'on' : ''}`}
                onClick={() => void updatePrefPatch({ autoListenAfterBriefing: !config.prefs.autoListenAfterBriefing })}
              >
                {config.prefs.autoListenAfterBriefing ? '🎙️ 播完自动开麦' : '⚪ 手动点开麦'}
              </button>
              <button
                type="button"
                class={`walk-mini-toggle ${config.prefs.duckMusicMode ? 'on' : ''}`}
                onClick={() => {
                  const nextDuck = !config.prefs.duckMusicMode;
                  setWalkAudioSessionMode(nextDuck ? 'ambient' : 'auto');
                  void updatePrefPatch({ duckMusicMode: nextDuck });
                }}
              >
                {config.prefs.duckMusicMode ? '🎵 听歌压低混音' : '🔇 独占音频'}
              </button>
              <button
                type="button"
                class={`walk-mini-toggle ${config.prefs.autoVad ? 'on' : ''}`}
                onClick={() => void updatePrefPatch({ autoVad: !config.prefs.autoVad })}
              >
                {config.prefs.autoVad ? '🟢 自动停顿发送' : '⚪ 手动点停'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. 语音总管配置半屏抽屉 (#voiceLabSheet, z-index: 140) — 一层极简 + 二层高级混搭 */}
      {labOpen && (
        <div
          id="voiceLabSheet"
          class="sheet-backdrop open voice-lab-backdrop"
          onClick={e => {
            if (e.target === e.currentTarget) setLabOpen(false);
          }}
        >
          <div class="sheet-panel voice-lab-panel">
            <div class="sheet-handle"></div>
            <div class="sheet-title" style="margin-bottom:10px;">
              {labView === 'simple' ? (
                <span>🎙️ 随行语音设置</span>
              ) : (
                <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                  <button
                    type="button"
                    class="voice-back-btn"
                    onClick={() => {
                      setLabView('simple');
                      setSimpleVendor(inferSimpleVendorFromConfig(config));
                    }}
                  >
                    ‹ 极简
                  </button>
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🎛️ 自由混搭（听 · 想 · 说）</span>
                </div>
              )}
              <button
                type="button"
                style="border:none;background:transparent;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 8px;"
                onClick={() => setLabOpen(false)}
              >
                ✕
              </button>
            </div>

            {labView === 'simple' ? (
              <div class="voice-lab-body">
                {loadingCfg && <div class="voice-muted-note">正在读取加密配置…</div>}
                <div class="voice-tab-stack">
                  {/* 顶部：当前状态 + 一键试听 */}
                  <div class="voice-card voice-status-hero">
                    <div class="voice-status-hero-row">
                      <div style="flex:1;min-width:0;">
                        <div class="voice-status-hero-title">
                          {activeProf.id === 'native' ? '🆓 当前：免费本机语音' : `✅ 当前：${activeProf.name}`}
                        </div>
                        <div class="voice-status-hero-sub">
                          {activeProf.id === 'native'
                            ? '免填 Key · 直接用手机自带听写与播报'
                            : `听：${formatStageSummary(activeProf.stt.provider, activeProf.stt.model, 'stt', activeProf.stt.credId, config.credentials)} · 想：${formatStageSummary(activeProf.brain.provider, activeProf.brain.model, 'brain', activeProf.brain.credId, config.credentials)} · 说：${formatStageSummary(activeProf.tts.provider, activeProf.tts.model, 'tts', activeProf.tts.credId, config.credentials)}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="voice-pill-btn primary"
                        disabled={soundChecking}
                        onClick={() => void handleQuickSoundCheck()}
                      >
                        {soundChecking ? '试音中…' : '🔊 试听'}
                      </button>
                    </div>
                    {activeMissingProviders.length > 0 && (
                      <button
                        type="button"
                        class="voice-missing-key-cta"
                        style="margin-top:8px;"
                        onClick={() => openAdvancedMixView()}
                      >
                        <span>⚠️ 缺少 {activeMissingProviders.map(pr => PROVIDER_DISPLAY_NAMES[pr] || pr).join('、')} 密钥</span>
                        <span>去补填 →</span>
                      </button>
                    )}
                    {soundCheckMsg && (
                      <div class={`voice-test-msg ${soundCheckMsg.ok ? 'ok' : 'err'}`} style="margin-top:8px;">
                        {soundCheckMsg.text}
                      </div>
                    )}
                  </div>

                  {/* 核心区：选一家贴 1 把 Key，模型全自动选好 */}
                  <div class="voice-card">
                    <div class="voice-card-title">⚡ 1 把 Key 快速上手（模型全自动）</div>
                    <div class="voice-muted-note" style="margin-bottom:10px;">
                      选一家贴 1 把密钥点保存即可生效；想做<strong>火山豆包 + DeepSeek 混搭</strong>点最后一项。
                    </div>

                    <div class="voice-provider-grid">
                      {SIMPLE_VENDOR_CARDS.map(card => {
                        const isMix = card.id === 'mix_volc_ds';
                        const isSelected = !isMix && simpleVendor === card.id;
                        const hasSaved = card.id !== 'native' && !isMix
                          ? Boolean(findSimpleVendorCred(card.id, config.credentials))
                          : false;
                        return (
                          <button
                            key={card.id}
                            type="button"
                            class={`voice-provider-card ${isSelected ? 'active' : ''} ${isMix ? 'voice-mix-shortcut-card' : ''}`}
                            onClick={() => {
                              if (isMix) {
                                openAdvancedMixView('volc_ds');
                                return;
                              }
                              setSimpleVendor(card.id);
                              setSimpleApiKey('');
                              if (card.id === 'ark') {
                                const arkCred = findSimpleVendorCred('ark', config.credentials);
                                if (arkCred?.defaultModel) setSimpleArkModel(arkCred.defaultModel);
                              }
                            }}
                          >
                            <div class="voice-provider-card-title">
                              <span>{card.icon} {card.title}</span>
                              {hasSaved && <span class="voice-provider-badge">已存</span>}
                            </div>
                            <div class="voice-provider-card-sub">{card.sub}</div>
                          </button>
                        );
                      })}
                    </div>

                    {simpleVendor === 'native' ? (
                      <div class="voice-simple-box">
                        <div class="voice-muted-note" style="margin-top:0;">
                          直接调用 iPhone / 浏览器自带听写与朗读，无需任何 API Key，支持「1号允许」「拒绝」「汇报进度」等常用口令。
                        </div>
                        <button
                          type="button"
                          class="primary-block-btn"
                          disabled={activeProf.id === 'native'}
                          onClick={() => void handleSimpleQuickActivate()}
                        >
                          {activeProf.id === 'native' ? '✅ 当前已在使用免费本机语音' : '🆓 切回免费本机语音'}
                        </button>
                      </div>
                    ) : (
                      <div class="voice-simple-box">
                        {simpleMatchedCred && (
                          <div class="voice-saved-hint">
                            🔐 已保存密钥：{simpleMatchedCred.label} ({simpleMatchedCred.authSummary}) · 留空可直接启用，或粘贴新 Key 覆盖
                          </div>
                        )}

                        <label class="voice-field-label" style="margin-top:2px;">
                          {simpleVendor === 'gemini'
                            ? 'Gemini API Key'
                            : simpleVendor === 'deepseek'
                              ? 'DeepSeek API Key'
                              : simpleVendor === 'ark'
                                ? '火山方舟 Ark API Key'
                                : 'OpenAI API Key'}
                        </label>
                        <input
                          type="password"
                          class="voice-field-input"
                          value={simpleApiKey}
                          placeholder={
                            simpleMatchedCred
                              ? '留空沿用已保存密钥，或粘贴新 Key 替换'
                              : simpleVendor === 'gemini'
                                ? '例：AIzaSy... 或 AQ.Ab...'
                                : simpleVendor === 'deepseek'
                                  ? '例：sk-...'
                                  : simpleVendor === 'ark'
                                    ? '粘贴火山方舟控制台 API Key（例：8f3a...）'
                                    : '例：sk-proj-...'
                          }
                          onInput={(e: any) => setSimpleApiKey(e.target.value)}
                        />

                        {simpleVendor === 'ark' && (
                          <Fragment>
                            <label class="voice-field-label">模型名或接入点 ID（已填好，可点选或填 ep-xxxx）</label>
                            <input
                              class="voice-field-input"
                              value={simpleArkModel}
                              placeholder="例：doubao-seed-2-0-lite-260215 或 ep-2025xxxx"
                              onInput={(e: any) => setSimpleArkModel(e.target.value)}
                            />
                            <div class="voice-chip-row" style="margin-top:5px;">
                              {ARK_MODEL_CHIPS.map(chip => (
                                <button
                                  key={chip.value}
                                  type="button"
                                  class={`voice-quick-chip ${simpleArkModel === chip.value ? 'active' : ''}`}
                                  onClick={() => setSimpleArkModel(chip.value)}
                                >
                                  {chip.label}
                                </button>
                              ))}
                            </div>
                          </Fragment>
                        )}

                        <div class="voice-auto-plan-note">
                          {simpleVendor === 'gemini' && '自动配置：听写 + 大脑 gemini-2.5-flash · 播报 Kore 自然女声'}
                          {simpleVendor === 'deepseek' && '自动配置：大脑 deepseek-chat · 听写与播报自动用手机免费语音'}
                          {simpleVendor === 'ark' && `自动配置：大脑火山方舟 (${simpleArkModel.trim() || 'doubao-seed-2-0-lite-260215'}) · 听写与播报自动用手机免费语音`}
                          {simpleVendor === 'openai' && '自动配置：听写 + 大脑 gpt-4o-mini · 播报 alloy 自然人声'}
                        </div>

                        <button
                          type="button"
                          class="primary-block-btn"
                          disabled={simpleSaving}
                          onClick={() => void handleSimpleQuickActivate()}
                        >
                          {simpleSaving
                            ? '正在自动配置…'
                            : simpleApiKey.trim()
                              ? '⚡ 保存并立即启用'
                              : simpleMatchedCred
                                ? '⚡ 直接启用已有密钥'
                                : '⚡ 保存并立即启用'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* 只留 2 个日常必用开关 */}
                  <div class="voice-card">
                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">🛡️ 高危操作二次确认</div>
                        <div class="voice-row-sub">删文件 / 强推 / 部署等危险指令时的保护方式</div>
                      </div>
                      <select
                        class="voice-mini-select"
                        value={config.prefs.l2Policy}
                        onChange={(e: any) => void updatePrefPatch({ l2Policy: e.target.value })}
                      >
                        <option value="pin">🔢 念 3 位确认码</option>
                        <option value="screen_only">📱 仅点手机屏幕</option>
                      </select>
                    </div>

                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">🎙️ 播报完自动开麦听我回答</div>
                        <div class="voice-row-sub">念完选项后自动听 5.5 秒；边听歌时自动压低背景音乐</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={config.prefs.autoListenAfterBriefing}
                        onChange={(e: any) => void updatePrefPatch({ autoListenAfterBriefing: e.target.checked })}
                      />
                    </div>
                  </div>

                  {/* 清晰进入二级自由混搭（方案 1+2 合体） */}
                  <button
                    type="button"
                    class="voice-adv-entry-btn"
                    onClick={() => openAdvancedMixView()}
                  >
                    <div style="min-width:0;">
                      <div class="voice-adv-entry-title">🎛️ 高级自由混搭（听 · 想 · 说）</div>
                      <div class="voice-adv-entry-sub">
                        选套餐或直接就地填 Key：火山豆包听/说 + DeepSeek / 方舟大脑、选声音
                      </div>
                    </div>
                    <span class="voice-adv-entry-go">进入 ›</span>
                  </button>
                </div>
              </div>
            ) : (
              <div class="voice-lab-body">
                {loadingCfg && <div class="voice-muted-note">正在读取加密配置…</div>}
                <div class="voice-tab-stack">
                  {/* A. 顶部快捷套餐（点一下自动排好下面 3 张积木卡） */}
                  <div class="voice-card" style="padding:10px 11px;">
                    <div class="voice-card-title" style="margin-bottom:7px;">⚡ 选一套组合（自动填好下面 3 张卡）</div>
                    <div class="voice-provider-grid" style="margin-bottom:0;">
                      {MIX_COMBO_CARDS.map(combo => (
                        <button
                          key={combo.id}
                          type="button"
                          class={`voice-provider-card ${activeComboId === combo.id ? 'active' : ''}`}
                          onClick={() => applyMixCombo(combo.id)}
                        >
                          <div class="voice-provider-card-title">
                            <span>{combo.icon} {combo.title}</span>
                          </div>
                          <div class="voice-provider-card-sub">{combo.sub}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* B1. 积木卡 1：听我说话（耳朵） */}
                  <div class="voice-card voice-brick-card">
                    <div class="voice-brick-head">
                      <span class="voice-brick-title">👂 1. 听我说话</span>
                      <select
                        class="voice-brick-select"
                        value={mix.earVendor}
                        onChange={(e: any) => {
                          const v = e.target.value as MixEarVendor;
                          setMix(prev => ({
                            ...prev,
                            earVendor: v,
                            earApiKey: '',
                            mouthReuseKey: (prev.mouthVendor === 'volcengine_tts' && v === 'volcengine_asr')
                              || (prev.mouthVendor === 'gemini' && (v === 'gemini' || prev.brainVendor === 'gemini'))
                              || (prev.mouthVendor === 'openai' && (v === 'openai' || prev.brainVendor === 'openai')),
                          }));
                        }}
                      >
                        <option value="native">手机自带免费</option>
                        <option value="volcengine_asr">火山豆包语音</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="openai">OpenAI Whisper</option>
                      </select>
                    </div>

                    {mix.earVendor === 'native' ? (
                      <div class="voice-brick-note">免费 · 直接用手机自带听写，无需填 Key</div>
                    ) : (
                      <div class="voice-brick-body">
                        {earSavedCred && (
                          <div class="voice-brick-saved-row">
                            <span class="voice-brick-saved-pill">✅ 已存 ({earSavedCred.authSummary})</span>
                            <button
                              type="button"
                              class="voice-pill-btn"
                              disabled={testingCredId === earSavedCred.id}
                              onClick={() => void handleTestCredential(earSavedCred.id)}
                            >
                              {testingCredId === earSavedCred.id ? '测速中…' : '🔌 测一下'}
                            </button>
                          </div>
                        )}
                        {earSavedCred && testResults[earSavedCred.id] && (
                          <div class={`voice-test-msg ${testResults[earSavedCred.id].ok ? 'ok' : 'err'}`}>
                            {testResults[earSavedCred.id].summary}
                          </div>
                        )}

                        {mix.earVendor === 'volcengine_asr' && mix.earVolcMode === 'appToken' ? (
                          <div class="voice-two-col" style="margin-top:6px;">
                            <input
                              class="voice-field-input"
                              value={mix.earAppId}
                              placeholder="火山 AppID"
                              onInput={(e: any) => setMix({ ...mix, earAppId: e.target.value })}
                            />
                            <input
                              type="password"
                              class="voice-field-input"
                              value={mix.earAccessToken}
                              placeholder="Access Token"
                              onInput={(e: any) => setMix({ ...mix, earAccessToken: e.target.value })}
                            />
                          </div>
                        ) : (
                          <input
                            type="password"
                            class="voice-field-input"
                            style="margin-top:6px;"
                            value={mix.earApiKey}
                            placeholder={
                              earSavedCred
                                ? '已存 Key 可留空，或粘贴新 Key 替换'
                                : mix.earVendor === 'volcengine_asr'
                                  ? '粘贴火山「语音技术」API Key'
                                  : mix.earVendor === 'gemini'
                                    ? '粘贴 Gemini Key（例：AIzaSy...）'
                                    : '粘贴 OpenAI Key（例：sk-...）'
                            }
                            onInput={(e: any) => setMix({ ...mix, earApiKey: e.target.value })}
                          />
                        )}

                        {mix.earVendor === 'volcengine_asr' && (
                          <details class="voice-tiny-details">
                            <summary>用旧版 AppID+Token 或改资源 ID</summary>
                            <div class="voice-adv-body">
                              <div class="voice-subseg" style="margin-top:0;">
                                <button
                                  type="button"
                                  class={`voice-subseg-btn ${mix.earVolcMode === 'apiKey' ? 'active' : ''}`}
                                  onClick={() => setMix({ ...mix, earVolcMode: 'apiKey' })}
                                >
                                  单把 API Key
                                </button>
                                <button
                                  type="button"
                                  class={`voice-subseg-btn ${mix.earVolcMode === 'appToken' ? 'active' : ''}`}
                                  onClick={() => setMix({ ...mix, earVolcMode: 'appToken' })}
                                >
                                  AppID + Token
                                </button>
                              </div>
                              <label class="voice-field-label">Resource ID（默认 volc.bigasr.auc_turbo）</label>
                              <input
                                class="voice-field-input"
                                value={mix.earResourceId}
                                placeholder="volc.bigasr.auc_turbo"
                                onInput={(e: any) => setMix({ ...mix, earResourceId: e.target.value })}
                              />
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </div>

                  {/* B2. 积木卡 2：帮我思考（大脑） */}
                  <div class="voice-card voice-brick-card">
                    <div class="voice-brick-head">
                      <span class="voice-brick-title">🧠 2. 帮我思考</span>
                      <select
                        class="voice-brick-select"
                        value={mix.brainVendor}
                        onChange={(e: any) => {
                          const v = e.target.value as MixBrainVendor;
                          const defModel = v === 'deepseek'
                            ? 'deepseek-chat'
                            : v === 'ark'
                              ? (findMixCred('ark', config.credentials)?.defaultModel || 'doubao-seed-2-0-lite-260215')
                              : v === 'gemini'
                                ? 'gemini-2.5-flash'
                                : v === 'openai'
                                  ? 'gpt-4o-mini'
                                  : v === 'custom'
                                    ? 'deepseek-chat'
                                    : 'rule-router';
                          setMix(prev => ({
                            ...prev,
                            brainVendor: v,
                            brainApiKey: '',
                            brainReuseEarGemini: v === 'gemini' && prev.earVendor === 'gemini',
                            brainModel: defModel,
                          }));
                        }}
                      >
                        <option value="deepseek">DeepSeek 官方</option>
                        <option value="ark">火山方舟 Ark (豆包/DS)</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="openai">OpenAI 官方</option>
                        <option value="custom">自定义中转站</option>
                        <option value="native">本地免费口令</option>
                      </select>
                    </div>

                    {mix.brainVendor === 'native' ? (
                      <div class="voice-brick-note">免 Key · 仅支持简单固定口令（「1号允许」「拒绝」「汇报进度」）</div>
                    ) : (
                      <div class="voice-brick-body">
                        {mix.brainVendor === 'gemini' && mix.earVendor === 'gemini' ? (
                          <label class="voice-dual-check" style="margin:6px 0;">
                            <input
                              type="checkbox"
                              checked={mix.brainReuseEarGemini}
                              onChange={(e: any) => setMix({ ...mix, brainReuseEarGemini: Boolean(e.target.checked) })}
                            />
                            <span><strong>自动复用上面「耳朵」的 Gemini Key</strong>（免贴两遍）</span>
                          </label>
                        ) : null}

                        {!(mix.brainVendor === 'gemini' && mix.earVendor === 'gemini' && mix.brainReuseEarGemini) && (
                          <Fragment>
                            {brainSavedCred && (
                              <div class="voice-brick-saved-row">
                                <span class="voice-brick-saved-pill">✅ 已存 ({brainSavedCred.authSummary})</span>
                                <button
                                  type="button"
                                  class="voice-pill-btn"
                                  disabled={testingCredId === brainSavedCred.id}
                                  onClick={() => void handleTestCredential(brainSavedCred.id)}
                                >
                                  {testingCredId === brainSavedCred.id ? '测速中…' : '🔌 测一下'}
                                </button>
                              </div>
                            )}
                            {brainSavedCred && testResults[brainSavedCred.id] && (
                              <div class={`voice-test-msg ${testResults[brainSavedCred.id].ok ? 'ok' : 'err'}`}>
                                {testResults[brainSavedCred.id].summary}
                              </div>
                            )}

                            {mix.brainVendor === 'custom' && (
                              <input
                                class="voice-field-input"
                                style="margin-top:6px;"
                                value={mix.brainBaseUrl}
                                placeholder="接口地址，例：https://api.example.com/v1"
                                onInput={(e: any) => setMix({ ...mix, brainBaseUrl: e.target.value })}
                              />
                            )}

                            <input
                              type="password"
                              class="voice-field-input"
                              style="margin-top:6px;"
                              value={mix.brainApiKey}
                              placeholder={
                                brainSavedCred
                                  ? '已存 Key 可留空，或粘贴新 Key 替换'
                                  : mix.brainVendor === 'deepseek'
                                    ? '粘贴 DeepSeek API Key（例：sk-...）'
                                    : mix.brainVendor === 'ark'
                                      ? '粘贴火山方舟 Ark API Key'
                                      : mix.brainVendor === 'gemini'
                                        ? '粘贴 Gemini Key（例：AIzaSy...）'
                                        : '粘贴 API Key（例：sk-...）'
                              }
                              onInput={(e: any) => setMix({ ...mix, brainApiKey: e.target.value })}
                            />
                          </Fragment>
                        )}

                        <div style="margin-top:7px;">
                          <input
                            class="voice-field-input"
                            value={mix.brainModel}
                            placeholder={
                              mix.brainVendor === 'ark'
                                ? '模型名或接入点 ID（例：doubao-seed-2-0-lite-260215 或 ep-xxxx）'
                                : '模型名（已填好，可点下方切换）'
                            }
                            onInput={(e: any) => setMix({ ...mix, brainModel: e.target.value })}
                          />
                          {(() => {
                            const chips = mix.brainVendor === 'deepseek'
                              ? DEEPSEEK_MODEL_CHIPS
                              : mix.brainVendor === 'ark'
                                ? ARK_MODEL_CHIPS
                                : mix.brainVendor === 'gemini'
                                  ? BRAIN_MODEL_CHIPS.gemini
                                  : mix.brainVendor === 'openai'
                                    ? OPENAI_MODEL_CHIPS
                                    : [];
                            if (!chips.length) return null;
                            return (
                              <div class="voice-chip-row" style="margin-top:5px;">
                                {chips.map(chip => (
                                  <button
                                    key={chip.value}
                                    type="button"
                                    class={`voice-quick-chip ${mix.brainModel === chip.value ? 'active' : ''}`}
                                    onClick={() => setMix({ ...mix, brainModel: chip.value })}
                                  >
                                    {chip.label}
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* B3. 积木卡 3：念给我听（嘴巴） */}
                  <div class="voice-card voice-brick-card">
                    <div class="voice-brick-head">
                      <span class="voice-brick-title">🗣️ 3. 念给我听</span>
                      <select
                        class="voice-brick-select"
                        value={mix.mouthVendor}
                        onChange={(e: any) => {
                          const v = e.target.value as MixMouthVendor;
                          const defVoice = v === 'volcengine_tts'
                            ? 'zh_female_vv_uranus_bigtts'
                            : v === 'gemini'
                              ? 'Kore'
                              : v === 'openai'
                                ? 'alloy'
                                : 'system-default';
                          setMix(prev => ({
                            ...prev,
                            mouthVendor: v,
                            mouthApiKey: '',
                            mouthVoice: defVoice,
                            mouthReuseKey: (v === 'volcengine_tts' && prev.earVendor === 'volcengine_asr')
                              || (v === 'gemini' && (prev.earVendor === 'gemini' || prev.brainVendor === 'gemini'))
                              || (v === 'openai' && (prev.earVendor === 'openai' || prev.brainVendor === 'openai')),
                          }));
                        }}
                      >
                        <option value="native">手机自带免费</option>
                        <option value="volcengine_tts">火山豆包人声</option>
                        <option value="gemini">Google Gemini</option>
                        <option value="openai">OpenAI 语音</option>
                      </select>
                    </div>

                    {mix.mouthVendor === 'native' ? (
                      <div class="voice-brick-note">免费零延迟 · 直接用手机自带朗读</div>
                    ) : (
                      <div class="voice-brick-body">
                        {(() => {
                          const canReuseEarVolc = mix.mouthVendor === 'volcengine_tts' && mix.earVendor === 'volcengine_asr';
                          const canReuseGemini = mix.mouthVendor === 'gemini' && (mix.earVendor === 'gemini' || mix.brainVendor === 'gemini');
                          const canReuseOpenAi = mix.mouthVendor === 'openai' && (mix.earVendor === 'openai' || mix.brainVendor === 'openai');
                          const canReuse = canReuseEarVolc || canReuseGemini || canReuseOpenAi;
                          const reuseLabel = canReuseEarVolc
                            ? '自动复用上面「耳朵」的火山语音 Key（免贴两遍）'
                            : canReuseGemini
                              ? '自动复用上面的 Gemini Key（免贴两遍）'
                              : '自动复用上面的 OpenAI Key（免贴两遍）';

                          return (
                            <Fragment>
                              {canReuse && (
                                <label class="voice-dual-check" style="margin:6px 0;">
                                  <input
                                    type="checkbox"
                                    checked={mix.mouthReuseKey}
                                    onChange={(e: any) => setMix({ ...mix, mouthReuseKey: Boolean(e.target.checked) })}
                                  />
                                  <span><strong>{reuseLabel}</strong></span>
                                </label>
                              )}

                              {!(canReuse && mix.mouthReuseKey) && (
                                <Fragment>
                                  {mouthSavedCred && (
                                    <div class="voice-brick-saved-row">
                                      <span class="voice-brick-saved-pill">✅ 已存 ({mouthSavedCred.authSummary})</span>
                                      <button
                                        type="button"
                                        class="voice-pill-btn"
                                        disabled={testingCredId === mouthSavedCred.id}
                                        onClick={() => void handleTestCredential(mouthSavedCred.id)}
                                      >
                                        {testingCredId === mouthSavedCred.id ? '测速中…' : '🔌 测一下'}
                                      </button>
                                    </div>
                                  )}
                                  {mouthSavedCred && testResults[mouthSavedCred.id] && (
                                    <div class={`voice-test-msg ${testResults[mouthSavedCred.id].ok ? 'ok' : 'err'}`}>
                                      {testResults[mouthSavedCred.id].summary}
                                    </div>
                                  )}

                                  {mix.mouthVendor === 'volcengine_tts' && mix.mouthVolcMode === 'appToken' ? (
                                    <div class="voice-two-col" style="margin-top:6px;">
                                      <input
                                        class="voice-field-input"
                                        value={mix.mouthAppId}
                                        placeholder="火山 AppID"
                                        onInput={(e: any) => setMix({ ...mix, mouthAppId: e.target.value })}
                                      />
                                      <input
                                        type="password"
                                        class="voice-field-input"
                                        value={mix.mouthAccessToken}
                                        placeholder="Access Token"
                                        onInput={(e: any) => setMix({ ...mix, mouthAccessToken: e.target.value })}
                                      />
                                    </div>
                                  ) : (
                                    <input
                                      type="password"
                                      class="voice-field-input"
                                      style="margin-top:6px;"
                                      value={mix.mouthApiKey}
                                      placeholder={
                                        mouthSavedCred
                                          ? '已存 Key 可留空，或粘贴新 Key 替换'
                                          : mix.mouthVendor === 'volcengine_tts'
                                            ? '粘贴火山「语音技术」API Key'
                                            : mix.mouthVendor === 'gemini'
                                              ? '粘贴 Gemini Key（例：AIzaSy...）'
                                              : '粘贴 OpenAI Key（例：sk-...）'
                                      }
                                      onInput={(e: any) => setMix({ ...mix, mouthApiKey: e.target.value })}
                                    />
                                  )}
                                </Fragment>
                              )}

                              {(() => {
                                const voiceKey = mix.mouthVendor === 'openai' ? 'openai_compat' : mix.mouthVendor;
                                const voiceList = TTS_VOICE_CHIPS[voiceKey] || [];
                                if (!voiceList.length) return null;
                                return (
                                  <div style="margin-top:6px;">
                                    <div class="voice-brick-sub-label">挑个声音</div>
                                    <div class="voice-chip-row" style="margin-top:4px;">
                                      {voiceList.map(v => (
                                        <button
                                          key={v.value}
                                          type="button"
                                          class={`voice-quick-chip ${mix.mouthVoice === v.value ? 'active' : ''}`}
                                          onClick={() => setMix({ ...mix, mouthVoice: v.value })}
                                        >
                                          {v.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}

                              {mix.mouthVendor === 'volcengine_tts' && (
                                <details class="voice-tiny-details">
                                  <summary>自定义音色代码 / Resource ID (seed-tts-2.0)</summary>
                                  <div class="voice-adv-body">
                                    {!(canReuse && mix.mouthReuseKey) && (
                                      <div class="voice-subseg" style="margin-top:0;">
                                        <button
                                          type="button"
                                          class={`voice-subseg-btn ${mix.mouthVolcMode === 'apiKey' ? 'active' : ''}`}
                                          onClick={() => setMix({ ...mix, mouthVolcMode: 'apiKey' })}
                                        >
                                          单把 API Key
                                        </button>
                                        <button
                                          type="button"
                                          class={`voice-subseg-btn ${mix.mouthVolcMode === 'appToken' ? 'active' : ''}`}
                                          onClick={() => setMix({ ...mix, mouthVolcMode: 'appToken' })}
                                        >
                                          AppID + Token
                                        </button>
                                      </div>
                                    )}
                                    <label class="voice-field-label">音色代码</label>
                                    <input
                                      class="voice-field-input"
                                      value={mix.mouthVoice}
                                      placeholder="zh_female_vv_uranus_bigtts"
                                      onInput={(e: any) => setMix({ ...mix, mouthVoice: e.target.value })}
                                    />
                                    <label class="voice-field-label">Resource ID</label>
                                    <input
                                      class="voice-field-input"
                                      value={mix.mouthResourceId}
                                      placeholder="seed-tts-2.0"
                                      onInput={(e: any) => setMix({ ...mix, mouthResourceId: e.target.value })}
                                    />
                                  </div>
                                </details>
                              )}
                            </Fragment>
                          );
                        })()}
                      </div>
                    )}
                  </div>

                  {/* C. 状态提示 + 保存并生效 + 一键试听 */}
                  {(mixStatusMsg || soundCheckMsg) && (
                    <div class={`voice-test-msg ${(mixStatusMsg || soundCheckMsg)!.ok ? 'ok' : 'err'}`} style="margin-top:0;padding:8px 10px;">
                      {(mixStatusMsg || soundCheckMsg)!.text}
                    </div>
                  )}

                  <div style="display:flex;gap:8px;align-items:center;">
                    <button
                      type="button"
                      class="primary-block-btn"
                      style="margin-top:0;flex:1;"
                      disabled={mixSaving}
                      onClick={() => void handleSaveMixDraft()}
                    >
                      {mixSaving ? '正在加密保存并生效…' : '💾 保存并立即生效'}
                    </button>
                    <button
                      type="button"
                      class="voice-pill-btn"
                      style="padding:11px 14px;font-size:12.5px;"
                      disabled={soundChecking}
                      onClick={() => void handleQuickSoundCheck()}
                    >
                      {soundChecking ? '试音中…' : '🔊 试听'}
                    </button>
                  </div>

                  {/* D. 最底部低干扰极客排障（聊天页开关 / 密钥清理 / 毫秒压测） */}
                  <details
                    class="voice-adv-details"
                    open={geekOpen}
                    onToggle={(e: any) => setGeekOpen(Boolean(e.currentTarget?.open))}
                  >
                    <summary>🔧 极客排障（聊天页开关 / 密钥清理 / 延迟压测）</summary>
                    <div class="voice-adv-body" style="display:flex;flex-direction:column;gap:10px;">
                      <div>
                        <div class="voice-toggle-row">
                          <div>
                            <div class="voice-row-main">🎵 边听歌边播报（Safari 压低混音）</div>
                            <div class="voice-row-sub">播报时自动压低背景音乐，说完恢复</div>
                          </div>
                          <input
                            type="checkbox"
                            class="voice-switch"
                            checked={config.prefs.duckMusicMode}
                            onChange={(e: any) => void updatePrefPatch({ duckMusicMode: e.target.checked })}
                          />
                        </div>
                        <div class="voice-toggle-row">
                          <div>
                            <div class="voice-row-main">聊天页「🔊 播报」复用云端声音</div>
                            <div class="voice-row-sub">默认用免费系统语音；开启后用上面选好的嘴巴播报</div>
                          </div>
                          <input
                            type="checkbox"
                            class="voice-switch"
                            checked={config.prefs.useByokForChatTts}
                            onChange={(e: any) => void updatePrefPatch({ useByokForChatTts: e.target.checked })}
                          />
                        </div>
                        <div class="voice-toggle-row">
                          <div>
                            <div class="voice-row-main">聊天页语音输入复用云端听写</div>
                            <div class="voice-row-sub">默认用免费系统听写；开启后用上面选好的耳朵转写</div>
                          </div>
                          <input
                            type="checkbox"
                            class="voice-switch"
                            checked={config.prefs.useByokForChatStt}
                            onChange={(e: any) => void updatePrefPatch({ useByokForChatStt: e.target.checked })}
                          />
                        </div>
                      </div>

                      {config.credentials.length > 0 && (
                        <div style="border-top:1px solid var(--border);padding-top:8px;">
                          <div class="voice-field-label" style="margin-top:0;">已加密保存的密钥 ({config.credentials.length})</div>
                          {config.credentials.map(c => (
                            <div key={c.id} class="voice-cred-item">
                              <div style="flex:1;min-width:0;">
                                <div class="voice-cred-title">
                                  <span class="voice-prov-tag">{PROVIDER_DISPLAY_NAMES[c.provider] || c.provider}</span>
                                  <span>{c.label}</span>
                                </div>
                                <div class="voice-cred-sub">{c.authSummary}</div>
                              </div>
                              <button type="button" class="voice-pill-btn danger" onClick={() => void handleDeleteCredential(c.id)}>
                                删
                              </button>
                            </div>
                          ))}
                        </div>
                      )}

                      <div style="border-top:1px solid var(--border);padding-top:8px;">
                        <div class="voice-toggle-row" style="padding-top:0;">
                          <div>
                            <div class="voice-row-main">🧪 安全试跑压测 (Dry-Run)</div>
                            <div class="voice-row-sub">排查哪一步慢或报错，绝不会真的遥控电脑</div>
                          </div>
                          <input
                            type="checkbox"
                            class="voice-switch"
                            checked={benchDryRun}
                            onChange={(e: any) => setBenchDryRun(e.target.checked)}
                          />
                        </div>
                        <input
                          class="voice-field-input"
                          value={benchText}
                          onInput={(e: any) => setBenchText(e.target.value)}
                          placeholder="输入一句测试口令..."
                        />
                        <div style="display:flex;gap:8px;margin-top:6px;">
                          <button
                            type="button"
                            class="voice-pill-btn primary"
                            style="flex:1;padding:8px 10px;"
                            disabled={benchRunning}
                            onClick={() => void runBenchTurn()}
                          >
                            {benchRunning ? '⏳ 测速中…' : '🚀 跑一轮延迟压测'}
                          </button>
                          <button
                            type="button"
                            class={`voice-pill-btn ${benchRecording ? 'danger' : ''}`}
                            style="padding:8px 10px;"
                            disabled={benchRunning}
                            onClick={() => void toggleBenchVoiceCapture()}
                          >
                            {benchRecording ? '⏹ 停止' : '🎙️ 录真声'}
                          </button>
                        </div>
                        {benchReport && (
                          <div style="margin-top:8px;">
                            <div class="voice-metrics-grid">
                              {benchReport.stt && (
                                <div class="voice-metric-box">
                                  <div class="voice-metric-k">听写</div>
                                  <div class="voice-metric-v">{benchReport.stt.latencyMs ?? 0}ms</div>
                                </div>
                              )}
                              {benchReport.turn && (
                                <div class="voice-metric-box">
                                  <div class="voice-metric-k">大脑</div>
                                  <div class="voice-metric-v">{benchReport.turn.latencyMs ?? 0}ms</div>
                                </div>
                              )}
                              {benchReport.tts && (
                                <div class="voice-metric-box">
                                  <div class="voice-metric-k">播报</div>
                                  <div class="voice-metric-v">{benchReport.tts.latencyMs ?? 0}ms</div>
                                </div>
                              )}
                            </div>
                            {(benchReport.stt?.error || benchReport.turn?.error || benchReport.tts?.error) && (
                              <div class="voice-test-msg err" style="margin-top:6px;">
                                {benchReport.stt?.error || benchReport.turn?.error || benchReport.tts?.error}
                              </div>
                            )}
                            {benchReport.turn?.spokenReply && (
                              <div class="voice-bench-reply" style="margin-top:6px;">
                                {benchReport.turn.spokenReply}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </details>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Fragment>
  );
}
