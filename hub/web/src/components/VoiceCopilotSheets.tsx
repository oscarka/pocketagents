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

export function VoiceCopilotSheets() {
  const [walkOpen, setWalkOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [labView, setLabView] = useState<'simple' | 'advanced'>('simple');
  const [labTab, setLabTab] = useState<'keys' | 'profiles' | 'bench'>('keys');
  const [advGuideOpen, setAdvGuideOpen] = useState(false);
  const [config, setConfig] = useState<VoiceConfigState>(DEFAULT_CONFIG);
  const [loadingCfg, setLoadingCfg] = useState(false);

  // Level 1 (Simple 1-screen config) state
  const [simpleVendor, setSimpleVendor] = useState<'native' | 'gemini' | 'deepseek' | 'ark' | 'openai'>('gemini');
  const [simpleApiKey, setSimpleApiKey] = useState('');
  const [simpleArkModel, setSimpleArkModel] = useState('doubao-seed-2-0-lite-260215');
  const [simpleSaving, setSimpleSaving] = useState(false);
  const [soundChecking, setSoundChecking] = useState(false);
  const [soundCheckMsg, setSoundCheckMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  // Profile editor state
  const [editingProfile, setEditingProfile] = useState<VoiceProfile | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [applyingPresetKey, setApplyingPresetKey] = useState('');

  // Add key form state (Level 2)
  const [keyProvider, setKeyProvider] = useState('volcengine_asr');
  const [volcAuthMode, setVolcAuthMode] = useState<'apiKey' | 'appToken'>('apiKey');
  const [volcSaveBoth, setVolcSaveBoth] = useState(true);
  const [keyLabel, setKeyLabel] = useState('');
  const [keyBaseUrl, setKeyBaseUrl] = useState('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash');
  const [keyApiKey, setKeyApiKey] = useState('');
  const [keyAppId, setKeyAppId] = useState('');
  const [keyAccessToken, setKeyAccessToken] = useState('');
  const [keyResourceId, setKeyResourceId] = useState('volc.bigasr.auc_turbo');
  const [keyDefaultModel, setKeyDefaultModel] = useState('');
  const [keyDefaultVoice, setKeyDefaultVoice] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [testingCredId, setTestingCredId] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; summary: string }>>({});

  // Bench / Dry-Run Lab state
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
        setLabTab(tab);
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

  const handleSaveCredential = async () => {
    const isVolc = keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts';
    const effectiveApiKey = isVolc && volcAuthMode === 'appToken' ? '' : keyApiKey.trim();
    const effectiveAppId = isVolc && volcAuthMode === 'appToken' ? keyAppId.trim() : '';
    const effectiveAccessToken = isVolc && volcAuthMode === 'appToken' ? keyAccessToken.trim() : '';
    if (!effectiveApiKey && !(effectiveAppId && effectiveAccessToken)) {
      toast(isVolc && volcAuthMode === 'appToken' ? '⚠️ 请同时填写 AppID 和 Access Token' : '⚠️ 请先粘贴 API Key');
      return;
    }
    setSavingKey(true);
    try {
      const autoLabel = keyLabel.trim() || inferDefaultCredLabel(keyProvider, keyBaseUrl);
      const res = await apiCall('/api/voice/credentials', {
        method: 'POST',
        body: JSON.stringify({
          provider: keyProvider,
          label: autoLabel,
          baseUrl: keyBaseUrl,
          apiKey: effectiveApiKey,
          appId: effectiveAppId,
          accessToken: effectiveAccessToken,
          resourceId: keyResourceId,
          defaultModel: keyDefaultModel,
          defaultVoice: keyDefaultVoice,
          active: true,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast(`❌ ${data?.error || '保存密钥失败'}`);
        return;
      }
      let nextCfg = data.config;

      // Optional 1-click dual-save for Volcengine Speech key (saves both ASR & TTS so user doesn't paste twice)
      let savedBothOk = false;
      if (isVolc && volcSaveBoth) {
        const siblingProv = keyProvider === 'volcengine_asr' ? 'volcengine_tts' : 'volcengine_asr';
        const siblingUrl = siblingProv === 'volcengine_tts'
          ? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
          : 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
        const siblingResId = siblingProv === 'volcengine_tts' ? 'seed-tts-2.0' : 'volc.bigasr.auc_turbo';
        const siblingLabel = keyLabel.trim()
          ? `${keyLabel.trim()} (${siblingProv === 'volcengine_tts' ? 'TTS' : 'ASR'})`
          : inferDefaultCredLabel(siblingProv, siblingUrl);
        const sibRes = await apiCall('/api/voice/credentials', {
          method: 'POST',
          body: JSON.stringify({
            provider: siblingProv,
            label: siblingLabel,
            baseUrl: siblingUrl,
            apiKey: effectiveApiKey,
            appId: effectiveAppId,
            accessToken: effectiveAccessToken,
            resourceId: siblingResId,
            defaultModel: '',
            defaultVoice: siblingProv === 'volcengine_tts' ? (keyDefaultVoice || 'zh_female_vv_uranus_bigtts') : '',
            active: true,
          }),
        });
        const sibData = await sibRes.json().catch(() => null);
        if (sibRes.ok && sibData?.ok && sibData.config) {
          nextCfg = sibData.config;
          savedBothOk = true;
        }
      }

      setConfig(prev => ({ ...prev, ...nextCfg }));
      setKeyLabel('');
      setKeyApiKey('');
      setKeyAppId('');
      setKeyAccessToken('');
      try {
        const bodyEl = document.querySelector('#voiceLabSheet .voice-lab-body');
        if (bodyEl) bodyEl.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {}
      toast(
        savedBothOk
          ? '🔐 已一键同时存入火山听写 (ASR) 与播报 (TTS)！点上方「一键启用」即可混搭'
          : '🔐 密钥已加密保存！点上方「⚡ 一键启用」即可使用',
      );
    } finally {
      setSavingKey(false);
    }
  };

  const handleApplyQuickPreset = async (preset: QuickPresetItem) => {
    setApplyingPresetKey(preset.key);
    try {
      const existing = config.profiles.find(p => !p.builtin && p.name === preset.profile.name);
      const payload = {
        ...preset.profile,
        id: existing ? existing.id : '',
        activate: true,
      };
      const res = await apiCall('/api/voice/profiles', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast(`❌ ${data?.error || '启用方案失败'}`);
        return;
      }
      setConfig(prev => ({ ...prev, ...data.config }));
      setEditingProfile(null);
      setLabTab('bench');
      toast(`✅ 已启用「${preset.title}」，点下方按钮即可试跑测速`);
    } finally {
      setApplyingPresetKey('');
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

  const handleActivateCredential = async (credId: string) => {
    const res = await apiCall('/api/voice/credentials/activate', {
      method: 'POST',
      body: JSON.stringify({ id: credId }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && data.config) {
      setConfig(prev => ({ ...prev, ...data.config }));
      toast('✅ 已切换该服务商的默认密钥');
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

  const handleSaveProfile = async () => {
    if (!editingProfile) return;
    setSavingProfile(true);
    try {
      const res = await apiCall('/api/voice/profiles', {
        method: 'POST',
        body: JSON.stringify({ ...editingProfile, activate: true }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        toast(`❌ ${data?.error || '保存方案失败'}`);
        return;
      }
      setConfig(prev => ({ ...prev, ...data.config }));
      setEditingProfile(null);
      toast('✅ 方案已保存并设为当前生效');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleDeleteProfile = async (profileId: string) => {
    const res = await apiCall(`/api/voice/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => null);
    if (res.ok && data?.ok && data.config) {
      setConfig(prev => ({ ...prev, ...data.config }));
      if (editingProfile?.id === profileId) setEditingProfile(null);
      toast('🗑️ 方案已删除');
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
      toast('当前方案 STT 为系统原生；切换到云端 BYOK 方案即可测试真实 WAV 上传延迟');
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

  const selectedCatalog = config.catalog.find(c => c.id === keyProvider);
  const selectedPickerMeta = PROVIDER_PICKER_CARDS.find(c => c.id === keyProvider);

  const onSelectKeyProvider = (prov: string) => {
    setKeyProvider(prov);
    setVolcSaveBoth(prov === 'volcengine_asr');
    const item = config.catalog.find(c => c.id === prov);
    const fallbackUrl = prov === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : prov === 'volcengine_asr'
        ? 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
        : prov === 'volcengine_tts'
          ? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
          : 'https://api.deepseek.com/v1';
    const fallbackResId = prov === 'volcengine_asr'
      ? 'volc.bigasr.auc_turbo'
      : prov === 'volcengine_tts'
        ? 'seed-tts-2.0'
        : '';
    setKeyBaseUrl(prov === 'openai_compat' ? 'https://api.deepseek.com/v1' : (item?.defaultBaseUrl || fallbackUrl));
    setKeyResourceId(item?.defaultResourceId || fallbackResId);
    setKeyDefaultModel('');
    setKeyDefaultVoice('');
  };

  const jumpToAddKey = (prov: string) => {
    onSelectKeyProvider(prov);
    setLabView('advanced');
    setLabTab('keys');
  };

  const openAdvancedMixGuide = () => {
    setLabView('advanced');
    setAdvGuideOpen(true);
    const hasVolc = config.credentials.some(c => c.provider === 'volcengine_asr' || c.provider === 'volcengine_tts');
    const hasOai = config.credentials.some(c => c.provider === 'openai_compat');
    if (hasVolc && hasOai) {
      setLabTab('profiles');
    } else {
      onSelectKeyProvider(hasVolc ? 'openai_compat' : 'volcengine_asr');
      setLabTab('keys');
    }
  };

  const renderCredSelect = (provider: string, value: string, onChange: (val: string) => void) => {
    if (provider === 'native') return null;
    const matched = config.credentials.filter(c => c.provider === provider);
    const provTitle = PROVIDER_DISPLAY_NAMES[provider] || provider;
    return (
      <Fragment>
        <label class="voice-field-label">使用哪把密钥</label>
        {matched.length === 0 ? (
          <button
            type="button"
            class="voice-missing-key-cta"
            onClick={() => jumpToAddKey(provider)}
          >
            <span>⚠️ 还没有「{provTitle}」密钥</span>
            <span>去 ① 密钥添加 →</span>
          </button>
        ) : (
          <select class="voice-field-input" value={value} onChange={(e: any) => onChange(e.target.value)}>
            <option value="">自动用默认密钥（当前 {matched.length} 把可用）</option>
            {matched.map(c => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.authSummary}){c.active ? ' ★默认' : ''}
              </option>
            ))}
          </select>
        )}
      </Fragment>
    );
  };

  const activeProf = config.activeProfile || DEFAULT_CONFIG.activeProfile;
  const recommendedPresets = buildRecommendedQuickProfiles(config.credentials);
  const activeMissingProviders = getMissingProvidersForProfile(activeProf, config.credentials);
  const simpleMatchedCred = simpleVendor === 'native' ? undefined : findSimpleVendorCred(simpleVendor, config.credentials);
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
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🎛️ 高级混搭与调试</span>
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
                        onClick={() => jumpToAddKey(activeMissingProviders[0])}
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
                                openAdvancedMixGuide();
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

                  {/* 清晰进入二级高级混搭模式 */}
                  <button
                    type="button"
                    class="voice-adv-entry-btn"
                    onClick={() => {
                      setLabView('advanced');
                      setLabTab(config.credentials.length > 0 ? 'profiles' : 'keys');
                    }}
                  >
                    <div style="min-width:0;">
                      <div class="voice-adv-entry-title">🎛️ 二级高级配置（自定义耳朵 / 大脑 / 嘴巴混搭）</div>
                      <div class="voice-adv-entry-sub">
                        例：火山豆包语音(听/说) + DeepSeek 大脑混搭、换模型/音色、中转站与压测
                      </div>
                    </div>
                    <span class="voice-adv-entry-go">进入 ›</span>
                  </button>
                </div>
              </div>
            ) : (
              <Fragment>
                <div class="voice-lab-tabs">
                  <button
                    type="button"
                    class={`voice-lab-tab ${labTab === 'keys' ? 'active' : ''}`}
                    onClick={() => setLabTab('keys')}
                  >
                    ① 密钥 ({config.credentials.length})
                  </button>
                  <button
                    type="button"
                    class={`voice-lab-tab ${labTab === 'profiles' ? 'active' : ''}`}
                    onClick={() => setLabTab('profiles')}
                  >
                    ② 混搭方案
                  </button>
                  <button
                    type="button"
                    class={`voice-lab-tab ${labTab === 'bench' ? 'active' : ''}`}
                    onClick={() => setLabTab('bench')}
                  >
                    ③ 压测排障
                  </button>
                </div>

                <div class="voice-lab-body">
                  {loadingCfg && <div class="voice-muted-note">正在读取加密配置…</div>}

                  {/* 二级顶部简要示例指南（默认在点击「火山+DeepSeek混搭」时展开，随时可折叠） */}
                  <details
                    class="voice-mix-cheatbox"
                    open={advGuideOpen}
                    onToggle={(e: any) => setAdvGuideOpen(Boolean(e.currentTarget?.open))}
                  >
                    <summary>💡 混搭指南与例子（例：火山豆包听/说 + DeepSeek 大脑）</summary>
                    <div class="voice-mix-cheatbody">
                      <div>
                        <strong>核心概念：</strong>语音助手由 3 部分拼装——<strong>👂 耳朵</strong>（听懂你说的话）、<strong>🧠 大脑</strong>（总结消息与决策）、<strong>🗣️ 嘴巴</strong>（把回复念进耳机）。
                      </div>
                      <div style="margin-top:6px;">
                        <strong>🌋 你的火山 + DeepSeek 混搭示例（共需 2 步）：</strong>
                      </div>
                      <ol class="voice-mix-steps">
                        <li>
                          <strong>在 ① 密钥存 2 把 Key</strong>：
                          <br />• <strong>火山豆包语音 Key</strong>（火山控制台「语音技术」获取；勾上「同时存入听写与播报」只贴 1 遍！）
                          <br />• <strong>大脑 Key</strong>：选 <code>DeepSeek / 方舟</code>，可填 DeepSeek 官方（<code>sk-...</code>）<strong>或</strong>火山方舟 Ark Key（可同时调豆包和方舟版 DeepSeek）
                        </li>
                        <li>
                          <strong>去 ② 混搭方案点「一键启用」或手动微调</strong>：
                          <br />• 👂 耳朵：<code>火山豆包识别</code>（模型 <code>volc.bigasr.auc_turbo</code>）
                          <br />• 🧠 大脑：<code>DeepSeek 官方</code>填 <code>deepseek-chat</code>；或<code>火山方舟</code>填 <code>doubao-seed-2-0-lite-260215</code> / <code>ep-2025xxxx</code>
                          <br />• 🗣️ 嘴巴：<code>火山豆包播报</code>（模型 <code>seed-tts-2.0</code>，音色选 <code>vv 自然女声</code>）
                        </li>
                      </ol>
                    </div>
                  </details>

                  {/* TAB 1: ① 密钥管理 (BYOK) */}
                  {labTab === 'keys' && (
                    <div class="voice-tab-stack">
                      {config.credentials.length > 0 && (
                        <div class="voice-card">
                          <div class="voice-card-title" style="margin-bottom:8px;">已保存密钥 ({config.credentials.length})</div>
                          {config.credentials.map(c => (
                            <div key={c.id} class="voice-cred-item">
                              <div style="flex:1;min-width:0;">
                                <div class="voice-cred-title">
                                  <span class="voice-prov-tag">{PROVIDER_DISPLAY_NAMES[c.provider] || c.provider}</span>
                                  <span>{c.label}</span>
                                  {c.active && <span class="voice-active-tag">默认</span>}
                                </div>
                                <div class="voice-cred-sub">{c.authSummary}{c.baseUrl ? ` · ${c.baseUrl.replace(/^https?:\/\//, '').slice(0, 38)}` : ''}</div>
                                {testResults[c.id] && (
                                  <div class={`voice-test-msg ${testResults[c.id].ok ? 'ok' : 'err'}`}>
                                    {testResults[c.id].summary}
                                  </div>
                                )}
                              </div>
                              <div class="voice-cred-actions">
                                <button
                                  type="button"
                                  class="voice-pill-btn"
                                  disabled={testingCredId === c.id}
                                  onClick={() => void handleTestCredential(c.id)}
                                >
                                  {testingCredId === c.id ? '测速中…' : '🔌 测速'}
                                </button>
                                {!c.active && (
                                  <button type="button" class="voice-pill-btn" onClick={() => void handleActivateCredential(c.id)}>
                                    设为默认
                                  </button>
                                )}
                                <button type="button" class="voice-pill-btn danger" onClick={() => void handleDeleteCredential(c.id)}>
                                  删
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {recommendedPresets.length > 0 && (
                        <div class="voice-card">
                          <div class="voice-card-title">⚡ 下一步：一键生成并启用混搭方案</div>
                          <div class="voice-muted-note">根据你已存的密钥自动拼好耳朵 / 大脑 / 嘴巴，点一下立刻生效：</div>
                          <div class="voice-quick-preset-list">
                            {recommendedPresets.map(preset => (
                              <button
                                key={preset.key}
                                type="button"
                                class="voice-quick-preset-btn"
                                disabled={applyingPresetKey === preset.key}
                                onClick={() => void handleApplyQuickPreset(preset)}
                              >
                                <div style="min-width:0;">
                                  <div class="voice-quick-preset-title">{preset.badge} · {preset.title}</div>
                                  <div class="voice-quick-preset-sub">{preset.sub}</div>
                                </div>
                                <span class="voice-quick-preset-go">
                                  {applyingPresetKey === preset.key ? '启用中…' : '一键启用 ›'}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <div class="voice-card">
                        <div class="voice-card-title" style="margin-bottom:4px;">添加 API 密钥</div>
                        <div class="voice-muted-note" style="margin-bottom:10px;">
                          🔐 服务端 <strong>AES-256-GCM</strong> 加密落盘，永不回显明文。先点选你要添加哪一类：
                        </div>

                        <div class="voice-provider-grid">
                          {PROVIDER_PICKER_CARDS.map(card => {
                            const cnt = config.credentials.filter(c => c.provider === card.id).length;
                            return (
                              <button
                                key={card.id}
                                type="button"
                                class={`voice-provider-card ${keyProvider === card.id ? 'active' : ''}`}
                                onClick={() => onSelectKeyProvider(card.id)}
                              >
                                <div class="voice-provider-card-title">
                                  <span>{card.icon} {card.title}</span>
                                  {cnt > 0 && <span class="voice-provider-badge">{cnt}把</span>}
                                </div>
                                <div class="voice-provider-card-sub">{card.sub}</div>
                              </button>
                            );
                          })}
                        </div>

                        {selectedPickerMeta?.example && (
                          <div class="voice-example-callout">
                            💡 {selectedPickerMeta.example}
                          </div>
                        )}

                        {keyProvider === 'openai_compat' && (
                          <Fragment>
                            <label class="voice-field-label">快捷选厂商（自动填好接口地址）</label>
                            <div class="voice-chip-row" style="margin-top:0;margin-bottom:4px;">
                              {(selectedCatalog?.baseUrlExamples?.length
                                ? selectedCatalog.baseUrlExamples
                                : [
                                    { label: 'DeepSeek 官方', url: 'https://api.deepseek.com/v1' },
                                    { label: '火山方舟 Ark', url: 'https://ark.cn-beijing.volces.com/api/v3' },
                                    { label: 'OpenAI 官方', url: 'https://api.openai.com/v1' },
                                  ]
                              ).map(ex => (
                                <button
                                  key={ex.url}
                                  type="button"
                                  class={`voice-quick-chip ${keyBaseUrl === ex.url ? 'active' : ''}`}
                                  onClick={() => setKeyBaseUrl(ex.url)}
                                >
                                  {ex.label}
                                </button>
                              ))}
                            </div>
                            <label class="voice-field-label">接口地址 (Base URL)</label>
                            <input
                              class="voice-field-input"
                              value={keyBaseUrl}
                              placeholder="例：https://api.deepseek.com/v1 或 https://ark.cn-beijing.volces.com/api/v3"
                              onInput={(e: any) => setKeyBaseUrl(e.target.value)}
                            />
                          </Fragment>
                        )}

                        {(keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts') && (
                          <Fragment>
                            <label class="voice-dual-check">
                              <input
                                type="checkbox"
                                checked={volcSaveBoth}
                                onChange={(e: any) => setVolcSaveBoth(Boolean(e.target.checked))}
                              />
                              <span>
                                <strong>同一把火山语音 Key 同时用于「听写(ASR) + 播报(TTS)」</strong>
                                <span class="voice-dual-check-sub">勾选后点一次保存同时录入两处，免贴两遍</span>
                              </span>
                            </label>

                            <label class="voice-field-label">火山语音鉴权方式（一般选方式 A）</label>
                            <div class="voice-subseg">
                              <button
                                type="button"
                                class={`voice-subseg-btn ${volcAuthMode === 'apiKey' ? 'active' : ''}`}
                                onClick={() => setVolcAuthMode('apiKey')}
                              >
                                方式 A：单把 API Key（推荐）
                              </button>
                              <button
                                type="button"
                                class={`voice-subseg-btn ${volcAuthMode === 'appToken' ? 'active' : ''}`}
                                onClick={() => setVolcAuthMode('appToken')}
                              >
                                方式 B：AppID + Token
                              </button>
                            </div>
                          </Fragment>
                        )}

                        {(!(keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts') || volcAuthMode === 'apiKey') ? (
                          <Fragment>
                            <label class="voice-field-label">API Key（必填）</label>
                            <input
                              type="password"
                              class="voice-field-input"
                              value={keyApiKey}
                              placeholder={
                                keyProvider === 'gemini'
                                  ? '例：AIzaSy... 或 AQ.Ab...'
                                  : keyProvider === 'openai_compat'
                                    ? '例：DeepSeek 填 sk-...；火山方舟填方舟控制台 Key'
                                    : '粘贴火山引擎「语音技术」API Key'
                              }
                              onInput={(e: any) => setKeyApiKey(e.target.value)}
                            />
                          </Fragment>
                        ) : (
                          <div class="voice-two-col">
                            <div>
                              <label class="voice-field-label">AppID（必填）</label>
                              <input
                                class="voice-field-input"
                                value={keyAppId}
                                placeholder="例：1234567890"
                                onInput={(e: any) => setKeyAppId(e.target.value)}
                              />
                            </div>
                            <div>
                              <label class="voice-field-label">Access Token（必填）</label>
                              <input
                                type="password"
                                class="voice-field-input"
                                value={keyAccessToken}
                                placeholder="控制台生成的 Access Token"
                                onInput={(e: any) => setKeyAccessToken(e.target.value)}
                              />
                            </div>
                          </div>
                        )}

                        <label class="voice-field-label">备注名（可选，留空自动命名）</label>
                        <input
                          class="voice-field-input"
                          value={keyLabel}
                          placeholder={`留空自动命名为「${inferDefaultCredLabel(keyProvider, keyBaseUrl)}」`}
                          onInput={(e: any) => setKeyLabel(e.target.value)}
                        />

                        <details class="voice-adv-details">
                          <summary>⚙️ 更多参数（默认模型 / 音色 / Resource ID · 一般不用改）</summary>
                          <div class="voice-adv-body">
                            {keyProvider !== 'openai_compat' && (
                              <Fragment>
                                <label class="voice-field-label">接口 Base URL（默认官方地址）</label>
                                <input
                                  class="voice-field-input"
                                  value={keyBaseUrl}
                                  placeholder="https://..."
                                  onInput={(e: any) => setKeyBaseUrl(e.target.value)}
                                />
                              </Fragment>
                            )}
                            {(keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts') && (
                              <Fragment>
                                <label class="voice-field-label">火山 Resource ID（例：听写 volc.bigasr.auc_turbo / 播报 seed-tts-2.0）</label>
                                <input
                                  class="voice-field-input"
                                  value={keyResourceId}
                                  placeholder={keyProvider === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : 'seed-tts-2.0'}
                                  onInput={(e: any) => setKeyResourceId(e.target.value)}
                                />
                              </Fragment>
                            )}
                            <div class="voice-two-col">
                              <div>
                                <label class="voice-field-label">默认模型（例：deepseek-chat / ep-xxxx）</label>
                                <input
                                  class="voice-field-input"
                                  value={keyDefaultModel}
                                  placeholder="留空按方案自动选"
                                  onInput={(e: any) => setKeyDefaultModel(e.target.value)}
                                />
                              </div>
                              <div>
                                <label class="voice-field-label">默认音色（例：zh_female_vv_uranus_bigtts）</label>
                                <input
                                  class="voice-field-input"
                                  value={keyDefaultVoice}
                                  placeholder="如 vv / Kore / alloy"
                                  onInput={(e: any) => setKeyDefaultVoice(e.target.value)}
                                />
                              </div>
                            </div>
                          </div>
                        </details>

                        <button
                          type="button"
                          class="primary-block-btn"
                          disabled={savingKey}
                          onClick={() => void handleSaveCredential()}
                        >
                          {savingKey
                            ? '正在加密保存…'
                            : (keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts') && volcSaveBoth
                              ? '🔐 一次存入火山听写 + 播报'
                              : '🔐 加密存入密钥池'}
                        </button>
                      </div>
                    </div>
                  )}

              {/* TAB 2: ② 方案与开关 */}
              {labTab === 'profiles' && (
                <div class="voice-tab-stack">
                  {recommendedPresets.length > 0 && !editingProfile && (
                    <div class="voice-card">
                      <div class="voice-card-title">⚡ 一键推荐方案（免手动逐格填写）</div>
                      <div class="voice-quick-preset-list">
                        {recommendedPresets.map(preset => (
                          <button
                            key={preset.key}
                            type="button"
                            class="voice-quick-preset-btn"
                            disabled={applyingPresetKey === preset.key}
                            onClick={() => void handleApplyQuickPreset(preset)}
                          >
                            <div style="min-width:0;">
                              <div class="voice-quick-preset-title">{preset.badge} · {preset.title}</div>
                              <div class="voice-quick-preset-sub">{preset.sub}</div>
                            </div>
                            <span class="voice-quick-preset-go">
                              {applyingPresetKey === preset.key ? '启用中…' : '一键启用 ›'}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div class="voice-card">
                    <div class="voice-card-head">
                      <span class="voice-card-title">当前生效语音方案</span>
                      <button
                        type="button"
                        class="voice-pill-btn primary"
                        onClick={() => setEditingProfile(createSmartProfileDraft(config.credentials))}
                      >
                        ＋ 自定义混搭
                      </button>
                    </div>
                    <div class="voice-profile-list">
                      {config.profiles.map(p => {
                        const isActive = p.id === config.prefs.activeProfileId;
                        const missingProvs = getMissingProvidersForProfile(p, config.credentials);
                        return (
                          <div key={p.id} class={`voice-profile-row ${isActive ? 'active' : ''}`} style="flex-direction:column;align-items:stretch;">
                            <div style="display:flex;align-items:center;gap:8px;">
                              <div
                                style="flex:1;min-width:0;cursor:pointer;"
                                onClick={() => void updatePrefPatch({ activeProfileId: p.id })}
                              >
                                <div class="voice-profile-row-title">
                                  <span>{isActive ? '✅ ' : '⚪ '}{p.name}</span>
                                </div>
                                <div class="voice-summary-pills">
                                  <span class="voice-summary-pill">👂 耳朵：{formatStageSummary(p.stt.provider, p.stt.model, 'stt', p.stt.credId, config.credentials)}</span>
                                  <span class="voice-summary-pill">🧠 大脑：{formatStageSummary(p.brain.provider, p.brain.model, 'brain', p.brain.credId, config.credentials)}</span>
                                  <span class="voice-summary-pill">🗣️ 嘴巴：{formatStageSummary(p.tts.provider, p.tts.model, 'tts', p.tts.credId, config.credentials)}</span>
                                </div>
                              </div>
                              {!p.builtin && (
                                <div style="display:flex;gap:6px;flex-shrink:0;">
                                  <button
                                    type="button"
                                    class="voice-pill-btn"
                                    onClick={() => setEditingProfile(JSON.parse(JSON.stringify(p)))}
                                  >
                                    编辑
                                  </button>
                                  <button
                                    type="button"
                                    class="voice-pill-btn danger"
                                    onClick={() => void handleDeleteProfile(p.id)}
                                  >
                                    删
                                  </button>
                                </div>
                              )}
                            </div>
                            {missingProvs.length > 0 && (
                              <button
                                type="button"
                                class="voice-missing-key-cta"
                                onClick={() => jumpToAddKey(missingProvs[0])}
                              >
                                <span>⚠️ 缺少 {missingProvs.map(pr => PROVIDER_DISPLAY_NAMES[pr] || pr).join('、')} 密钥</span>
                                <span>去 ① 添加 →</span>
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 新建 / 编辑混搭方案（全中文清晰标签 + 高级项折叠） */}
                  {editingProfile && (
                    <div class="voice-card voice-editor-card">
                      <div class="voice-card-head">
                        <span class="voice-card-title">{editingProfile.id ? '编辑语音方案' : '自定义混搭方案（耳朵 / 大脑 / 嘴巴自由选）'}</span>
                        <button type="button" class="voice-pill-btn" onClick={() => setEditingProfile(null)}>取消</button>
                      </div>

                      <label class="voice-field-label">方案名称（方便自己辨认）</label>
                      <input
                        class="voice-field-input"
                        value={editingProfile.name}
                        placeholder="例如：全 Gemini 随行 / 豆包听写 + DeepSeek 大脑"
                        onInput={(e: any) => setEditingProfile({ ...editingProfile, name: e.target.value })}
                      />

                      {/* STT */}
                      <div class="voice-stage-box">
                        <div class="voice-stage-title">👂 1. 语音识别（耳朵）</div>
                        <div class="voice-stage-sub">负责把你对耳机说的话转成文字。</div>
                        <div class="voice-stage-example">
                          💡 例子：中文最准最快选<strong>火山豆包识别</strong>（默认模型 <code>volc.bigasr.auc_turbo</code>）；省钱免配直接选<strong>系统免费原生</strong>。
                        </div>

                        <label class="voice-field-label">用哪家服务商听写</label>
                        <select
                          class="voice-field-input"
                          value={editingProfile.stt.provider}
                          onChange={(e: any) => {
                            const prov = e.target.value;
                            const defModel = prov === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : prov === 'gemini' ? 'gemini-2.5-flash' : prov === 'openai_compat' ? 'whisper-1' : 'browser-web-speech';
                            setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, provider: prov, credId: '', model: defModel } });
                          }}
                        >
                          <option value="native">系统免费原生（免 Key，直接用手机听写）</option>
                          <option value="volcengine_asr">火山豆包 Flash ASR（极速中文·推荐）</option>
                          <option value="gemini">Google Gemini（1 把 Key 通用）</option>
                          <option value="openai_compat">OpenAI 兼容接口（Whisper）</option>
                        </select>

                        {renderCredSelect(editingProfile.stt.provider, editingProfile.stt.credId, v =>
                          setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, credId: v } }),
                        )}

                        {editingProfile.stt.provider !== 'native' && (
                          <details class="voice-adv-details">
                            <summary>⚙️ 高级参数（识别模型 / 备用兜底 · 已填好默认值）</summary>
                            <div class="voice-adv-body">
                              <label class="voice-field-label">识别模型名 / 火山资源 ID</label>
                              <input
                                class="voice-field-input"
                                value={editingProfile.stt.model}
                                placeholder="例：火山填 volc.bigasr.auc_turbo；Gemini 填 gemini-2.5-flash"
                                onInput={(e: any) => setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, model: e.target.value } })}
                              />
                              {editingProfile.stt.provider === 'gemini' && (
                                <Fragment>
                                  <label class="voice-field-label">听写思考档位</label>
                                  <select
                                    class="voice-field-input"
                                    value={editingProfile.stt.thinkingLevel || 'low'}
                                    onChange={(e: any) => setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, thinkingLevel: e.target.value } })}
                                  >
                                    <option value="low">low（推荐，防漏字且低延迟）</option>
                                    <option value="default">模型默认</option>
                                    <option value="medium">medium</option>
                                  </select>
                                </Fragment>
                              )}
                              <label class="voice-field-label">主引擎失败时的备用听写（可选）</label>
                              <select
                                class="voice-field-input"
                                value={editingProfile.stt.fallbackChain?.[0]?.provider || ''}
                                onChange={(e: any) => {
                                  const fbProv = e.target.value;
                                  const fbModel = fbProv === 'gemini' ? 'gemini-2.5-flash' : fbProv === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : fbProv === 'openai_compat' ? 'whisper-1' : '';
                                  setEditingProfile({
                                    ...editingProfile,
                                    stt: {
                                      ...editingProfile.stt,
                                      fallbackChain: fbProv ? [{ provider: fbProv, credId: '', model: fbModel, thinkingLevel: 'low' }] : [],
                                    },
                                  });
                                }}
                              >
                                <option value="">无（主引擎失败直接提示）</option>
                                <option value="gemini">备用：Google Gemini</option>
                                <option value="volcengine_asr">备用：火山 Flash ASR</option>
                                <option value="openai_compat">备用：OpenAI 兼容 Whisper</option>
                              </select>
                            </div>
                          </details>
                        )}
                      </div>

                      {/* Brain */}
                      <div class="voice-stage-box">
                        <div class="voice-stage-title">🧠 2. 语音大脑（核心）</div>
                        <div class="voice-stage-sub">负责总结电脑发来的长消息、念出选项，并听懂你的指令（如「1号允许」「选第二个」）。</div>
                        <div class="voice-stage-example">
                          💡 例子：<strong>DeepSeek 官方</strong>填 <code>deepseek-chat</code>；<strong>火山方舟 Ark</strong>填 <code>doubao-seed-2-0-lite-260215</code>、<code>deepseek-v3-250324</code> 或自定义接入点 <code>ep-2025xxxx</code>。
                        </div>

                        <label class="voice-field-label">用哪家大模型思考</label>
                        <select
                          class="voice-field-input"
                          value={editingProfile.brain.provider}
                          onChange={(e: any) => {
                            const prov = e.target.value;
                            const oai = config.credentials.find(c => c.provider === 'openai_compat' && c.active) || config.credentials.find(c => c.provider === 'openai_compat');
                            const defModel = prov === 'gemini' ? 'gemini-2.5-flash' : prov === 'openai_compat' ? inferOpenAiCompatModel(oai) : 'rule-router';
                            setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, provider: prov, credId: '', model: defModel } });
                          }}
                        >
                          <option value="openai_compat">DeepSeek / 火山方舟 / OpenAI（推荐）</option>
                          <option value="gemini">Google Gemini（速度快、工具调度准）</option>
                          <option value="native">本地基础口令（免 Key，仅支持固定口令）</option>
                        </select>

                        {renderCredSelect(editingProfile.brain.provider, editingProfile.brain.credId, v => {
                          const picked = config.credentials.find(c => c.id === v);
                          const nextModel = picked ? inferOpenAiCompatModel(picked) : editingProfile.brain.model;
                          setEditingProfile({
                            ...editingProfile,
                            brain: {
                              ...editingProfile.brain,
                              credId: v,
                              model: editingProfile.brain.provider === 'openai_compat' && picked ? nextModel : editingProfile.brain.model,
                            },
                          });
                        })}

                        {editingProfile.brain.provider !== 'native' && (
                          <Fragment>
                            <label class="voice-field-label">大模型名称 / 方舟接入点 ID（点下方标签可快填）</label>
                            <input
                              class="voice-field-input"
                              value={editingProfile.brain.model}
                              placeholder="例：deepseek-chat / doubao-seed-2-0-lite-260215 / ep-2025xxxx"
                              onInput={(e: any) => setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, model: e.target.value } })}
                            />
                            {BRAIN_MODEL_CHIPS[editingProfile.brain.provider] && (
                              <div class="voice-chip-row" style="margin-top:4px;">
                                {BRAIN_MODEL_CHIPS[editingProfile.brain.provider].map(chip => (
                                  <button
                                    key={chip.value}
                                    type="button"
                                    class={`voice-quick-chip ${editingProfile.brain.model === chip.value ? 'active' : ''}`}
                                    onClick={() => setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, model: chip.value } })}
                                  >
                                    {chip.label}
                                  </button>
                                ))}
                              </div>
                            )}
                            <details class="voice-adv-details">
                              <summary>⚙️ 高级参数（思考档位 · 默认关闭思考，响应 ~1 秒）</summary>
                              <div class="voice-adv-body">
                                <label class="voice-field-label">思考深度（走路语音强烈建议选「关闭思考」，开口最快）</label>
                                <select
                                  class="voice-field-input"
                                  value={editingProfile.brain.thinkingLevel || 'off'}
                                  onChange={(e: any) => setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, thinkingLevel: e.target.value } })}
                                >
                                  <option value="off">关闭思考（极速 ~1s，推荐随行口令）</option>
                                  <option value="low">low（轻量思考，Gemini 3.x/4.x 最低档）</option>
                                  <option value="medium">medium（均衡）</option>
                                  <option value="high">high（复杂多任务规划）</option>
                                </select>
                              </div>
                            </details>
                          </Fragment>
                        )}
                      </div>

                      {/* TTS */}
                      <div class="voice-stage-box">
                        <div class="voice-stage-title">🗣️ 3. 语音播报（嘴巴）</div>
                        <div class="voice-stage-sub">负责把总结和回复念进耳机里。</div>
                        <div class="voice-stage-example">
                          💡 例子：最像真人中文选<strong>火山豆包播报</strong>（默认 <code>seed-tts-2.0</code> + <code>vv 自然女声</code>）；省钱零延迟选<strong>系统免费原生</strong>。
                        </div>

                        <label class="voice-field-label">用哪家语音播报</label>
                        <select
                          class="voice-field-input"
                          value={editingProfile.tts.provider}
                          onChange={(e: any) => {
                            const prov = e.target.value;
                            const defModel = prov === 'volcengine_tts' ? 'seed-tts-2.0' : prov === 'gemini' ? 'gemini-2.5-flash-preview-tts' : prov === 'openai_compat' ? 'gpt-4o-mini-tts' : 'browser-speech-synthesis';
                            const defVoice = prov === 'volcengine_tts' ? 'zh_female_vv_uranus_bigtts' : prov === 'gemini' ? 'Kore' : prov === 'openai_compat' ? 'alloy' : 'system-default';
                            setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, provider: prov, credId: '', model: defModel, voice: defVoice } });
                          }}
                        >
                          <option value="native">系统免费原生（免 Key，零延迟）</option>
                          <option value="volcengine_tts">火山豆包 Seed-TTS 2.0（自然中文·推荐）</option>
                          <option value="gemini">Google Gemini 语音（1 把 Key 通用）</option>
                          <option value="openai_compat">OpenAI 兼容接口（/audio/speech）</option>
                        </select>

                        {renderCredSelect(editingProfile.tts.provider, editingProfile.tts.credId, v =>
                          setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, credId: v } }),
                        )}

                        {editingProfile.tts.provider !== 'native' && (
                          <Fragment>
                            <label class="voice-field-label">播报音色（点标签一键切换）</label>
                            {TTS_VOICE_CHIPS[editingProfile.tts.provider] && (
                              <div class="voice-chip-row" style="margin-top:0;margin-bottom:4px;">
                                {TTS_VOICE_CHIPS[editingProfile.tts.provider].map(v => (
                                  <button
                                    key={v.value}
                                    type="button"
                                    class={`voice-quick-chip ${editingProfile.tts.voice === v.value ? 'active' : ''}`}
                                    onClick={() => setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, voice: v.value } })}
                                  >
                                    {v.label}
                                  </button>
                                ))}
                              </div>
                            )}
                            <details class="voice-adv-details">
                              <summary>⚙️ 高级参数（自定义音色代码 / 播报模型 · 已填好）</summary>
                              <div class="voice-adv-body">
                                <label class="voice-field-label">音色代码（例：火山填 zh_female_vv_uranus_bigtts）</label>
                                <input
                                  class="voice-field-input"
                                  value={editingProfile.tts.voice || ''}
                                  placeholder="如 zh_female_vv_uranus_bigtts / Kore / alloy"
                                  onInput={(e: any) => setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, voice: e.target.value } })}
                                />
                                <label class="voice-field-label">播报模型 / 火山资源 ID（一般保持默认）</label>
                                <input
                                  class="voice-field-input"
                                  value={editingProfile.tts.model}
                                  placeholder="例：seed-tts-2.0 / gemini-2.5-flash-preview-tts"
                                  onInput={(e: any) => setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, model: e.target.value } })}
                                />
                              </div>
                            </details>
                          </Fragment>
                        )}
                      </div>

                      <button
                        type="button"
                        class="primary-block-btn"
                        disabled={savingProfile}
                        onClick={() => void handleSaveProfile()}
                      >
                        {savingProfile ? '正在保存…' : '💾 保存并启用该方案'}
                      </button>
                    </div>
                  )}

                  {/* 安全护栏与聊天页开关 */}
                  <div class="voice-card">
                    <div class="voice-card-title" style="margin-bottom:8px;">🛡️ 安全护栏与行为开关</div>

                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">高危操作审批策略 (L2)</div>
                        <div class="voice-row-sub">命中 rm -rf / force push / 生产部署等高危指令时的保护方式</div>
                      </div>
                      <select
                        class="voice-mini-select"
                        value={config.prefs.l2Policy}
                        onChange={(e: any) => void updatePrefPatch({ l2Policy: e.target.value })}
                      >
                        <option value="pin">🔢 念出随机 3 位确认码</option>
                        <option value="screen_only">📱 仅限手机屏幕点按</option>
                      </select>
                    </div>

                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">播报完选项后自动开麦等我回答</div>
                        <div class="voice-row-sub">新审批或提问念完后自动用耳机收音 5.5 秒；不说话自动静默还回音乐</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={config.prefs.autoListenAfterBriefing}
                        onChange={(e: any) => void updatePrefPatch({ autoListenAfterBriefing: e.target.checked })}
                      />
                    </div>

                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">🎵 边听歌边播报（Safari 压低混音）</div>
                        <div class="voice-row-sub">空闲时保持立体声听歌，播报时自动压低背景音乐音量，说完自动恢复</div>
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
                        <div class="voice-row-main">聊天页「🔊 播报」使用云端音色</div>
                        <div class="voice-row-sub">默认关闭（保持免费系统语音）；开启后复用当前方案嘴巴，失败自动降级</div>
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
                        <div class="voice-row-main">聊天页语音输入使用云端听写</div>
                        <div class="voice-row-sub">默认关闭（保持免费系统听写）；开启后可在聊天页复用当前方案耳朵</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={config.prefs.useByokForChatStt}
                        onChange={(e: any) => void updatePrefPatch({ useByokForChatStt: e.target.checked })}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: ③ 压测排障 (Voice Lab Dry-Run) */}
              {labTab === 'bench' && (
                <div class="voice-tab-stack">
                  <div class="voice-card">
                    <div class="voice-card-head" style="margin-bottom:4px;">
                      <span class="voice-card-title">当前被测方案：{activeProf.name}</span>
                      <button type="button" class="voice-pill-btn" onClick={() => setLabTab('profiles')}>
                        换方案
                      </button>
                    </div>
                    <div class="voice-muted-note" style="margin-top:0;margin-bottom:6px;">
                      用于排查哪一步（听写 / 大脑 / 播报）变慢或报错；勾选安全试跑绝不会真的操作电脑。
                    </div>
                    <div class="voice-summary-pills">
                      <span class="voice-summary-pill">👂 耳朵：{formatStageSummary(activeProf.stt.provider, activeProf.stt.model, 'stt', activeProf.stt.credId, config.credentials)}</span>
                      <span class="voice-summary-pill">🧠 大脑：{formatStageSummary(activeProf.brain.provider, activeProf.brain.model, 'brain', activeProf.brain.credId, config.credentials)}</span>
                      <span class="voice-summary-pill">🗣️ 嘴巴：{formatStageSummary(activeProf.tts.provider, activeProf.tts.model, 'tts', activeProf.tts.credId, config.credentials)}</span>
                    </div>
                    {activeMissingProviders.length > 0 && (
                      <button
                        type="button"
                        class="voice-missing-key-cta"
                        style="margin-top:8px;"
                        onClick={() => jumpToAddKey(activeMissingProviders[0])}
                      >
                        <span>⚠️ 当前方案缺少 {activeMissingProviders.map(pr => PROVIDER_DISPLAY_NAMES[pr] || pr).join('、')} 密钥</span>
                        <span>去 ① 添加 →</span>
                      </button>
                    )}

                    <div class="voice-toggle-row" style="margin-top:8px;">
                      <div>
                        <div class="voice-row-main">🧪 安全试跑模式 (Dry-Run)</div>
                        <div class="voice-row-sub">只测模型回复和语音播报速度，绝不会真的遥控你的电脑</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={benchDryRun}
                        onChange={(e: any) => setBenchDryRun(e.target.checked)}
                      />
                    </div>

                    <label class="voice-field-label">快捷点一句测试口令</label>
                    <div class="voice-chip-row" style="margin-top:0;">
                      {['现在有哪些待审批和运行中的任务？', '放行当前审批', '帮我新建任务跑一遍单测', '确认码 739'].map(sample => (
                        <button
                          key={sample}
                          type="button"
                          class={`voice-quick-chip ${benchText === sample ? 'active' : ''}`}
                          onClick={() => setBenchText(sample)}
                        >
                          {sample}
                        </button>
                      ))}
                    </div>

                    <textarea
                      class="voice-field-input"
                      rows={2}
                      style="margin-top:8px;"
                      value={benchText}
                      onInput={(e: any) => setBenchText(e.target.value)}
                      placeholder="输入一句测试口令，或点下方录一段真声测全链路..."
                    />

                    <div style="display:flex;gap:8px;margin-top:8px;">
                      <button
                        type="button"
                        class="primary-block-btn"
                        style="margin-top:0;flex:1;"
                        disabled={benchRunning}
                        onClick={() => void runBenchTurn()}
                      >
                        {benchRunning ? '⏳ 正在试跑测速…' : '🚀 测一轮回复与出声'}
                      </button>
                      <button
                        type="button"
                        class={`voice-pill-btn ${benchRecording ? 'danger' : ''}`}
                        style="padding:10px 12px;"
                        disabled={benchRunning}
                        onClick={() => void toggleBenchVoiceCapture()}
                      >
                        {benchRecording ? '⏹ 停止并测试' : '🎙️ 录真声'}
                      </button>
                    </div>
                  </div>

                  {benchReport && (
                    <div class="voice-card">
                      <div class="voice-card-title" style="margin-bottom:8px;">📊 实测耗时与结构化决策</div>
                      <div class="voice-metrics-grid">
                        {benchReport.stt && (
                          <div class="voice-metric-box">
                            <div class="voice-metric-k">STT ({benchReport.stt.wavKb || 0}KB)</div>
                            <div class="voice-metric-v">{benchReport.stt.latencyMs ?? 0} ms</div>
                          </div>
                        )}
                        {benchReport.turn && (
                          <div class="voice-metric-box">
                            <div class="voice-metric-k">大脑 ({benchReport.turn.model || '-'})</div>
                            <div class="voice-metric-v">{benchReport.turn.latencyMs ?? 0} ms</div>
                          </div>
                        )}
                        {benchReport.tts && (
                          <div class="voice-metric-box">
                            <div class="voice-metric-k">TTS ({benchReport.tts.provider || '-'})</div>
                            <div class="voice-metric-v">{benchReport.tts.latencyMs ?? 0} ms</div>
                          </div>
                        )}
                      </div>

                      {benchReport.turn?.spokenReply && (
                        <div class="voice-bench-reply">
                          <div><strong>口语回复：</strong>{benchReport.turn.spokenReply}</div>
                          {benchReport.tts?.audioBase64 && (
                            <button
                              type="button"
                              class="voice-pill-btn primary"
                              style="margin-top:8px;"
                              onClick={() => void playerRef.current?.playAudioBase64(benchReport.tts.audioBase64, benchReport.tts.mimeType)}
                            >
                              🔊 试听云端合成音频 ({Math.round((benchReport.tts.byteLength || 0) / 1024)} KB)
                            </button>
                          )}
                        </div>
                      )}

                      {(benchReport.stt?.error || benchReport.turn?.error || benchReport.tts?.error) && (
                        <div class="voice-test-msg err" style="margin-top:8px;">
                          {benchReport.stt?.error || benchReport.turn?.error || benchReport.tts?.error}
                        </div>
                      )}

                      {benchReport.turn?.action && (
                        <pre class="voice-bench-json">
                          {JSON.stringify(
                            {
                              fastPath: benchReport.turn.fastPath || null,
                              action: benchReport.turn.action,
                              execution: benchReport.turn.execution,
                            },
                            null,
                            2,
                          )}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
              </Fragment>
            )}
          </div>
        </div>
      )}
    </Fragment>
  );
}
