import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyLangToDom, getLangPref, translateZhStringToEn } from '../utils/i18n.js';
import {
  PROTOCOL_LABELS,
  TTS_VOICE_OPTIONS,
  buildRoutingProfilePayload,
  computeSelectionAfterDelete,
  computeSmartDefaultSelection,
  extractHostFromUrl,
  formatVoiceCompactValue,
  getCredentialActiveRoles,
  getCredentialFeatureUsages,
  getStageSelectValue,
  inferDefaultBrainModel,
  providerSupportsStage,
  resolveFeatureStageConfig,
} from '../voice/provider-routing.js';

export interface PublicCredential {
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

export interface StageConfig {
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

export interface VoiceProfile {
  id: string;
  name: string;
  builtin?: boolean;
  stt: StageConfig;
  brain: StageConfig;
  tts: StageConfig;
}

export interface VoicePrefs {
  activeProfileId: string;
  l2Policy: 'pin' | 'screen_only';
  proactiveBriefing: 'approvals' | 'all' | 'manual';
  briefingDetail?: 'detailed' | 'verbatim' | 'concise';
  autoVad: boolean;
  vadSilenceMs: number;
  autoListenAfterBriefing: boolean;
  duckMusicMode: boolean;
  useByokForChatStt: boolean;
  useByokForChatTts: boolean;
  chatSttTarget?: string;
  chatTtsTarget?: string;
  autoPlayWalkReplies: boolean;
  speechRate: number;
}

export interface VoiceConfigState {
  storageMode: string;
  catalog: any[];
  credentials: PublicCredential[];
  profiles: VoiceProfile[];
  prefs: VoicePrefs;
  activeProfile: VoiceProfile;
  activePin?: any;
}

interface ProviderDraft {
  id: string;
  provider: 'openai_compat' | 'gemini' | 'volcengine_asr' | 'volcengine_tts';
  label: string;
  baseUrl: string;
  volcAuthMode: 'apiKey' | 'appToken';
  apiKey: string;
  appId: string;
  accessToken: string;
  defaultModel: string;
  defaultVoice: string;
  resourceId: string;
  alsoCreateTts: boolean;
  pairedTtsVoice: string;
  pairedTtsResourceId: string;
  setAsDefault: boolean;
}

export interface VoiceProviderSheetProps {
  open: boolean;
  onClose: () => void;
  config: VoiceConfigState;
  loadingCfg: boolean;
  initialView?: 'models' | 'walk' | 'chat' | 'list' | 'add' | 'bench';
  onConfigChange: (next: VoiceConfigState) => void;
  onUpdatePrefs: (patch: Partial<VoicePrefs>) => Promise<void>;
  onSoundCheck: () => Promise<void>;
  onUnlockAudio?: () => void;
  onPlayTestAudio?: (base64: string, mimeType?: string) => Promise<boolean>;
  soundChecking: boolean;
  soundCheckMsg: { ok: boolean; text: string } | null;
  onClearSoundCheckMsg: () => void;
  onRunBenchTurn: () => Promise<void>;
  onToggleBenchVoice: () => Promise<void>;
  benchDryRun: boolean;
  onSetBenchDryRun: (v: boolean) => void;
  benchText: string;
  onSetBenchText: (v: string) => void;
  benchRunning: boolean;
  benchRecording: boolean;
  benchReport: any;
  apiCall: (path: string, options?: RequestInit) => Promise<Response>;
  toast: (msg: string) => void;
}

const BackChevronSvg = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

const CloseSvg = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

const PlusSvg = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

function makeBlankDraft(): ProviderDraft {
  return {
    id: '',
    provider: 'openai_compat',
    label: '',
    baseUrl: '',
    volcAuthMode: 'apiKey',
    apiKey: '',
    appId: '',
    accessToken: '',
    defaultModel: '',
    defaultVoice: '',
    resourceId: '',
    alsoCreateTts: true,
    pairedTtsVoice: 'zh_female_vv_uranus_bigtts',
    pairedTtsResourceId: 'seed-tts-2.0',
    setAsDefault: true,
  };
}

function makeDraftFromCredential(cred: PublicCredential): ProviderDraft {
  return {
    id: cred.id,
    provider: (cred.provider as ProviderDraft['provider']) || 'openai_compat',
    label: cred.label || '',
    baseUrl: cred.baseUrl || '',
    volcAuthMode: (!cred.hasApiKey && (cred.hasAppId || cred.hasAccessToken)) ? 'appToken' : 'apiKey',
    apiKey: '',
    appId: '',
    accessToken: '',
    defaultModel: cred.defaultModel || '',
    defaultVoice: cred.defaultVoice || '',
    resourceId: cred.resourceId || '',
    alsoCreateTts: false,
    pairedTtsVoice: 'zh_female_vv_uranus_bigtts',
    pairedTtsResourceId: 'seed-tts-2.0',
    setAsDefault: false,
  };
}

export function VoiceProviderSheet(props: VoiceProviderSheetProps) {
  const {
    open,
    onClose,
    config,
    loadingCfg,
    initialView = 'list',
    onConfigChange,
    onUpdatePrefs,
    onSoundCheck,
    onUnlockAudio,
    onPlayTestAudio,
    soundChecking,
    soundCheckMsg,
    onClearSoundCheckMsg,
    onRunBenchTurn,
    onToggleBenchVoice,
    benchDryRun,
    onSetBenchDryRun,
    benchText,
    onSetBenchText,
    benchRunning,
    benchRecording,
    benchReport,
    apiCall,
    toast,
  } = props;

  const [viewMode, setViewMode] = useState<'models' | 'walk' | 'chat' | 'editor'>('walk');
  const [returnView, setReturnView] = useState<'models' | 'walk' | 'chat'>('models');
  const [chatTestingTts, setChatTestingTts] = useState(false);
  const [chatTtsMsg, setChatTtsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(() => makeBlankDraft());
  const [editingCredSummary, setEditingCredSummary] = useState('');
  const [savingEditor, setSavingEditor] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [testingDraft, setTestingDraft] = useState(false);
  const [draftTestRes, setDraftTestRes] = useState<{ ok: boolean; partialOk?: boolean; text: string; ttsFailed?: boolean } | null>(null);

  const [routingSaving, setRoutingSaving] = useState(false);
  const [routingMsg, setRoutingMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingCredId, setTestingCredId] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; summary: string }>>({});
  const [geekOpen, setGeekOpen] = useState(false);
  const [, setLangTick] = useState(() => getLangPref());

  useEffect(() => {
    const onLang = (ev: any) => setLangTick(String(ev?.detail || getLangPref()));
    window.addEventListener('dsh:lang-change', onLang);
    return () => window.removeEventListener('dsh:lang-change', onLang);
  }, []);

  // Re-apply English DOM translation after every Preact commit while sheet is open
  useEffect(() => {
    if (!open) return;
    const el = document.getElementById('voiceLabSheet');
    if (el) applyLangToDom(el, getLangPref());
  });

  useEffect(() => {
    if (!open) return;
    setRoutingMsg(null);
    setChatTtsMsg(null);
    setEditorError('');
    if (initialView === 'add') {
      setDraft(makeBlankDraft());
      setEditingCredSummary('');
      setReturnView('models');
      setViewMode('editor');
    } else if (initialView === 'models') {
      setReturnView('models');
      setViewMode('models');
      setGeekOpen(false);
    } else if (initialView === 'chat') {
      setReturnView('chat');
      setViewMode('chat');
      setGeekOpen(false);
    } else {
      setReturnView('walk');
      setViewMode('walk');
      setGeekOpen(initialView === 'bench');
    }
  }, [open, initialView]);

  if (!open) return null;

  const activeProf = config.activeProfile;
  const creds = config.credentials || [];
  const sttVal = getStageSelectValue(activeProf?.stt, creds);
  const brainVal = getStageSelectValue(activeProf?.brain, creds);
  const ttsVal = getStageSelectValue(activeProf?.tts, creds);

  const sttCreds = creds.filter(c => providerSupportsStage(c.provider, 'stt'));
  const brainCreds = creds.filter(c => providerSupportsStage(c.provider, 'brain'));
  const ttsCreds = creds.filter(c => providerSupportsStage(c.provider, 'tts'));

  const missingStages: string[] = [];
  if (sttVal.startsWith('missing:')) missingStages.push('听写');
  if (brainVal.startsWith('missing:')) missingStages.push('大脑');
  if (ttsVal.startsWith('missing:')) missingStages.push('播报');

  const persistRouting = async (
    nextSttVal: string,
    nextBrainVal: string,
    nextTtsVal: string,
    latestCfg: VoiceConfigState = config,
    successNotice?: string,
  ) => {
    setRoutingSaving(true);
    setRoutingMsg(null);
    try {
      const plan = buildRoutingProfilePayload({
        sttVal: nextSttVal,
        brainVal: nextBrainVal,
        ttsVal: nextTtsVal,
        credentials: latestCfg.credentials,
        existingProfiles: latestCfg.profiles,
        activeProfile: latestCfg.activeProfile,
      });

      if (plan.isNativeOnly) {
        await onUpdatePrefs({ activeProfileId: 'native' });
        setRoutingMsg({ ok: true, text: successNotice || '已切换为免费本机语音' });
        return;
      }

      const res = await apiCall('/api/voice/profiles', {
        method: 'POST',
        body: JSON.stringify(plan.profilePayload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.config) {
        const errText = data?.error || '保存默认分配失败';
        setRoutingMsg({ ok: false, text: errText });
        toast(errText);
        return;
      }
      onConfigChange({ ...latestCfg, ...data.config });
      setRoutingMsg({ ok: true, text: successNotice || `已生效：${plan.profilePayload.name}` });
    } catch (err: any) {
      setRoutingMsg({ ok: false, text: err?.message || '保存失败' });
    } finally {
      setRoutingSaving(false);
    }
  };

  const handleStageChange = (stage: 'stt' | 'brain' | 'tts', nextVal: string) => {
    const nextStt = stage === 'stt' ? nextVal : sttVal;
    const nextBrain = stage === 'brain' ? nextVal : brainVal;
    const nextTts = stage === 'tts' ? nextVal : ttsVal;
    void persistRouting(nextStt, nextBrain, nextTts);
  };

  const handleSetProviderDefault = async (cred: PublicCredential) => {
    const nextSel = computeSmartDefaultSelection(cred, { sttVal, brainVal, ttsVal });
    await persistRouting(
      nextSel.sttVal,
      nextSel.brainVal,
      nextSel.ttsVal,
      config,
      `已将「${cred.label}」设为默认`,
    );
    toast(`已将「${cred.label}」设为默认`);
  };

  const handleTestProvider = async (credId: string) => {
    onUnlockAudio?.();
    setTestingCredId(credId);
    try {
      const res = await apiCall('/api/voice/test', {
        method: 'POST',
        body: JSON.stringify({ credId }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (data?.ok && data.audioBase64) {
        void onPlayTestAudio?.(data.audioBase64, data.mimeType);
      }
      setTestResults(prev => ({
        ...prev,
        [credId]: {
          ok: Boolean(data?.ok),
          summary: data?.summary || (data?.ok ? `连通正常 (${data.latencyMs ?? 0}ms)` : (data?.error || '测试失败')),
        },
      }));
    } catch (err: any) {
      setTestResults(prev => ({
        ...prev,
        [credId]: { ok: false, summary: err?.message || '网络异常' },
      }));
    } finally {
      setTestingCredId('');
    }
  };

  const handleTestDraft = async () => {
    onUnlockAudio?.();
    setEditorError('');
    setDraftTestRes(null);
    const isEdit = Boolean(draft.id);
    const isVolc = draft.provider === 'volcengine_asr' || draft.provider === 'volcengine_tts';
    if (draft.provider === 'openai_compat' && !draft.baseUrl.trim()) {
      setEditorError('请先填写接口地址（Base URL），再点测试连通');
      return;
    }
    if (!isEdit) {
      if (isVolc && draft.volcAuthMode === 'appToken') {
        if (!draft.appId.trim() || !draft.accessToken.trim()) {
          setEditorError('请先填写 AppID 和 Access Token');
          return;
        }
      } else if (!draft.apiKey.trim()) {
        setEditorError('请先填写 API Key 再测试');
        return;
      }
    }
    setTestingDraft(true);
    try {
      const res = await apiCall('/api/voice/test', {
        method: 'POST',
        body: JSON.stringify({
          draft: {
            id: draft.id || '',
            provider: draft.provider,
            label: draft.label.trim(),
            baseUrl: draft.baseUrl.trim(),
            authMode: isVolc ? draft.volcAuthMode : 'apiKey',
            apiKey: isVolc && draft.volcAuthMode === 'appToken' ? '' : draft.apiKey.trim(),
            appId: isVolc && draft.volcAuthMode === 'appToken' ? draft.appId.trim() : '',
            accessToken: isVolc && draft.volcAuthMode === 'appToken' ? draft.accessToken.trim() : '',
            defaultModel: draft.defaultModel.trim(),
            defaultVoice: draft.defaultVoice.trim(),
            resourceId: draft.resourceId.trim(),
            alsoTestTts: !isEdit && draft.provider === 'volcengine_asr' && draft.alsoCreateTts,
            pairedTtsVoice: draft.pairedTtsVoice.trim() || 'zh_female_vv_uranus_bigtts',
            pairedTtsResourceId: draft.pairedTtsResourceId.trim() || 'seed-tts-2.0',
          },
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (data?.ok && data.audioBase64) {
        void onPlayTestAudio?.(data.audioBase64, data.mimeType);
      }
      setDraftTestRes({
        ok: Boolean(data?.ok),
        partialOk: Boolean(data?.partialOk),
        ttsFailed: Boolean(data?.asrOk && data?.ttsOk === false),
        text: data?.summary || (data?.ok ? `连通正常 (${data.latencyMs ?? 0}ms)` : (data?.error || '测试失败，请检查配置')),
      });
    } catch (err: any) {
      setDraftTestRes({ ok: false, text: err?.message || '网络异常，请重试' });
    } finally {
      setTestingDraft(false);
    }
  };

  const handleDeleteProvider = async (cred: PublicCredential) => {
    const zhConfirm = `确定删除 Provider「${cred.label}」吗？\n删除后如果正在使用它，对应环节会自动回退。`;
    const confirmMsg = getLangPref() === 'en' ? translateZhStringToEn(zhConfirm) : zhConfirm;
    if (!confirm(confirmMsg)) {
      return;
    }
    try {
      const res = await apiCall(`/api/voice/credentials/${encodeURIComponent(cred.id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.config) {
        toast(data?.error || '删除失败');
        return;
      }
      const nextCfg: VoiceConfigState = { ...config, ...data.config };
      onConfigChange(nextCfg);
      toast(`已删除「${cred.label}」`);

      const fallback = computeSelectionAfterDelete(cred.id, config.activeProfile, nextCfg.credentials);
      if (fallback.affected) {
        await persistRouting(
          fallback.nextSelection.sttVal,
          fallback.nextSelection.brainVal,
          fallback.nextSelection.ttsVal,
          nextCfg,
          `已删除「${cred.label}」，对应环节已回退`,
        );
      }
    } catch (err: any) {
      toast(`删除失败：${err?.message || '网络异常'}`);
    }
  };

  const openAddEditor = () => {
    setDraft(makeBlankDraft());
    setEditingCredSummary('');
    setEditorError('');
    setDraftTestRes(null);
    if (viewMode !== 'editor') setReturnView(viewMode);
    setViewMode('editor');
  };

  const openEditEditor = (cred: PublicCredential) => {
    setDraft(makeDraftFromCredential(cred));
    setEditingCredSummary(cred.authSummary || '');
    setEditorError('');
    setDraftTestRes(null);
    if (viewMode !== 'editor') setReturnView(viewMode);
    setViewMode('editor');
  };

  const openModelsPoolFromFeature = (fromView: 'walk' | 'chat') => {
    setReturnView(fromView);
    setViewMode('models');
  };

  const handleTestChatTts = async () => {
    onUnlockAudio?.();
    const target = String(config.prefs.chatTtsTarget || (config.prefs.useByokForChatTts ? 'follow_walk' : 'native'));
    const stageOverride = resolveFeatureStageConfig(target, 'tts', activeProf, creds);
    const sample = '你好，这是聊天页消息朗读试听。';
    setChatTestingTts(true);
    setChatTtsMsg(null);
    try {
      if (!stageOverride) {
        if (typeof window !== 'undefined' && window.speechSynthesis && typeof SpeechSynthesisUtterance !== 'undefined') {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(sample);
          u.lang = 'zh-CN';
          window.speechSynthesis.speak(u);
        }
        setChatTtsMsg({ ok: true, text: '免费本机播报已开始（请确保手机未静音）' });
        return;
      }
      const res = await apiCall('/api/voice/tts', {
        method: 'POST',
        body: JSON.stringify({ text: sample, profileId: activeProf.id, stageOverride }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || !data?.ok || !data.audioBase64) {
        setChatTtsMsg({ ok: false, text: `播报失败：${data?.error || '请检查密钥与模型'}` });
        return;
      }
      const played = onPlayTestAudio ? await onPlayTestAudio(data.audioBase64, data.mimeType) : true;
      setChatTtsMsg({
        ok: Boolean(played),
        text: played ? `云端人声正常 (${data.latencyMs ?? 0}ms)` : '音频已返回，但手机拦截了播放，请再点一次',
      });
    } catch (err: any) {
      setChatTtsMsg({ ok: false, text: `试听异常：${err?.message || '网络失败'}` });
    } finally {
      setChatTestingTts(false);
    }
  };

  const handleProtocolChange = (nextProv: ProviderDraft['provider']) => {
    setEditorError('');
    setDraftTestRes(null);
    setDraft(prev => ({
      ...prev,
      provider: nextProv,
      baseUrl: nextProv === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : nextProv === 'volcengine_asr'
          ? 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
          : nextProv === 'volcengine_tts'
            ? 'https://voice.cn-beijing.volces.com/api/v3/text-to-speech'
            : (prev.baseUrl && !prev.baseUrl.includes('bytedance') && !prev.baseUrl.includes('googleapis') && !prev.baseUrl.includes('text-to-speech'))
              ? prev.baseUrl
              : '',
      volcAuthMode: nextProv === 'volcengine_tts' ? 'apiKey' : prev.volcAuthMode,
      resourceId: nextProv === 'volcengine_asr'
        ? 'volc.seedasr.auc'
        : nextProv === 'volcengine_tts'
          ? 'doubao-seed-tts-3.0'
          : '',
      defaultVoice: nextProv === 'volcengine_tts'
        ? 'multi_female_tuanzi_v3_uranus_bigtts'
        : nextProv === 'gemini'
          ? 'Kore'
          : '',
    }));
  };

  const handleSaveProvider = async () => {
    setEditorError('');
    const isEdit = Boolean(draft.id);
    const isVolc = draft.provider === 'volcengine_asr' || draft.provider === 'volcengine_tts';
    const cleanLabel = draft.label.trim()
      || (draft.baseUrl.trim() ? extractHostFromUrl(draft.baseUrl.trim()) : '')
      || PROTOCOL_LABELS[draft.provider]
      || '自定义 Provider';

    if (draft.provider === 'openai_compat' && !draft.baseUrl.trim()) {
      setEditorError('请填写接口地址（Base URL），例如 https://ark.cn-beijing.volces.com/api/v3');
      return;
    }

    if (!isEdit) {
      if (isVolc && draft.volcAuthMode === 'appToken') {
        if (!draft.appId.trim() || !draft.accessToken.trim()) {
          setEditorError('请同时填写 AppID 和 Access Token');
          return;
        }
      } else if (!draft.apiKey.trim()) {
        setEditorError('请填写 API Key（加密保存，不会明文返回）');
        return;
      }
    }

    setSavingEditor(true);
    try {
      const payload: Record<string, any> = {
        id: draft.id || '',
        provider: draft.provider,
        label: cleanLabel,
        baseUrl: draft.baseUrl.trim(),
        defaultModel: draft.defaultModel.trim(),
        defaultVoice: draft.provider === 'volcengine_asr' ? '' : draft.defaultVoice.trim(),
        resourceId: draft.resourceId.trim(),
        active: true,
      };
      if (isVolc && draft.volcAuthMode === 'appToken') {
        payload.apiKey = '';
        if (draft.appId.trim()) payload.appId = draft.appId.trim();
        if (draft.accessToken.trim()) payload.accessToken = draft.accessToken.trim();
      } else if (isVolc) {
        if (draft.apiKey.trim()) {
          payload.apiKey = draft.apiKey.trim();
          payload.appId = '';
          payload.accessToken = '';
        }
      } else if (draft.apiKey.trim()) {
        payload.apiKey = draft.apiKey.trim();
      }

      const res = await apiCall('/api/voice/credentials', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.credential) {
        setEditorError(data?.error || '保存失败，请检查地址和密钥');
        return;
      }

      let latestCfg: VoiceConfigState = data.config ? { ...config, ...data.config } : config;
      const savedCred: PublicCredential = data.credential;
      let pairedTtsCred: PublicCredential | null = null;

      if (!isEdit && draft.provider === 'volcengine_asr' && draft.alsoCreateTts) {
        const baseName = cleanLabel.replace(/\(ASR\)|听写|识别/gi, '').trim() || '火山豆包';
        const ttsRes = await apiCall('/api/voice/credentials', {
          method: 'POST',
          body: JSON.stringify({
            provider: 'volcengine_tts',
            label: `${baseName}播报`,
            baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
            cloneSecretFromCredId: savedCred.id,
            resourceId: draft.pairedTtsResourceId.trim() || 'seed-tts-2.0',
            defaultVoice: draft.pairedTtsVoice.trim() || 'zh_female_vv_uranus_bigtts',
            active: true,
          }),
        });
        const ttsData = await ttsRes.json().catch(() => null);
        if (ttsRes.ok && ttsData?.ok && ttsData.credential) {
          pairedTtsCred = ttsData.credential;
          if (ttsData.config) latestCfg = { ...latestCfg, ...ttsData.config };
        }
      }

      onConfigChange(latestCfg);
      setViewMode(returnView);

      const curRoles = getCredentialActiveRoles(savedCred.id, latestCfg.activeProfile, latestCfg.credentials);
      if (draft.setAsDefault) {
        const nextSel = computeSmartDefaultSelection(
          savedCred,
          {
            sttVal: getStageSelectValue(latestCfg.activeProfile?.stt, latestCfg.credentials),
            brainVal: getStageSelectValue(latestCfg.activeProfile?.brain, latestCfg.credentials),
            ttsVal: getStageSelectValue(latestCfg.activeProfile?.tts, latestCfg.credentials),
          },
          pairedTtsCred,
        );
        await persistRouting(
          nextSel.sttVal,
          nextSel.brainVal,
          nextSel.ttsVal,
          latestCfg,
          pairedTtsCred
            ? `已添加「${savedCred.label}」与播报并设为默认`
            : `已保存「${savedCred.label}」并设为默认`,
        );
      } else if (isEdit && curRoles.length > 0) {
        await persistRouting(
          getStageSelectValue(latestCfg.activeProfile?.stt, latestCfg.credentials),
          getStageSelectValue(latestCfg.activeProfile?.brain, latestCfg.credentials),
          getStageSelectValue(latestCfg.activeProfile?.tts, latestCfg.credentials),
          latestCfg,
          `已更新「${savedCred.label}」`,
        );
      }

      toast(isEdit ? `已更新「${savedCred.label}」` : `已添加「${savedCred.label}」`);
    } catch (err: any) {
      setEditorError(err?.message || '网络异常，请重试');
    } finally {
      setSavingEditor(false);
    }
  };

  const isVolcTts3Draft = draft.provider === 'volcengine_tts'
    && (/3\.0/i.test(draft.resourceId) || /voice\.cn-beijing\.volces\.com|text-to-speech/i.test(draft.baseUrl));
  const voiceChips = isVolcTts3Draft
    ? [{ label: '团子 3.0 女声', value: 'multi_female_tuanzi_v3_uranus_bigtts' }]
    : (TTS_VOICE_OPTIONS[draft.provider as keyof typeof TTS_VOICE_OPTIONS] || []);
  const isVolcDraft = draft.provider === 'volcengine_asr' || draft.provider === 'volcengine_tts';
  const compactSummary = formatVoiceCompactValue(config);

  const rawChatSttTarget = String(config.prefs.chatSttTarget || 'native');
  const rawChatTtsTarget = String(config.prefs.chatTtsTarget || 'native');
  const chatSttTargetVal =
    rawChatSttTarget === 'follow_walk'
      ? (sttVal.startsWith('cred:') ? sttVal : 'native')
      : rawChatSttTarget;
  const chatTtsTargetVal =
    rawChatTtsTarget === 'follow_walk'
      ? (ttsVal.startsWith('cred:') ? ttsVal : 'native')
      : rawChatTtsTarget;
  const navTitle =
    viewMode === 'editor'
      ? (draft.id ? '编辑 Provider' : '添加 Provider')
      : viewMode === 'models'
        ? 'AI 模型与供应商'
        : viewMode === 'chat'
          ? '聊天语音'
          : '边走边听 (Beta)';
  const showBackBtn = viewMode === 'editor' || (viewMode === 'models' && returnView !== 'models');
  const sheetPanelRef = useRef<HTMLDivElement | null>(null);
  const swipeRef = useRef<{
    tracking: boolean;
    decided: boolean | null;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    startedAt: number;
    width: number;
  }>({ tracking: false, decided: null, startX: 0, startY: 0, lastX: 0, lastY: 0, startedAt: 0, width: 375 });

  const handleVoiceSheetBackAction = () => {
    if (showBackBtn) {
      setEditorError('');
      if (viewMode === 'editor') {
        setViewMode(returnView);
      } else {
        const target = returnView;
        setReturnView(target);
        setViewMode(target);
      }
      return;
    }
    onClose();
  };

  const resetVoiceSheetTransform = () => {
    const el = sheetPanelRef.current;
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
    el.style.willChange = '';
  };

  const onVoiceSheetTouchStart = (event: any) => {
    if (!event?.touches || event.touches.length !== 1) return;
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('textarea, input, select, [data-no-back-swipe]')) {
      return;
    }
    const el = sheetPanelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = el.offsetWidth || rect.width || window.innerWidth || 375;
    const touch = event.touches[0];
    const startRelX = touch.clientX - rect.left;
    // Left-edge swipe-back zone (matches chat & settings subpage feel)
    const maxZone = Math.min(Math.max(56, width * 0.24), 104);
    if (startRelX < 0 || startRelX > maxZone) return;
    swipeRef.current = {
      tracking: true,
      decided: null,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      startedAt: Date.now(),
      width,
    };
  };

  const onVoiceSheetTouchMove = (event: any) => {
    const sw = swipeRef.current;
    if (!sw.tracking) return;
    if (!event?.touches || event.touches.length !== 1) {
      sw.tracking = false;
      sw.decided = null;
      resetVoiceSheetTransform();
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - sw.startX;
    const dy = touch.clientY - sw.startY;
    sw.lastX = touch.clientX;
    sw.lastY = touch.clientY;
    if (sw.decided === null) {
      if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
      if (Date.now() - sw.startedAt > 400 || dx <= -8 || (Math.abs(dy) >= 12 && Math.abs(dy) > Math.abs(dx) * 1.12)) {
        sw.tracking = false;
        return;
      }
      if (dx >= 10 && dx >= Math.abs(dy) * 1.1) {
        sw.decided = true;
        if (sheetPanelRef.current) {
          sheetPanelRef.current.style.transition = 'none';
          sheetPanelRef.current.style.willChange = 'transform';
        }
      } else if (Math.hypot(dx, dy) > 26) {
        sw.tracking = false;
        return;
      } else {
        return;
      }
    }
    const clampedX = Math.max(0, Math.min(dx, sw.width));
    if (event.cancelable) event.preventDefault();
    if (sheetPanelRef.current) {
      sheetPanelRef.current.style.transform = `translate3d(${clampedX}px, 0, 0)`;
    }
  };

  const onVoiceSheetTouchEnd = () => {
    const sw = swipeRef.current;
    if (!sw.tracking) return;
    sw.tracking = false;
    const wasDecided = sw.decided === true;
    sw.decided = null;
    if (!wasDecided) return;
    const effDx = Math.max(0, sw.lastX - sw.startX);
    const absDy = Math.abs(sw.lastY - sw.startY);
    const durationMs = Math.max(1, Date.now() - sw.startedAt);
    const velocity = effDx / durationMs;
    const distThreshold = Math.min(Math.max(60, sw.width * 0.17), 115);
    const dismiss = absDy <= effDx * 1.15 && (effDx >= distThreshold || (effDx >= 30 && velocity >= 0.3));
    const el = sheetPanelRef.current;
    if (dismiss) {
      if (el) {
        el.style.transition = 'transform 0.14s cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = `translate3d(${sw.width}px, 0, 0)`;
      }
      setTimeout(() => {
        resetVoiceSheetTransform();
        handleVoiceSheetBackAction();
      }, 145);
    } else if (el) {
      el.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
      el.style.transform = 'translate3d(0px, 0, 0)';
      setTimeout(resetVoiceSheetTransform, 230);
    }
  };

  return (
    <div
      id="voiceLabSheet"
      class="sheet-backdrop open voice-lab-backdrop"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetPanelRef}
        class="sheet-panel voice-lab-panel vp-ios-sheet"
        onTouchStart={onVoiceSheetTouchStart}
        onTouchMove={onVoiceSheetTouchMove}
        onTouchEnd={onVoiceSheetTouchEnd}
        onTouchCancel={onVoiceSheetTouchEnd}
      >
        <div class="sheet-handle"></div>

        {/* 顶部栏：Apple 极简导航栏 */}
        <div class="vp-sheet-nav">
          <div class="vp-sheet-nav-left">
            {showBackBtn && (
              <button
                type="button"
                class="vp-nav-back"
                id="vpBackToListBtn"
                onClick={() => {
                  setEditorError('');
                  if (viewMode === 'editor') {
                    setViewMode(returnView);
                  } else {
                    const target = returnView;
                    setReturnView(target);
                    setViewMode(target);
                  }
                }}
              >
                <BackChevronSvg />
                <span>返回</span>
              </button>
            )}
          </div>
          <div class="vp-sheet-nav-title">{navTitle}</div>
          <div class="vp-sheet-nav-right">
            <button
              type="button"
              class="vp-nav-close"
              aria-label="关闭语音配置"
              onClick={onClose}
            >
              <CloseSvg />
            </button>
          </div>
        </div>

        {viewMode === 'models' ? (
          /* 视图 A：全局 AI 模型与供应商池（底座资源层，全 App 任何 AI 功能共用） */
          <div class="voice-lab-body vp-ios-body" id="aiModelsPoolView">
            {loadingCfg && <div class="vp-subtle-note">正在读取配置…</div>}
            <div class="vp-subtle-note" style="margin-bottom:4px;">
              全局共用一套供应商密钥池，下方不同 AI 功能按需独立调用，无需重复填写 Key
            </div>

            {routingMsg && (
              <div
                id="vpHeroStatusBanner"
                class={`vp-inline-notice ${routingMsg.ok ? 'ok' : 'err'}`}
                style="margin-bottom:10px;"
                onClick={() => setRoutingMsg(null)}
              >
                {routingMsg.text}
              </div>
            )}

            <div class="vp-sec-head" id="voiceProviderListHeader">
              <span class="vp-sec-label">{`Provider 列表 (${creds.length})`}</span>
              <button
                type="button"
                id="voiceAddProviderBtn"
                class="vp-sec-add-btn"
                onClick={openAddEditor}
              >
                <PlusSvg />
                <span>添加</span>
              </button>
            </div>

            <div class="vp-ios-card" id="voiceProviderListSection">
              {creds.length === 0 ? (
                <div class="vp-ios-empty">
                  <div class="vp-empty-title">暂未添加 Provider</div>
                  <div class="vp-empty-desc">
                    统一支持 OpenAI 兼容接口（火山方舟、DeepSeek、OpenAI、中转站、Ollama）及原生语音接口
                  </div>
                  <button
                    type="button"
                    class="vp-btn-primary"
                    style="margin-top:12px;padding:8px 18px;"
                    onClick={openAddEditor}
                  >
                    添加 Provider
                  </button>
                </div>
              ) : (
                creds.map(cred => {
                  const roles = getCredentialActiveRoles(cred.id, activeProf, creds);
                  const usages = getCredentialFeatureUsages(cred.id, activeProf, config.prefs, creds);
                  const host = extractHostFromUrl(cred.baseUrl);
                  const modelOrRes = cred.defaultModel || cred.resourceId || '';
                  const testRes = testResults[cred.id];
                  const isPrimaryDefault = (cred.provider === 'gemini' && roles.length === 3)
                    || (cred.provider === 'volcengine_asr' && roles.includes('stt'))
                    || (cred.provider === 'volcengine_tts' && roles.includes('tts'))
                    || (cred.provider === 'openai_compat' && roles.includes('brain'));

                  return (
                    <div key={cred.id} class="vp-ios-item">
                      <div class="vp-ios-item-top">
                        <div class="vp-ios-item-title-wrap">
                          <span class="vp-ios-item-name">{cred.label}</span>
                          <span class="vp-proto-chip">
                            {PROTOCOL_LABELS[cred.provider as keyof typeof PROTOCOL_LABELS] || cred.provider}
                          </span>
                        </div>
                        {usages.length > 0 && (
                          <div class="vp-role-badges">
                            {usages.map(u => (
                              <span key={u.key} class={`vp-role-pill ${u.tone}`}>{u.label}</span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div class="vp-ios-item-meta">
                        {[
                          host,
                          modelOrRes,
                          cred.defaultVoice && cred.provider !== 'volcengine_asr' ? cred.defaultVoice : '',
                          cred.authSummary,
                        ].filter(Boolean).join(' · ')}
                      </div>

                      {testRes && (
                        <div class={`vp-inline-notice ${testRes.ok ? 'ok' : 'err'}`} style="margin-top:6px;">
                          {testRes.summary}
                        </div>
                      )}

                      <div class="vp-ios-item-actions">
                        <button
                          type="button"
                          class={`vp-text-act ${isPrimaryDefault ? 'muted' : 'primary'}`}
                          disabled={routingSaving}
                          onClick={() => void handleSetProviderDefault(cred)}
                        >
                          {isPrimaryDefault ? '已用于随行' : '设为随行默认'}
                        </button>
                        <button
                          type="button"
                          class="vp-text-act"
                          disabled={testingCredId === cred.id}
                          onClick={() => void handleTestProvider(cred.id)}
                        >
                          {testingCredId === cred.id ? '测试中…' : '测试'}
                        </button>
                        <button
                          type="button"
                          class="vp-text-act"
                          onClick={() => openEditEditor(cred)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          class="vp-text-act danger"
                          onClick={() => void handleDeleteProvider(cred)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : viewMode === 'chat' ? (
          /* 视图 B：聊天语音独立配置（按需从全局模型池挑选，与边走边听彻底解耦） */
          <div class="voice-lab-body vp-ios-body" id="chatVoiceSettingsView">
            {loadingCfg && <div class="vp-subtle-note">正在读取配置…</div>}
            <div class="vp-subtle-note" style="margin-bottom:4px;">
              聊天输入框语音听写与消息朗读可独立选用模型，与「边走边听 (Beta)」互不影响
            </div>

            <div class="vp-sec-head">
              <span class="vp-sec-label">本功能调用的模型</span>
              <button
                type="button"
                class="vp-sec-link"
                onClick={() => openModelsPoolFromFeature('chat')}
              >
                管理模型池 ›
              </button>
            </div>
            <div class="vp-ios-card">
              <div class="vp-select-row">
                <span class="vp-select-label">语音输入（听写）</span>
                <select
                  id="chatVoiceSttSelect"
                  class="vp-select-ctrl"
                  value={chatSttTargetVal}
                  onChange={(e: any) => void onUpdatePrefs({ chatSttTarget: e.target.value })}
                >
                  <option value="native">手机自带免费</option>
                  {sttCreds.map(c => (
                    <option key={c.id} value={`cred:${c.id}`}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div class="vp-select-row">
                <span class="vp-select-label">消息朗读（播报）</span>
                <select
                  id="chatVoiceTtsSelect"
                  class="vp-select-ctrl"
                  value={chatTtsTargetVal}
                  onChange={(e: any) => void onUpdatePrefs({ chatTtsTarget: e.target.value })}
                >
                  <option value="native">手机自带免费</option>
                  {ttsCreds.map(c => (
                    <option key={c.id} value={`cred:${c.id}`}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div class="vp-ios-card" style="padding:12px 14px;margin-top:12px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                <span style="font-size:13px;font-weight:600;color:var(--text);">快速测试聊天朗读</span>
                <button
                  type="button"
                  id="chatVoiceTestTtsBtn"
                  class="vp-btn-ghost"
                  disabled={chatTestingTts}
                  onClick={() => void handleTestChatTts()}
                >
                  {chatTestingTts ? '试音中…' : '试听聊天朗读'}
                </button>
              </div>
              {chatTtsMsg && (
                <div
                  class={`vp-inline-notice ${chatTtsMsg.ok ? 'ok' : 'err'}`}
                  style="margin-top:8px;"
                  onClick={() => setChatTtsMsg(null)}
                >
                  {chatTtsMsg.text}
                </div>
              )}
            </div>
          </div>
        ) : viewMode === 'walk' ? (
          /* 视图 C：边走边听功能独立配置（专注模型选型 + 播报与语音行为 + 延迟压测） */
          <div class="voice-lab-body vp-ios-body" id="walkModeSettingsView">
            {loadingCfg && <div class="vp-subtle-note">正在读取配置…</div>}

            {/* 1. 当前方案 + 进入随行 / 试听 */}
            <div class="vp-ios-card vp-hero-card">
              <div class="vp-hero-row">
                <div class="vp-hero-info">
                  <div class="vp-hero-k">当前生效</div>
                  <div class="vp-hero-v">{compactSummary}</div>
                </div>
                <div class="vp-hero-actions">
                  <button
                    type="button"
                    class="vp-btn-primary"
                    id="vpOpenWalkModeBtn"
                    onClick={() => {
                      onClose();
                      (window as any).openWalkMode?.();
                    }}
                  >
                    进入随行
                  </button>
                  <button
                    type="button"
                    class="vp-btn-ghost"
                    disabled={soundChecking}
                    onClick={() => {
                      setRoutingMsg(null);
                      onUnlockAudio?.();
                      void onSoundCheck();
                    }}
                  >
                    {soundChecking ? '试音中…' : '试听'}
                  </button>
                </div>
              </div>

              {missingStages.length > 0 && (
                <button
                  type="button"
                  class="vp-alert-banner"
                  onClick={openAddEditor}
                >
                  <span>{`${missingStages.join(' / ')} 密钥缺失`}</span>
                  <span>去添加 ›</span>
                </button>
              )}

              {(soundCheckMsg || routingMsg) && (
                <div
                  id="vpHeroStatusBanner"
                  class={`vp-inline-notice ${(soundCheckMsg || routingMsg)!.ok ? 'ok' : 'err'}`}
                  onClick={() => {
                    setRoutingMsg(null);
                    onClearSoundCheckMsg();
                  }}
                >
                  {(soundCheckMsg || routingMsg)!.text}
                </div>
              )}
            </div>

            {/* 2. 本功能调用的模型（从全局模型池按需挑选） */}
            <div class="vp-sec-head">
              <span class="vp-sec-label">本功能调用的模型</span>
              <div style="display:inline-flex;align-items:center;gap:10px;">
                {activeProf.id !== 'native' && (
                  <button
                    type="button"
                    class="vp-sec-link"
                    disabled={routingSaving}
                    onClick={() => void persistRouting('native', 'native', 'native')}
                  >
                    恢复免费本机
                  </button>
                )}
                <button
                  type="button"
                  id="walkManageModelsPoolBtn"
                  class="vp-sec-link"
                  onClick={() => openModelsPoolFromFeature('walk')}
                >
                  管理模型池 ›
                </button>
              </div>
            </div>
            <div class="vp-ios-card">
              <div class="vp-select-row">
                <span class="vp-select-label">听写</span>
                <select
                  id="voiceStageSttSelect"
                  class="vp-select-ctrl"
                  disabled={routingSaving}
                  value={sttVal}
                  onChange={(e: any) => handleStageChange('stt', e.target.value)}
                >
                  <option value="native">手机自带免费</option>
                  {sttVal.startsWith('missing:') && (
                    <option value={sttVal}>密钥缺失</option>
                  )}
                  {sttCreds.map(c => (
                    <option key={c.id} value={`cred:${c.id}`}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>

              <div class="vp-select-row">
                <span class="vp-select-label">大脑</span>
                <select
                  id="voiceStageBrainSelect"
                  class="vp-select-ctrl"
                  disabled={routingSaving}
                  value={brainVal}
                  onChange={(e: any) => handleStageChange('brain', e.target.value)}
                >
                  <option value="native">本地基础口令</option>
                  {brainVal.startsWith('missing:') && (
                    <option value={brainVal}>密钥缺失</option>
                  )}
                  {brainCreds.map(c => (
                    <option key={c.id} value={`cred:${c.id}`}>
                      {c.label} ({c.defaultModel || inferDefaultBrainModel(c)})
                    </option>
                  ))}
                </select>
              </div>

              <div class="vp-select-row">
                <span class="vp-select-label">播报</span>
                <select
                  id="voiceStageTtsSelect"
                  class="vp-select-ctrl"
                  disabled={routingSaving}
                  value={ttsVal}
                  onChange={(e: any) => handleStageChange('tts', e.target.value)}
                >
                  <option value="native">手机自带免费</option>
                  {ttsVal.startsWith('missing:') && (
                    <option value={ttsVal}>密钥缺失</option>
                  )}
                  {ttsCreds.map(c => (
                    <option key={c.id} value={`cred:${c.id}`}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 3. 播报与交互行为 */}
            <div class="vp-sec-head">
              <span class="vp-sec-label">播报与交互行为</span>
            </div>
            <div class="vp-ios-card">
              <div class="vp-select-row">
                <span class="vp-select-label">主动播报</span>
                <select
                  class="vp-select-ctrl"
                  value={config.prefs.proactiveBriefing}
                  onChange={(e: any) => void onUpdatePrefs({ proactiveBriefing: e.target.value })}
                >
                  <option value="approvals">仅审批提醒</option>
                  <option value="all">审批与完成</option>
                  <option value="manual">仅手动播报</option>
                </select>
              </div>

              <div class="vp-select-row">
                <span class="vp-select-label">播报详略</span>
                <select
                  class="vp-select-ctrl"
                  value={config.prefs.briefingDetail || 'detailed'}
                  onChange={(e: any) => void onUpdatePrefs({ briefingDetail: e.target.value })}
                >
                  <option value="detailed">详细要点</option>
                  <option value="verbatim">原文精读</option>
                  <option value="concise">极简一句</option>
                </select>
              </div>

              <div class="vp-select-row">
                <span class="vp-select-label">高危操作确认</span>
                <select
                  class="vp-select-ctrl"
                  value={config.prefs.l2Policy}
                  onChange={(e: any) => void onUpdatePrefs({ l2Policy: e.target.value })}
                >
                  <option value="pin">念 3 位确认码</option>
                  <option value="screen_only">仅点手机屏幕</option>
                </select>
              </div>

              <div class="vp-switch-row">
                <div>
                  <div class="vp-switch-title">播报后自动开麦</div>
                  <div class="vp-switch-sub">念完选项后自动听 5.5 秒</div>
                </div>
                <input
                  type="checkbox"
                  class="voice-switch"
                  checked={config.prefs.autoListenAfterBriefing}
                  onChange={(e: any) => void onUpdatePrefs({ autoListenAfterBriefing: e.target.checked })}
                />
              </div>

              <div class="vp-switch-row">
                <div>
                  <div class="vp-switch-title">听歌时压低背景音乐</div>
                  <div class="vp-switch-sub">播报时自动降低音量，说完恢复</div>
                </div>
                <input
                  type="checkbox"
                  class="voice-switch"
                  checked={config.prefs.duckMusicMode}
                  onChange={(e: any) => void onUpdatePrefs({ duckMusicMode: e.target.checked })}
                />
              </div>
            </div>

            {/* 4. 高级与延迟压测 */}
            <details
              class="vp-ios-details"
              open={geekOpen}
              onToggle={(e: any) => setGeekOpen(Boolean(e.currentTarget?.open))}
            >
              <summary>高级选项与延迟压测</summary>
              <div class="vp-ios-card" style="margin-top:8px;">
                <div class="vp-bench-block">
                  <div class="vp-switch-row" style="padding:0 0 8px;border:none;">
                    <div>
                      <div class="vp-switch-title">安全试跑压测（不操作电脑）</div>
                    </div>
                    <input
                      type="checkbox"
                      class="voice-switch"
                      checked={benchDryRun}
                      onChange={(e: any) => onSetBenchDryRun(e.target.checked)}
                    />
                  </div>
                  <input
                    class="vp-input"
                    value={benchText}
                    onInput={(e: any) => onSetBenchText(e.target.value)}
                    placeholder="输入一句测试口令…"
                  />
                  <div style="display:flex;gap:8px;margin-top:8px;">
                    <button
                      type="button"
                      class="vp-btn-primary"
                      style="flex:1;"
                      disabled={benchRunning}
                      onClick={() => void onRunBenchTurn()}
                    >
                      {benchRunning ? '测速中…' : '跑一轮压测'}
                    </button>
                    <button
                      type="button"
                      class={`vp-btn-ghost ${benchRecording ? 'danger' : ''}`}
                      disabled={benchRunning}
                      onClick={() => void onToggleBenchVoice()}
                    >
                      {benchRecording ? '停止' : '录真声'}
                    </button>
                  </div>
                  {benchReport && (
                    <div style="margin-top:10px;">
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
                        <div class="vp-inline-notice err" style="margin-top:6px;">
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
        ) : (
          /* DSH 风格：统一协议标准表单（零品牌墙、直接开填） */
          <div class="voice-lab-body vp-ios-body" id="voiceProviderEditor">
            <div class="vp-ios-card vp-form-card">
              <div class="vp-field">
                <label class="vp-field-label" for="vpProviderTypeSelect">对接协议</label>
                <select
                  id="vpProviderTypeSelect"
                  class="vp-input"
                  disabled={Boolean(draft.id)}
                  value={draft.provider}
                  onChange={(e: any) => handleProtocolChange(e.target.value)}
                >
                  <option value="openai_compat">OpenAI 兼容（标准）</option>
                  <option value="gemini">Google Gemini 原生</option>
                  <option value="volcengine_asr">火山豆包听写（ASR）</option>
                  <option value="volcengine_tts">火山豆包播报（TTS）</option>
                </select>
                {draft.provider === 'openai_compat' && (
                  <div class="vp-field-hint">
                    火山方舟、DeepSeek、OpenAI、智谱、硅基流动、OpenRouter、中转站、Ollama 均走此标准协议
                  </div>
                )}
              </div>

              <div class="vp-field">
                <label class="vp-field-label" for="vpLabelInput">名称</label>
                <input
                  id="vpLabelInput"
                  class="vp-input"
                  value={draft.label}
                  placeholder="如：火山方舟 / DeepSeek / 我的中转"
                  onInput={(e: any) => setDraft({ ...draft, label: e.target.value })}
                />
              </div>

              {!isVolcDraft && (
                <div class="vp-field">
                  <label class="vp-field-label" for="vpBaseUrlInput">接口地址 (Base URL)</label>
                  <input
                    id="vpBaseUrlInput"
                    class="vp-input"
                    value={draft.baseUrl}
                    placeholder={
                      draft.provider === 'gemini'
                        ? 'https://generativelanguage.googleapis.com/v1beta'
                        : 'https://api.example.com/v1'
                    }
                    onInput={(e: any) => {
                      setDraftTestRes(null);
                      setDraft({ ...draft, baseUrl: e.target.value });
                    }}
                  />
                  {draft.provider === 'openai_compat' && /openspeech\.bytedance\.com/i.test(draft.baseUrl) && (
                    <div class="vp-field-warn">
                      这是火山专有语音地址，请在上方「对接协议」切换为「火山豆包听写 (ASR)」或「火山豆包播报 (TTS)」
                    </div>
                  )}
                  {draft.baseUrl.trim() && !/^https?:\/\//i.test(draft.baseUrl.trim()) && (
                    <div class="vp-field-warn">
                      接口地址请以 https:// 或 http:// 开头
                    </div>
                  )}
                </div>
              )}

              {draft.provider === 'volcengine_tts' && (
                <div class="vp-field">
                  <label class="vp-field-label">接口版本</label>
                  <div class="vp-seg-pair">
                    <button
                      type="button"
                      id="vpVolcTtsV3Btn"
                      class={`vp-seg-opt ${isVolcTts3Draft ? 'active' : ''}`}
                      onClick={() => {
                        setDraftTestRes(null);
                        setDraft(prev => ({
                          ...prev,
                          volcAuthMode: 'apiKey',
                          baseUrl: 'https://voice.cn-beijing.volces.com/api/v3/text-to-speech',
                          resourceId: 'doubao-seed-tts-3.0',
                          defaultVoice: !prev.defaultVoice || prev.defaultVoice.startsWith('zh_')
                            ? 'multi_female_tuanzi_v3_uranus_bigtts'
                            : prev.defaultVoice,
                        }));
                      }}
                    >
                      3.0 新版（仅 API Key）
                    </button>
                    <button
                      type="button"
                      id="vpVolcTtsV2Btn"
                      class={`vp-seg-opt ${!isVolcTts3Draft ? 'active' : ''}`}
                      onClick={() => {
                        setDraftTestRes(null);
                        setDraft(prev => ({
                          ...prev,
                          baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
                          resourceId: 'seed-tts-2.0',
                          defaultVoice: !prev.defaultVoice || prev.defaultVoice.includes('_v3_')
                            ? 'zh_female_vv_uranus_bigtts'
                            : prev.defaultVoice,
                        }));
                      }}
                    >
                      2.0 经典版（Seed-TTS）
                    </button>
                  </div>
                </div>
              )}

              <div class="vp-field">
                <label class="vp-field-label" for="vpApiKeyInput">
                  {isVolcDraft && !isVolcTts3Draft ? '鉴权密钥' : 'API Key'}
                </label>

                {draft.id && editingCredSummary && (
                  <div class="vp-saved-key-note">
                    {`已加密保存 (${editingCredSummary}) · 留空保持原密钥`}
                  </div>
                )}

                {isVolcDraft && isVolcTts3Draft && (
                  <div class="vp-field-hint" style="margin-top:0;margin-bottom:6px;">
                    火山「语音合成 3.0」只需填写新版控制台的一把 API Key（X-Api-Key），无需 AppID
                  </div>
                )}

                {isVolcDraft && !isVolcTts3Draft && (
                  <Fragment>
                    <div class="vp-field-hint" style="margin-top:0;margin-bottom:6px;">
                      填火山「语音技术」密钥（非火山方舟大模型密钥）；填完可先点下方「测试连通」确认权限
                    </div>
                    <div class="vp-seg-pair">
                      <button
                        type="button"
                        class={`vp-seg-opt ${draft.volcAuthMode === 'apiKey' ? 'active' : ''}`}
                        onClick={() => setDraft({ ...draft, volcAuthMode: 'apiKey' })}
                      >
                        API Key
                      </button>
                      <button
                        type="button"
                        class={`vp-seg-opt ${draft.volcAuthMode === 'appToken' ? 'active' : ''}`}
                        onClick={() => setDraft({ ...draft, volcAuthMode: 'appToken' })}
                      >
                        AppID + Token
                      </button>
                    </div>
                  </Fragment>
                )}

                {isVolcDraft && !isVolcTts3Draft && draft.volcAuthMode === 'appToken' ? (
                  <div class="voice-two-col">
                    <input
                      class="vp-input"
                      value={draft.appId}
                      placeholder="AppID"
                      onInput={(e: any) => setDraft({ ...draft, appId: e.target.value })}
                    />
                    <input
                      type="password"
                      class="vp-input"
                      value={draft.accessToken}
                      placeholder={draft.id ? '留空沿用原 Token' : 'Access Token'}
                      onInput={(e: any) => setDraft({ ...draft, accessToken: e.target.value })}
                    />
                  </div>
                ) : (
                  <input
                    id="vpApiKeyInput"
                    type="password"
                    class="vp-input"
                    value={draft.apiKey}
                    placeholder={draft.id ? '留空保持原密钥，或粘贴新 Key 替换' : '粘贴 API Key（加密保存）'}
                    onInput={(e: any) => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                )}
              </div>

              {!isVolcDraft ? (
                <div class="vp-field">
                  <label class="vp-field-label" for="vpDefaultModelInput">模型 ID</label>
                  <input
                    id="vpDefaultModelInput"
                    class="vp-input"
                    value={draft.defaultModel}
                    placeholder={
                      draft.provider === 'gemini'
                        ? '如：gemini-2.5-flash'
                        : '如：doubao-seed-2-0-lite-260215 / deepseek-chat'
                    }
                    onInput={(e: any) => setDraft({ ...draft, defaultModel: e.target.value })}
                  />
                </div>
              ) : (
                <div class="vp-field">
                  <label class="vp-field-label" for="vpResourceIdInput">
                    {isVolcTts3Draft ? 'Model ID' : 'Resource ID'}
                  </label>
                  <input
                    id="vpResourceIdInput"
                    class="vp-input"
                    value={draft.resourceId}
                    placeholder={
                      draft.provider === 'volcengine_asr'
                        ? 'volc.seedasr.auc 或 volc.bigasr.auc_turbo'
                        : isVolcTts3Draft
                          ? 'doubao-seed-tts-3.0'
                          : 'seed-tts-2.0'
                    }
                    onInput={(e: any) => {
                      setDraftTestRes(null);
                      setDraft({ ...draft, resourceId: e.target.value });
                    }}
                  />
                  {draft.provider === 'volcengine_tts' && !isVolcTts3Draft && (
                    <div class="voice-chip-row" style="margin-top:6px;">
                      {[
                        { label: '2.0 标准 (seed-tts-2.0)', value: 'seed-tts-2.0' },
                        { label: '1.0 兼容 (10029)', value: 'volc.service_type.10029' },
                      ].map(item => (
                        <button
                          key={item.value}
                          type="button"
                          class={`voice-quick-chip ${draft.resourceId === item.value ? 'active' : ''}`}
                          onClick={() => {
                            setDraftTestRes(null);
                            setDraft({ ...draft, resourceId: item.value });
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                  {draft.provider === 'volcengine_asr' && (
                    <Fragment>
                      {/doubao_|\d{12,}/i.test(draft.resourceId) && (
                        <div class="vp-field-warn">
                          这看起来是控制台的「实例 ID」，不是 Resource ID：2.0 标准版请点下方「2.0 标准版」，极速版请点「极速版」
                        </div>
                      )}
                      <div class="voice-chip-row" style="margin-top:6px;">
                        {[
                          { label: '2.0 标准版 (volc.seedasr.auc)', value: 'volc.seedasr.auc' },
                          { label: '极速版 (volc.bigasr.auc_turbo)', value: 'volc.bigasr.auc_turbo' },
                          { label: '1.0 标准版 (volc.bigasr.auc)', value: 'volc.bigasr.auc' },
                        ].map(item => (
                          <button
                            key={item.value}
                            type="button"
                            class={`voice-quick-chip ${draft.resourceId === item.value ? 'active' : ''}`}
                            onClick={() => {
                              setDraftTestRes(null);
                              setDraft({ ...draft, resourceId: item.value });
                            }}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </Fragment>
                  )}
                </div>
              )}

              {(draft.provider === 'volcengine_tts' || draft.provider === 'gemini') && (
                <div class="vp-field">
                  <label class="vp-field-label">播报音色（可选）</label>
                  <input
                    class="vp-input"
                    value={draft.defaultVoice}
                    placeholder={
                      isVolcTts3Draft
                        ? 'multi_female_tuanzi_v3_uranus_bigtts（可在 3.0 音色列表复制）'
                        : draft.provider === 'volcengine_tts'
                          ? 'zh_female_vv_uranus_bigtts'
                          : 'Kore'
                    }
                    onInput={(e: any) => setDraft({ ...draft, defaultVoice: e.target.value })}
                  />
                  {voiceChips.length > 0 && (
                    <div class="voice-chip-row" style="margin-top:6px;">
                      {voiceChips.map(v => (
                        <button
                          key={v.value}
                          type="button"
                          class={`voice-quick-chip ${draft.defaultVoice === v.value ? 'active' : ''}`}
                          onClick={() => setDraft({ ...draft, defaultVoice: v.value })}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div class="vp-ios-card" style="margin-top:12px;">
              {!draft.id && draft.provider === 'volcengine_asr' && (
                <div class="vp-switch-row">
                  <div>
                    <div class="vp-switch-title">同时添加火山播报（TTS）</div>
                    <div class="vp-switch-sub">共用同一把密钥，免填两遍</div>
                  </div>
                  <input
                    type="checkbox"
                    class="voice-switch"
                    checked={draft.alsoCreateTts}
                    onChange={(e: any) => setDraft({ ...draft, alsoCreateTts: Boolean(e.target.checked) })}
                  />
                </div>
              )}

              <div class="vp-switch-row">
                <div>
                  <div class="vp-switch-title">保存后设为默认</div>
                  <div class="vp-switch-sub">
                    {draft.provider === 'gemini'
                      ? '设为听写、大脑、播报默认'
                      : draft.provider === 'volcengine_asr'
                        ? (draft.alsoCreateTts && !draft.id ? '设为听写与播报默认' : '设为听写默认')
                        : draft.provider === 'volcengine_tts'
                          ? '设为播报默认'
                          : '设为大脑默认，列表页可随时调整'}
                  </div>
                </div>
                <input
                  type="checkbox"
                  class="voice-switch"
                  checked={draft.setAsDefault}
                  onChange={(e: any) => setDraft({ ...draft, setAsDefault: Boolean(e.target.checked) })}
                />
              </div>
            </div>

            {draftTestRes && (
              <div
                id="vpDraftTestResult"
                class={`vp-inline-notice ${draftTestRes.ok ? 'ok' : draftTestRes.partialOk ? 'warn' : 'err'}`}
                style="margin-top:10px;"
              >
                <div>{draftTestRes.text}</div>
                {draftTestRes.ttsFailed && draft.alsoCreateTts && !draft.id && (
                  <button
                    type="button"
                    class="vp-inline-fix-btn"
                    onClick={() => {
                      setDraft(prev => ({ ...prev, alsoCreateTts: false }));
                      setDraftTestRes({ ok: true, text: '已关闭「同时添加火山播报」，听写已验证通过，可直接保存（播报将用手机免费语音）' });
                    }}
                  >
                    仅保留听写，播报用手机免费 ›
                  </button>
                )}
              </div>
            )}

            {editorError && (
              <div class="vp-inline-notice err" style="margin-top:10px;">
                {editorError}
              </div>
            )}

            <div class="vp-form-actions">
              <button
                type="button"
                id="vpTestDraftBtn"
                class="vp-test-draft-btn"
                disabled={testingDraft || savingEditor}
                onClick={() => void handleTestDraft()}
              >
                {testingDraft ? '测试中…' : '测试连通'}
              </button>
              <button
                type="button"
                id="vpSaveProviderBtn"
                class="vp-submit-btn"
                style="margin-top:0;flex:1;"
                disabled={savingEditor || testingDraft}
                onClick={() => void handleSaveProvider()}
              >
                {savingEditor ? '正在保存…' : '保存 Provider'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
