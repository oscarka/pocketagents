import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  PROTOCOL_LABELS,
  TTS_VOICE_OPTIONS,
  VOICE_PROVIDER_PRESETS,
  buildRoutingProfilePayload,
  computeSelectionAfterDelete,
  computeSmartDefaultSelection,
  extractHostFromUrl,
  formatVoiceSummaryForSettings,
  getCredentialActiveRoles,
  getStageSelectValue,
  inferDefaultBrainModel,
  providerSupportsStage,
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
  autoVad: boolean;
  vadSilenceMs: number;
  autoListenAfterBriefing: boolean;
  duckMusicMode: boolean;
  useByokForChatStt: boolean;
  useByokForChatTts: boolean;
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
  presetKey: string;
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
  initialView?: 'list' | 'add' | 'bench';
  onConfigChange: (next: VoiceConfigState) => void;
  onUpdatePrefs: (patch: Partial<VoicePrefs>) => Promise<void>;
  onSoundCheck: () => Promise<void>;
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

function makeDraftFromPreset(presetKey = 'deepseek'): ProviderDraft {
  const preset = VOICE_PROVIDER_PRESETS.find(p => p.key === presetKey) || VOICE_PROVIDER_PRESETS[0];
  return {
    id: '',
    presetKey: preset.key,
    provider: preset.provider as ProviderDraft['provider'],
    label: preset.label || '',
    baseUrl: preset.baseUrl || '',
    volcAuthMode: 'apiKey',
    apiKey: '',
    appId: '',
    accessToken: '',
    defaultModel: preset.defaultModel || '',
    defaultVoice: preset.defaultVoice || '',
    resourceId: preset.resourceId || '',
    alsoCreateTts: Boolean((preset as any).alsoCreateTts),
    pairedTtsVoice: 'zh_female_vv_uranus_bigtts',
    pairedTtsResourceId: 'seed-tts-2.0',
    setAsDefault: true,
  };
}

function makeDraftFromCredential(cred: PublicCredential): ProviderDraft {
  return {
    id: cred.id,
    presetKey: 'custom',
    provider: (cred.provider as ProviderDraft['provider']) || 'openai_compat',
    label: cred.label || '',
    baseUrl: cred.baseUrl || '',
    volcAuthMode: 'apiKey',
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

  const [viewMode, setViewMode] = useState<'list' | 'editor'>('list');
  const [draft, setDraft] = useState<ProviderDraft>(() => makeDraftFromPreset('deepseek'));
  const [editingCredSummary, setEditingCredSummary] = useState('');
  const [savingEditor, setSavingEditor] = useState(false);
  const [editorError, setEditorError] = useState('');

  const [routingSaving, setRoutingSaving] = useState(false);
  const [routingMsg, setRoutingMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testingCredId, setTestingCredId] = useState('');
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; summary: string }>>({});
  const [geekOpen, setGeekOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRoutingMsg(null);
    setEditorError('');
    if (initialView === 'add') {
      setDraft(makeDraftFromPreset('deepseek'));
      setEditingCredSummary('');
      setViewMode('editor');
    } else {
      setViewMode('list');
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
        setRoutingMsg({ ok: true, text: successNotice || '✅ 已切换为免费本机语音' });
        return;
      }

      const res = await apiCall('/api/voice/profiles', {
        method: 'POST',
        body: JSON.stringify(plan.profilePayload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.config) {
        const errText = data?.error || '保存默认分配失败';
        setRoutingMsg({ ok: false, text: `❌ ${errText}` });
        toast(`❌ ${errText}`);
        return;
      }
      onConfigChange({ ...latestCfg, ...data.config });
      setRoutingMsg({ ok: true, text: successNotice || `✅ 默认分配已生效：${plan.profilePayload.name}` });
    } catch (err: any) {
      setRoutingMsg({ ok: false, text: `❌ ${err?.message || '保存失败'}` });
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
      `✅ 已将「${cred.label}」设为默认`,
    );
    toast(`✅ 已将「${cred.label}」设为默认`);
  };

  const handleTestProvider = async (credId: string) => {
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
          summary: data?.summary || (data?.ok ? `✅ 连通正常 (${data.latencyMs ?? 0}ms)` : `❌ ${data?.error || '测试失败'}`),
        },
      }));
    } catch (err: any) {
      setTestResults(prev => ({
        ...prev,
        [credId]: { ok: false, summary: `❌ ${err?.message || '网络异常'}` },
      }));
    } finally {
      setTestingCredId('');
    }
  };

  const handleDeleteProvider = async (cred: PublicCredential) => {
    if (!confirm(`确定删除 Provider「${cred.label}」吗？\n删除后如果正在使用它，对应环节会自动回退。`)) {
      return;
    }
    try {
      const res = await apiCall(`/api/voice/credentials/${encodeURIComponent(cred.id)}`, { method: 'DELETE' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.config) {
        toast(`❌ ${data?.error || '删除失败'}`);
        return;
      }
      const nextCfg: VoiceConfigState = { ...config, ...data.config };
      onConfigChange(nextCfg);
      toast(`🗑️ 已删除「${cred.label}」`);

      const fallback = computeSelectionAfterDelete(cred.id, config.activeProfile, nextCfg.credentials);
      if (fallback.affected) {
        await persistRouting(
          fallback.nextSelection.sttVal,
          fallback.nextSelection.brainVal,
          fallback.nextSelection.ttsVal,
          nextCfg,
          `🗑️ 已删除「${cred.label}」，受影响环节已安全回退`,
        );
      }
    } catch (err: any) {
      toast(`❌ 删除失败：${err?.message || '网络异常'}`);
    }
  };

  const openAddEditor = (presetKey = 'deepseek') => {
    setDraft(makeDraftFromPreset(presetKey));
    setEditingCredSummary('');
    setEditorError('');
    setViewMode('editor');
  };

  const openEditEditor = (cred: PublicCredential) => {
    setDraft(makeDraftFromCredential(cred));
    setEditingCredSummary(cred.authSummary || '');
    setEditorError('');
    setViewMode('editor');
  };

  const handleSaveProvider = async () => {
    setEditorError('');
    const isEdit = Boolean(draft.id);
    const isVolc = draft.provider === 'volcengine_asr' || draft.provider === 'volcengine_tts';
    const cleanLabel = draft.label.trim()
      || (draft.baseUrl.trim() ? extractHostFromUrl(draft.baseUrl.trim()) : '')
      || PROTOCOL_LABELS[draft.provider]
      || '自定义 Provider';

    if ((draft.provider === 'openai_compat') && !draft.baseUrl.trim()) {
      setEditorError('请填写接口地址（Base URL），例如 https://api.deepseek.com/v1');
      return;
    }

    if (!isEdit) {
      if (isVolc && draft.volcAuthMode === 'appToken') {
        if (!draft.appId.trim() || !draft.accessToken.trim()) {
          setEditorError('请同时填写火山引擎 AppID 和 Access Token');
          return;
        }
      } else if (!draft.apiKey.trim()) {
        setEditorError('请填写 API Key（会经 AES-256 加密保存，不会明文返回）');
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
        defaultVoice: draft.defaultVoice.trim(),
        resourceId: draft.resourceId.trim(),
        active: true,
      };
      if (isVolc && draft.volcAuthMode === 'appToken') {
        if (draft.appId.trim()) payload.appId = draft.appId.trim();
        if (draft.accessToken.trim()) payload.accessToken = draft.accessToken.trim();
      } else if (draft.apiKey.trim()) {
        payload.apiKey = draft.apiKey.trim();
      }

      const res = await apiCall('/api/voice/credentials', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !data.credential) {
        setEditorError(data?.error || '保存 Provider 失败，请检查地址和密钥');
        return;
      }

      let latestCfg: VoiceConfigState = data.config ? { ...config, ...data.config } : config;
      const savedCred: PublicCredential = data.credential;
      let pairedTtsCred: PublicCredential | null = null;

      // Optional 1-click Volcengine TTS pairing when adding Volcengine ASR
      if (!isEdit && draft.provider === 'volcengine_asr' && draft.alsoCreateTts) {
        const baseName = cleanLabel.replace(/\(ASR\)|识别/gi, '').trim() || '火山豆包';
        const ttsPayload: Record<string, any> = {
          provider: 'volcengine_tts',
          label: `${baseName}播报 (TTS)`,
          baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
          cloneSecretFromCredId: savedCred.id,
          resourceId: draft.pairedTtsResourceId.trim() || 'seed-tts-2.0',
          defaultVoice: draft.pairedTtsVoice.trim() || 'zh_female_vv_uranus_bigtts',
          active: true,
        };
        const ttsRes = await apiCall('/api/voice/credentials', {
          method: 'POST',
          body: JSON.stringify(ttsPayload),
        });
        const ttsData = await ttsRes.json().catch(() => null);
        if (ttsRes.ok && ttsData?.ok && ttsData.credential) {
          pairedTtsCred = ttsData.credential;
          if (ttsData.config) latestCfg = { ...latestCfg, ...ttsData.config };
        }
      }

      onConfigChange(latestCfg);
      setViewMode('list');

      // Apply default routing if checked, OR refresh bound stage model/voice if editing a currently-bound Provider
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
            ? `✅ 已添加「${savedCred.label}」与播报并设为默认`
            : `✅ 已保存「${savedCred.label}」并设为默认`,
        );
      } else if (isEdit && curRoles.length > 0) {
        // Keep active profile stage model/voice in sync with updated Provider defaults
        await persistRouting(
          getStageSelectValue(latestCfg.activeProfile?.stt, latestCfg.credentials),
          getStageSelectValue(latestCfg.activeProfile?.brain, latestCfg.credentials),
          getStageSelectValue(latestCfg.activeProfile?.tts, latestCfg.credentials),
          latestCfg,
          `✅ 已更新「${savedCred.label}」配置`,
        );
      }

      toast(isEdit ? `✅ 已更新「${savedCred.label}」` : `✅ 已添加 Provider「${savedCred.label}」`);
    } catch (err: any) {
      setEditorError(err?.message || '网络异常，请重试');
    } finally {
      setSavingEditor(false);
    }
  };

  const activePreset = VOICE_PROVIDER_PRESETS.find(p => p.key === draft.presetKey);
  const voiceChips = TTS_VOICE_OPTIONS[draft.provider as keyof typeof TTS_VOICE_OPTIONS] || [];
  const isVolcDraft = draft.provider === 'volcengine_asr' || draft.provider === 'volcengine_tts';
  const summaryLine = formatVoiceSummaryForSettings(config);

  return (
    <div
      id="voiceLabSheet"
      class="sheet-backdrop open voice-lab-backdrop"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="sheet-panel voice-lab-panel">
        <div class="sheet-handle"></div>
        <div class="sheet-title" style="margin-bottom:10px;">
          {viewMode === 'list' ? (
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🎙️ 边走边听 · Provider 配置</span>
          ) : (
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
              <button
                type="button"
                class="voice-back-btn"
                id="vpBackToListBtn"
                onClick={() => {
                  setEditorError('');
                  setViewMode('list');
                }}
              >
                ‹ 返回列表
              </button>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                {draft.id ? '✏️ 编辑 Provider' : '➕ 添加 Provider'}
              </span>
            </div>
          )}
          <button
            type="button"
            aria-label="关闭语音配置"
            style="border:none;background:transparent;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 8px;"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {viewMode === 'list' ? (
          <div class="voice-lab-body">
            {loadingCfg && <div class="voice-muted-note">正在读取加密配置…</div>}
            <div class="voice-tab-stack">
              {/* 1. 顶部当前生效概览 + 一键试听 */}
              <div class="voice-card voice-status-hero">
                <div class="voice-status-hero-row">
                  <div style="flex:1;min-width:0;">
                    <div class="voice-status-hero-title">
                      {activeProf.id === 'native' ? '🆓 当前：免费本机语音' : `✅ 当前：${activeProf.name}`}
                    </div>
                    <div class="voice-status-hero-sub">{summaryLine}</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    <button
                      type="button"
                      class="voice-pill-btn primary"
                      id="vpOpenWalkModeBtn"
                      onClick={() => {
                        onClose();
                        (window as any).openWalkMode?.();
                      }}
                    >
                      🎧 进入随行
                    </button>
                    <button
                      type="button"
                      class="voice-pill-btn"
                      disabled={soundChecking}
                      onClick={() => void onSoundCheck()}
                    >
                      {soundChecking ? '试音中…' : '🔊 试听'}
                    </button>
                  </div>
                </div>

                {missingStages.length > 0 && (
                  <button
                    type="button"
                    class="voice-missing-key-cta"
                    style="margin-top:8px;"
                    onClick={() => openAddEditor('deepseek')}
                  >
                    <span>⚠️ {missingStages.join(' / ')} 指向的密钥已缺失</span>
                    <span>去添加 →</span>
                  </button>
                )}

                {(soundCheckMsg || routingMsg) && (
                  <div
                    class={`voice-test-msg ${(routingMsg || soundCheckMsg)!.ok ? 'ok' : 'err'}`}
                    style="margin-top:8px;"
                    onClick={() => {
                      setRoutingMsg(null);
                      onClearSoundCheckMsg();
                    }}
                  >
                    {(routingMsg || soundCheckMsg)!.text}
                  </div>
                )}
              </div>

              {/* 2. 默认角色分配（听 / 想 / 说） */}
              <div class="voice-card">
                <div class="voice-card-head" style="margin-bottom:6px;">
                  <div class="voice-card-title" style="margin-bottom:0;">🎛️ 默认分配（听 · 想 · 说）</div>
                  {activeProf.id !== 'native' && (
                    <button
                      type="button"
                      class="voice-pill-btn"
                      disabled={routingSaving}
                      onClick={() => void persistRouting('native', 'native', 'native')}
                    >
                      切回免费本机
                    </button>
                  )}
                </div>
                <div class="voice-muted-note" style="margin-bottom:8px;">
                  从下方你的 Provider 列表里，自由指定哪一家负责听、想、说，改完自动生效。
                </div>

                <div class="vp-routing-list">
                  <div class="vp-routing-row">
                    <div class="vp-routing-label">
                      <span class="vp-routing-title">👂 听（语音转文字）</span>
                    </div>
                    <select
                      id="voiceStageSttSelect"
                      class="vp-routing-select"
                      disabled={routingSaving}
                      value={sttVal}
                      onChange={(e: any) => handleStageChange('stt', e.target.value)}
                    >
                      <option value="native">🆓 手机自带免费</option>
                      {sttVal.startsWith('missing:') && (
                        <option value={sttVal}>⚠️ 密钥缺失 ({PROTOCOL_LABELS[sttVal.slice(8) as keyof typeof PROTOCOL_LABELS] || sttVal.slice(8)})</option>
                      )}
                      {sttCreds.map(c => (
                        <option key={c.id} value={`cred:${c.id}`}>
                          {c.label} · {PROTOCOL_LABELS[c.provider as keyof typeof PROTOCOL_LABELS] || c.provider}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div class="vp-routing-row">
                    <div class="vp-routing-label">
                      <span class="vp-routing-title">🧠 想（语音大脑）</span>
                    </div>
                    <select
                      id="voiceStageBrainSelect"
                      class="vp-routing-select"
                      disabled={routingSaving}
                      value={brainVal}
                      onChange={(e: any) => handleStageChange('brain', e.target.value)}
                    >
                      <option value="native">🆓 本地基础口令</option>
                      {brainVal.startsWith('missing:') && (
                        <option value={brainVal}>⚠️ 密钥缺失 ({PROTOCOL_LABELS[brainVal.slice(8) as keyof typeof PROTOCOL_LABELS] || brainVal.slice(8)})</option>
                      )}
                      {brainCreds.map(c => (
                        <option key={c.id} value={`cred:${c.id}`}>
                          {c.label} · {c.defaultModel || inferDefaultBrainModel(c)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div class="vp-routing-row">
                    <div class="vp-routing-label">
                      <span class="vp-routing-title">🗣️ 说（文字转语音）</span>
                    </div>
                    <select
                      id="voiceStageTtsSelect"
                      class="vp-routing-select"
                      disabled={routingSaving}
                      value={ttsVal}
                      onChange={(e: any) => handleStageChange('tts', e.target.value)}
                    >
                      <option value="native">🆓 手机自带免费</option>
                      {ttsVal.startsWith('missing:') && (
                        <option value={ttsVal}>⚠️ 密钥缺失 ({PROTOCOL_LABELS[ttsVal.slice(8) as keyof typeof PROTOCOL_LABELS] || ttsVal.slice(8)})</option>
                      )}
                      {ttsCreds.map(c => (
                        <option key={c.id} value={`cred:${c.id}`}>
                          {c.label} · {c.defaultVoice || PROTOCOL_LABELS[c.provider as keyof typeof PROTOCOL_LABELS] || c.provider}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* 3. 我的 Provider 列表（DeepSeek Harness 风格，不限制固定服务商） */}
              <div class="voice-card" id="voiceProviderListSection">
                <div class="voice-card-head" style="margin-bottom:8px;">
                  <div>
                    <div class="voice-card-title" style="margin-bottom:2px;">
                      🔌 我的 Provider 列表 ({creds.length})
                    </div>
                    <div class="voice-muted-note" style="margin:0;">
                      支持任意中转站、OpenAI 兼容接口、DeepSeek、火山豆包、Gemini 等
                    </div>
                  </div>
                  <button
                    type="button"
                    id="voiceAddProviderBtn"
                    class="voice-pill-btn primary"
                    onClick={() => openAddEditor('deepseek')}
                  >
                    ＋ 添加
                  </button>
                </div>

                {creds.length === 0 ? (
                  <div class="vp-empty-box">
                    <div class="vp-empty-title">还没有添加任何 Provider</div>
                    <div class="vp-empty-desc">
                      点下方按钮添加你自己的服务商（支持自定义接口地址、模型名和 API Key），添加后即可在上方选为默认。
                    </div>
                    <button
                      type="button"
                      class="primary-block-btn"
                      style="margin-top:10px;"
                      onClick={() => openAddEditor('deepseek')}
                    >
                      ＋ 添加第一个 Provider
                    </button>
                  </div>
                ) : (
                  <div class="vp-list">
                    {creds.map(cred => {
                      const roles = getCredentialActiveRoles(cred.id, activeProf, creds);
                      const host = extractHostFromUrl(cred.baseUrl);
                      const modelOrRes = cred.defaultModel || cred.resourceId || '';
                      const testRes = testResults[cred.id];
                      const isPrimaryDefault = (cred.provider === 'gemini' && roles.length === 3)
                        || (cred.provider === 'volcengine_asr' && roles.includes('stt'))
                        || (cred.provider === 'volcengine_tts' && roles.includes('tts'))
                        || (cred.provider === 'openai_compat' && roles.includes('brain'));

                      return (
                        <div key={cred.id} class={`vp-item ${roles.length > 0 ? 'is-active' : ''}`}>
                          <div class="vp-item-top">
                            <div class="vp-item-title-wrap">
                              <span class="vp-item-name">{cred.label}</span>
                              <span class="voice-prov-tag">
                                {PROTOCOL_LABELS[cred.provider as keyof typeof PROTOCOL_LABELS] || cred.provider}
                              </span>
                            </div>
                            {roles.length > 0 && (
                              <div class="vp-role-badges">
                                {roles.includes('stt') && <span class="vp-role-pill stt">👂 听</span>}
                                {roles.includes('brain') && <span class="vp-role-pill brain">🧠 想</span>}
                                {roles.includes('tts') && <span class="vp-role-pill tts">🗣️ 说</span>}
                              </div>
                            )}
                          </div>

                          <div class="vp-item-meta">
                            {host && <span>{host}</span>}
                            {modelOrRes && <span>· {modelOrRes}</span>}
                            {cred.defaultVoice && cred.provider !== 'volcengine_asr' && <span>· 音色 {cred.defaultVoice}</span>}
                            <span>· {cred.authSummary}</span>
                          </div>

                          {testRes && (
                            <div class={`voice-test-msg ${testRes.ok ? 'ok' : 'err'}`} style="margin-top:6px;">
                              {testRes.summary}
                            </div>
                          )}

                          <div class="vp-item-actions">
                            <button
                              type="button"
                              class={`voice-pill-btn ${isPrimaryDefault ? '' : 'primary'}`}
                              disabled={routingSaving}
                              onClick={() => void handleSetProviderDefault(cred)}
                            >
                              {isPrimaryDefault ? '✅ 已为默认' : '⚡ 设为默认'}
                            </button>
                            <button
                              type="button"
                              class="voice-pill-btn"
                              disabled={testingCredId === cred.id}
                              onClick={() => void handleTestProvider(cred.id)}
                            >
                              {testingCredId === cred.id ? '测试中…' : '🔌 测试'}
                            </button>
                            <button
                              type="button"
                              class="voice-pill-btn"
                              onClick={() => openEditEditor(cred)}
                            >
                              ✏️ 编辑
                            </button>
                            <button
                              type="button"
                              class="voice-pill-btn danger"
                              onClick={() => void handleDeleteProvider(cred)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 4. 日常必用开关 */}
              <div class="voice-card">
                <div class="voice-toggle-row">
                  <div>
                    <div class="voice-row-main">🛡️ 高危操作二次确认</div>
                    <div class="voice-row-sub">删文件 / 强推 / 部署等危险指令时的保护方式</div>
                  </div>
                  <select
                    class="voice-mini-select"
                    value={config.prefs.l2Policy}
                    onChange={(e: any) => void onUpdatePrefs({ l2Policy: e.target.value })}
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
                    onChange={(e: any) => void onUpdatePrefs({ autoListenAfterBriefing: e.target.checked })}
                  />
                </div>
              </div>

              {/* 5. 折叠的高级选项与延迟压测 */}
              <details
                class="voice-adv-details"
                open={geekOpen}
                onToggle={(e: any) => setGeekOpen(Boolean(e.currentTarget?.open))}
              >
                <summary>🔧 高级选项与延迟压测（聊天页复用 / 试跑排障）</summary>
                <div class="voice-adv-body" style="display:flex;flex-direction:column;gap:10px;">
                  <div>
                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">🎵 边听歌边播报（压低背景音乐）</div>
                        <div class="voice-row-sub">播报时自动压低音乐音量，说完自动恢复</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={config.prefs.duckMusicMode}
                        onChange={(e: any) => void onUpdatePrefs({ duckMusicMode: e.target.checked })}
                      />
                    </div>
                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">聊天页「🔊 播报」复用云端声音</div>
                        <div class="voice-row-sub">默认用免费系统语音；开启后用上方选好的「说」服务</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={config.prefs.useByokForChatTts}
                        onChange={(e: any) => void onUpdatePrefs({ useByokForChatTts: e.target.checked })}
                      />
                    </div>
                    <div class="voice-toggle-row">
                      <div>
                        <div class="voice-row-main">聊天页语音输入复用云端听写</div>
                        <div class="voice-row-sub">默认用免费系统听写；开启后用上方选好的「听」服务</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={config.prefs.useByokForChatStt}
                        onChange={(e: any) => void onUpdatePrefs({ useByokForChatStt: e.target.checked })}
                      />
                    </div>
                  </div>

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
                        onChange={(e: any) => onSetBenchDryRun(e.target.checked)}
                      />
                    </div>
                    <input
                      class="voice-field-input"
                      value={benchText}
                      onInput={(e: any) => onSetBenchText(e.target.value)}
                      placeholder="输入一句测试口令..."
                    />
                    <div style="display:flex;gap:8px;margin-top:6px;">
                      <button
                        type="button"
                        class="voice-pill-btn primary"
                        style="flex:1;padding:8px 10px;"
                        disabled={benchRunning}
                        onClick={() => void onRunBenchTurn()}
                      >
                        {benchRunning ? '⏳ 测速中…' : '🚀 跑一轮延迟压测'}
                      </button>
                      <button
                        type="button"
                        class={`voice-pill-btn ${benchRecording ? 'danger' : ''}`}
                        style="padding:8px 10px;"
                        disabled={benchRunning}
                        onClick={() => void onToggleBenchVoice()}
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
        ) : (
          /* 编辑 / 新增 Provider 表单视图 */
          <div class="voice-lab-body" id="voiceProviderEditor">
            <div class="voice-tab-stack">
              {!draft.id && (
                <div class="voice-card" style="padding:10px 11px;">
                  <div class="voice-card-title" style="margin-bottom:7px;">⚡ 选一个模板快填（也可以选「完全自定义」）</div>
                  <div class="vp-preset-grid">
                    {VOICE_PROVIDER_PRESETS.map(p => (
                      <button
                        key={p.key}
                        type="button"
                        data-preset-key={p.key}
                        class={`vp-preset-chip ${draft.presetKey === p.key ? 'active' : ''}`}
                        onClick={() => {
                          setEditorError('');
                          setDraft(makeDraftFromPreset(p.key));
                        }}
                      >
                        <span class="vp-preset-title">{p.icon} {p.title}</span>
                        <span class="vp-preset-sub">{p.sub}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div class="voice-card">
                <label class="voice-field-label" style="margin-top:0;">显示名称（自己好认就行）</label>
                <input
                  id="vpLabelInput"
                  class="voice-field-input"
                  value={draft.label}
                  placeholder="例：我的中转站 / DeepSeek-V3 / 火山豆包"
                  onInput={(e: any) => setDraft({ ...draft, label: e.target.value })}
                />

                <label class="voice-field-label">接口协议类型</label>
                <select
                  id="vpProviderTypeSelect"
                  class="voice-field-input"
                  disabled={Boolean(draft.id)}
                  value={draft.provider}
                  onChange={(e: any) => {
                    const nextProv = e.target.value as ProviderDraft['provider'];
                    setDraft(prev => ({
                      ...prev,
                      presetKey: 'custom',
                      provider: nextProv,
                      baseUrl: nextProv === 'gemini'
                        ? 'https://generativelanguage.googleapis.com/v1beta'
                        : nextProv === 'volcengine_asr'
                          ? 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash'
                          : nextProv === 'volcengine_tts'
                            ? 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
                            : (prev.baseUrl && !prev.baseUrl.includes('bytedance') && !prev.baseUrl.includes('googleapis'))
                              ? prev.baseUrl
                              : '',
                      resourceId: nextProv === 'volcengine_asr'
                        ? 'volc.bigasr.auc_turbo'
                        : nextProv === 'volcengine_tts'
                          ? 'seed-tts-2.0'
                          : '',
                      defaultVoice: nextProv === 'volcengine_tts'
                        ? 'zh_female_vv_uranus_bigtts'
                        : nextProv === 'gemini'
                          ? 'Kore'
                          : prev.defaultVoice,
                    }));
                  }}
                >
                  <option value="openai_compat">OpenAI 兼容接口（任意中转站 / DeepSeek / 方舟 / Ollama）</option>
                  <option value="gemini">Google Gemini 官方接口</option>
                  <option value="volcengine_asr">火山豆包语音识别（听写 ASR）</option>
                  <option value="volcengine_tts">火山豆包语音合成（播报 TTS）</option>
                </select>

                {!isVolcDraft && (
                  <Fragment>
                    <label class="voice-field-label">接口地址 (Base URL)</label>
                    <input
                      id="vpBaseUrlInput"
                      class="voice-field-input"
                      value={draft.baseUrl}
                      placeholder={
                        draft.provider === 'gemini'
                          ? 'https://generativelanguage.googleapis.com/v1beta'
                          : '例：https://api.example.com/v1'
                      }
                      onInput={(e: any) => setDraft({ ...draft, baseUrl: e.target.value })}
                    />
                  </Fragment>
                )}

                <label class="voice-field-label">
                  {isVolcDraft ? '火山引擎鉴权密钥' : 'API Key（加密保存，不回传明文）'}
                </label>

                {draft.id && editingCredSummary && (
                  <div class="voice-saved-hint" style="margin-bottom:6px;">
                    🔐 已加密保存：{editingCredSummary} · 留空则保持原密钥不变
                  </div>
                )}

                {isVolcDraft && (
                  <div class="voice-subseg" style="margin-top:2px;margin-bottom:6px;">
                    <button
                      type="button"
                      class={`voice-subseg-btn ${draft.volcAuthMode === 'apiKey' ? 'active' : ''}`}
                      onClick={() => setDraft({ ...draft, volcAuthMode: 'apiKey' })}
                    >
                      单把 API Key（推荐）
                    </button>
                    <button
                      type="button"
                      class={`voice-subseg-btn ${draft.volcAuthMode === 'appToken' ? 'active' : ''}`}
                      onClick={() => setDraft({ ...draft, volcAuthMode: 'appToken' })}
                    >
                      AppID + Access Token
                    </button>
                  </div>
                )}

                {isVolcDraft && draft.volcAuthMode === 'appToken' ? (
                  <div class="voice-two-col">
                    <input
                      class="voice-field-input"
                      value={draft.appId}
                      placeholder="火山 AppID"
                      onInput={(e: any) => setDraft({ ...draft, appId: e.target.value })}
                    />
                    <input
                      type="password"
                      class="voice-field-input"
                      value={draft.accessToken}
                      placeholder={draft.id ? '留空沿用原 Token' : 'Access Token'}
                      onInput={(e: any) => setDraft({ ...draft, accessToken: e.target.value })}
                    />
                  </div>
                ) : (
                  <input
                    id="vpApiKeyInput"
                    type="password"
                    class="voice-field-input"
                    value={draft.apiKey}
                    placeholder={
                      draft.id
                        ? '留空保留当前已保存密钥，或粘贴新 Key 替换'
                        : (activePreset?.keyPlaceholder || '粘贴 API Key...')
                    }
                    onInput={(e: any) => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                )}

                {!isVolcDraft ? (
                  <Fragment>
                    <label class="voice-field-label">默认模型名</label>
                    <input
                      id="vpDefaultModelInput"
                      class="voice-field-input"
                      value={draft.defaultModel}
                      placeholder="例：deepseek-chat / gpt-4o-mini / doubao-seed-2-0-lite-260215"
                      onInput={(e: any) => setDraft({ ...draft, defaultModel: e.target.value })}
                    />
                    {activePreset?.modelChips && activePreset.modelChips.length > 0 && (
                      <div class="voice-chip-row" style="margin-top:5px;">
                        {activePreset.modelChips.map(chip => (
                          <button
                            key={chip.value}
                            type="button"
                            class={`voice-quick-chip ${draft.defaultModel === chip.value ? 'active' : ''}`}
                            onClick={() => setDraft({ ...draft, defaultModel: chip.value })}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </Fragment>
                ) : (
                  <Fragment>
                    <label class="voice-field-label">
                      Resource ID（默认 {draft.provider === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : 'seed-tts-2.0'}）
                    </label>
                    <input
                      id="vpResourceIdInput"
                      class="voice-field-input"
                      value={draft.resourceId}
                      placeholder={draft.provider === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : 'seed-tts-2.0'}
                      onInput={(e: any) => setDraft({ ...draft, resourceId: e.target.value })}
                    />
                  </Fragment>
                )}

                {(draft.provider === 'volcengine_tts' || draft.provider === 'gemini') && (
                  <Fragment>
                    <label class="voice-field-label">默认播报音色（可选）</label>
                    <input
                      class="voice-field-input"
                      value={draft.defaultVoice}
                      placeholder={draft.provider === 'volcengine_tts' ? 'zh_female_vv_uranus_bigtts' : 'Kore'}
                      onInput={(e: any) => setDraft({ ...draft, defaultVoice: e.target.value })}
                    />
                    {voiceChips.length > 0 && (
                      <div class="voice-chip-row" style="margin-top:5px;">
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
                  </Fragment>
                )}

                {!draft.id && draft.provider === 'volcengine_asr' && (
                  <div style="margin-top:10px;padding:9px 10px;border-radius:10px;background:var(--subtle);border:1px solid var(--border);">
                    <label class="voice-dual-check" style="margin:0;">
                      <input
                        type="checkbox"
                        checked={draft.alsoCreateTts}
                        onChange={(e: any) => setDraft({ ...draft, alsoCreateTts: Boolean(e.target.checked) })}
                      />
                      <span><strong>同时创建「火山豆包播报 (TTS)」并共用这把密钥</strong>（免贴两遍）</span>
                    </label>
                    {draft.alsoCreateTts && (
                      <div style="margin-top:8px;">
                        <div class="voice-brick-sub-label">挑一个播报声音</div>
                        <div class="voice-chip-row" style="margin-top:4px;">
                          {TTS_VOICE_OPTIONS.volcengine_tts.map(v => (
                            <button
                              key={v.value}
                              type="button"
                              class={`voice-quick-chip ${draft.pairedTtsVoice === v.value ? 'active' : ''}`}
                              onClick={() => setDraft({ ...draft, pairedTtsVoice: v.value })}
                            >
                              {v.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <label class="voice-dual-check" style="margin-top:10px;">
                  <input
                    type="checkbox"
                    checked={draft.setAsDefault}
                    onChange={(e: any) => setDraft({ ...draft, setAsDefault: Boolean(e.target.checked) })}
                  />
                  <span>
                    <strong>保存后立即设为默认</strong>
                    {draft.provider === 'gemini'
                      ? '（自动用于 听 + 想 + 说）'
                      : draft.provider === 'volcengine_asr'
                        ? (draft.alsoCreateTts && !draft.id ? '（自动用于 听 + 说）' : '（自动用于 👂 听）')
                        : draft.provider === 'volcengine_tts'
                          ? '（自动用于 🗣️ 说）'
                          : '（自动用于 🧠 想，可在列表页随时调 听/说）'}
                  </span>
                </label>

                {editorError && (
                  <div class="voice-test-msg err" style="margin-top:8px;padding:7px 10px;">
                    ⚠️ {editorError}
                  </div>
                )}

                <div style="display:flex;gap:8px;margin-top:12px;">
                  <button
                    type="button"
                    id="vpSaveProviderBtn"
                    class="primary-block-btn"
                    style="margin-top:0;flex:1;"
                    disabled={savingEditor}
                    onClick={() => void handleSaveProvider()}
                  >
                    {savingEditor ? '正在加密保存…' : '💾 保存 Provider'}
                  </button>
                  <button
                    type="button"
                    class="voice-pill-btn"
                    style="padding:11px 14px;"
                    onClick={() => setViewMode('list')}
                  >
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
