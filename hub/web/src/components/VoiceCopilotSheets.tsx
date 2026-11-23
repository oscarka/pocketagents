import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  WalkWavRecorder,
  WalkSpeechPlayer,
  WalkWakeLockManager,
  bindWalkMediaSession,
  playEarcon,
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
  const approvals: Array<{ hostId: string; hostName: string; code: string; title: string; risk: string }> = [];
  let runningCount = 0;
  const completedKeys: Array<{ key: string; title: string; hostName: string }> = [];
  for (const h of hosts) {
    const hostName = h?.hostName || h?.hostId || '';
    const bridge = h?.bridgeState || {};
    for (const a of bridge.approvals || []) {
      if (!a) continue;
      approvals.push({
        hostId: h.hostId,
        hostName,
        code: String(a.code || ''),
        title: String(a.title || a.summary || a.toolName || '工具审批'),
        risk: String(a.risk || ''),
      });
    }
    for (const t of bridge.tasks || []) {
      if (!t) continue;
      if (t.status === 'running') runningCount += 1;
      if (t.status === 'idle' && t.lastConclusionAt) {
        completedKeys.push({
          key: `${h.hostId}:${t.id}:${t.lastConclusionAt}`,
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

function createEmptyProfileDraft(): VoiceProfile {
  return {
    id: '',
    name: '自定义随行方案',
    builtin: false,
    stt: { provider: 'volcengine_asr', credId: '', model: 'volc.bigasr.auc_turbo', language: 'zh-CN', thinkingLevel: 'low', fallbackChain: [] },
    brain: { provider: 'gemini', credId: '', model: 'gemini-2.5-flash', thinkingLevel: 'off', maxTokens: 320 },
    tts: { provider: 'volcengine_tts', credId: '', model: 'seed-tts-2.0', voice: 'zh_female_vv_uranus_bigtts', format: 'mp3', speed: 1.0 },
  };
}

export function VoiceCopilotSheets() {
  const [walkOpen, setWalkOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [labTab, setLabTab] = useState<'profiles' | 'keys' | 'bench'>('profiles');
  const [config, setConfig] = useState<VoiceConfigState>(DEFAULT_CONFIG);
  const [loadingCfg, setLoadingCfg] = useState(false);

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

  // Add key form state
  const [keyProvider, setKeyProvider] = useState('gemini');
  const [keyLabel, setKeyLabel] = useState('');
  const [keyBaseUrl, setKeyBaseUrl] = useState('https://generativelanguage.googleapis.com/v1beta');
  const [keyApiKey, setKeyApiKey] = useState('');
  const [keyAppId, setKeyAppId] = useState('');
  const [keyAccessToken, setKeyAccessToken] = useState('');
  const [keyResourceId, setKeyResourceId] = useState('');
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
    (window as any).openVoiceLab = (tab: 'profiles' | 'keys' | 'bench' = 'profiles') => {
      setLabTab(tab);
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

  // WakeLock + AirPods MediaSession lifecycle when Walk Mode opens/closes
  useEffect(() => {
    if (!walkOpen) {
      playerRef.current?.stop();
      stopAllListening();
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

    void wakeRef.current?.enable().then(ok => setWakeLocked(ok));
    const unbindMedia = bindWalkMediaSession({
      onToggleListen: () => { void toggleWalkMic(); },
      onNextBriefing: () => { void runBriefingTurn(); },
      onStopSpeaking: () => {
        playerRef.current?.stop();
        if (walkPhaseRef.current === 'speaking') setWalkPhase('idle');
      },
    });
    return () => {
      unbindMedia();
    };
  }, [walkOpen]);

  // Subscribe to live Hub SSE state updates for proactive Walk Mode briefings
  useEffect(() => {
    const onHubState = (ev: any) => {
      const snap = summarizeHubState(ev?.detail || (window as any).__dshLastHubState);
      setHubSummary(snap);
      if (!walkOpenRef.current) return;

      const mode = configRef.current?.prefs?.proactiveBriefing || 'approvals';
      if (mode === 'manual') return;

      // Detect newly arrived approvals
      const freshApprovals = snap.approvals.filter(a => {
        const k = `${a.hostId}:${a.code}`;
        if (seenApprovalsRef.current.has(k)) return false;
        seenApprovalsRef.current.add(k);
        return true;
      });
      if (freshApprovals.length > 0 && walkPhaseRef.current === 'idle') {
        const a = freshApprovals[0];
        playEarcon('approval');
        const briefText = `注意，${a.hostName} 收到新的审批请求：${a.title}。点圆球说放行或拒绝。`;
        setLastReplyText(briefText);
        setLastActionBadge(`🔔 新待审批 ${a.code}`);
        void speakWalkReply([briefText]);
        return;
      }

      if (mode === 'all') {
        const freshCompleted = snap.completedKeys.filter(c => {
          if (seenCompletedRef.current.has(c.key)) return false;
          seenCompletedRef.current.add(c.key);
          return true;
        });
        if (freshCompleted.length > 0 && walkPhaseRef.current === 'idle') {
          const c = freshCompleted[0];
          playEarcon('done');
          const briefText = `${c.hostName} 上的任务「${c.title}」已完成。`;
          setLastReplyText(briefText);
          setLastActionBadge('✅ 任务完成');
          void speakWalkReply([briefText]);
        }
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

  const speakWalkReply = async (chunks: string[], onFirstTtsMs?: (ms: number) => void) => {
    const cfg = configRef.current;
    if (!cfg.prefs.autoPlayWalkReplies) {
      setWalkPhase('idle');
      return;
    }
    const useCloud = cfg.activeProfile?.tts?.provider && cfg.activeProfile.tts.provider !== 'native';
    setWalkPhase('speaking');
    await playerRef.current!.speakChunksProgressive(chunks, {
      useCloudTts: Boolean(useCloud),
      speechRate: cfg.prefs.speechRate || 1.0,
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
    if (!clean) {
      setWalkPhase('idle');
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
          profileId: configRef.current.activeProfile.id,
          dryRun: false,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || !data?.ok) {
        playEarcon('alert');
        setWalkPhase('idle');
        const errMsg = data?.error || '语音大脑调用失败，请检查密钥与网络';
        setLastReplyText(errMsg);
        setLastActionBadge('❌ 调用失败');
        return;
      }

      const reply = String(data.spokenReply || '已处理。');
      const chunks = Array.isArray(data.spokenChunks) && data.spokenChunks.length ? data.spokenChunks : [reply];
      setLastReplyText(reply);
      setActivePin(data.pinChallenge || null);

      if (data.fastPath === 'l2_pin_matched') {
        playEarcon('pin_ok');
        setLastActionBadge(`🔓 确认码通过 · 已放行 ${data.action?.code || ''}`);
      } else if (data.execution?.requiresPin) {
        playEarcon('alert');
        setLastActionBadge(`⚠️ L2 高危拦截 · 需念出 ${data.pinChallenge?.pin || ''}`);
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

      await speakWalkReply(chunks, ttsMs => {
        setLastLatencyBadge([...baseMetrics, `TTS ${ttsMs}ms`].join(' · '));
      });
    } catch (err: any) {
      playEarcon('alert');
      setWalkPhase('idle');
      setLastReplyText(err?.message || '网络异常，请稍后再试');
      setLastActionBadge('❌ 网络异常');
    }
  };

  const handleWalkWavReady = async (rec: { wavBase64: string; byteLength: number; hadSpeech: boolean }) => {
    setMicLevel(0);
    const wavKb = Math.max(1, Math.round(rec.byteLength / 1024));
    if (rec.byteLength < 1600) {
      setWalkPhase('idle');
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
        setLastReplyText(data?.error || '云端语音识别失败，请在语音配置检查密钥');
        setLastActionBadge('❌ STT 失败');
        return;
      }
      if (data.silence || !String(data.text || '').trim()) {
        setWalkPhase('idle');
        setLastReplyText('没有检测到清晰人声（静音），轻点圆球重新说。');
        setLastLatencyBadge(`WAV ${wavKb}KB · STT ${data.latencyMs ?? 0}ms · 静音`);
        return;
      }
      await handleWalkUserText(data.text, data.latencyMs ?? 0, wavKb);
    } catch (err: any) {
      playEarcon('alert');
      setWalkPhase('idle');
      setLastReplyText(err?.message || '语音上传失败');
      setLastActionBadge('❌ 网络失败');
    }
  };

  const startNativeWalkSpeech = () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast('当前浏览器不支持原生语音识别，可在「配置」添加云端 STT 密钥或使用下方文字输入');
      setWalkTextInputOpen(true);
      setWalkPhase('idle');
      return;
    }
    const rec = new SR();
    rec.lang = 'zh-CN';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    const t0 = Date.now();
    rec.onresult = (ev: any) => {
      let txt = '';
      for (let i = 0; i < ev.results.length; i += 1) {
        txt += ev.results[i][0]?.transcript || '';
      }
      finalText = txt.trim();
      if (finalText) setLastUserText(finalText);
    };
    rec.onerror = () => {
      nativeRecRef.current = null;
      setWalkPhase('idle');
    };
    rec.onend = () => {
      nativeRecRef.current = null;
      const elapsed = Date.now() - t0;
      if (finalText) {
        void handleWalkUserText(finalText, elapsed, null);
      } else {
        setWalkPhase('idle');
      }
    };
    nativeRecRef.current = rec;
    setWalkPhase('listening');
    playEarcon('listen');
    rec.start();
  };

  const toggleWalkMic = async () => {
    // Instant Barge-in: tapping orb while speaking cuts off TTS immediately and starts listening!
    if (walkPhaseRef.current === 'speaking') {
      playerRef.current?.stop();
    }
    if (walkPhaseRef.current === 'listening') {
      if (recorderRef.current?.isRecording()) {
        const res = recorderRef.current.stop();
        if (res) void handleWalkWavReady(res);
      } else if (nativeRecRef.current) {
        try { nativeRecRef.current.stop(); } catch {}
      }
      return;
    }
    if (walkPhaseRef.current === 'transcribing' || walkPhaseRef.current === 'thinking') {
      return;
    }

    const sttProvider = configRef.current.activeProfile?.stt?.provider || 'native';
    if (sttProvider === 'native') {
      startNativeWalkSpeech();
      return;
    }
    try {
      playEarcon('listen');
      setWalkPhase('listening');
      await recorderRef.current!.start({
        autoVad: configRef.current.prefs.autoVad,
        vadSilenceMs: configRef.current.prefs.vadSilenceMs || 850,
        onLevel: lvl => setMicLevel(lvl),
        onAutoStop: res => {
          void handleWalkWavReady(res);
        },
      });
    } catch (err: any) {
      setWalkPhase('idle');
      toast(err?.message || '无法打开麦克风，请检查浏览器权限');
    }
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

  const handleSaveCredential = async () => {
    setSavingKey(true);
    try {
      const res = await apiCall('/api/voice/credentials', {
        method: 'POST',
        body: JSON.stringify({
          provider: keyProvider,
          label: keyLabel,
          baseUrl: keyBaseUrl,
          apiKey: keyApiKey,
          appId: keyAppId,
          accessToken: keyAccessToken,
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
      setConfig(prev => ({ ...prev, ...data.config }));
      setKeyLabel('');
      setKeyApiKey('');
      setKeyAppId('');
      setKeyAccessToken('');
      toast('🔐 密钥已加密存入 Vault（不再回显明文）');
    } finally {
      setSavingKey(false);
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

  const onSelectKeyProvider = (prov: string) => {
    setKeyProvider(prov);
    const item = config.catalog.find(c => c.id === prov);
    setKeyBaseUrl(item?.defaultBaseUrl || '');
    setKeyResourceId(item?.defaultResourceId || '');
    setKeyDefaultModel('');
    setKeyDefaultVoice('');
  };

  const renderCredSelect = (provider: string, value: string, onChange: (val: string) => void) => {
    if (provider === 'native') return null;
    const matched = config.credentials.filter(c => c.provider === provider);
    return (
      <select class="voice-field-input" value={value} onChange={(e: any) => onChange(e.target.value)}>
        <option value="">自动跟随该服务商当前默认密钥 ({matched.length} 个可用)</option>
        {matched.map(c => (
          <option key={c.id} value={c.id}>
            {c.label} ({c.authSummary}){c.active ? ' ★' : ''}
          </option>
        ))}
      </select>
    );
  };

  const activeProf = config.activeProfile || DEFAULT_CONFIG.activeProfile;
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
                onClick={() => { setLabTab('profiles'); setLabOpen(true); }}
                title="点击切换语音方案与模型"
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
                onClick={() => { setLabTab('profiles'); setLabOpen(true); }}
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
                class={`walk-mini-toggle ${config.prefs.autoVad ? 'on' : ''}`}
                onClick={() => void updatePrefPatch({ autoVad: !config.prefs.autoVad })}
              >
                {config.prefs.autoVad ? '🟢 自动停顿收音' : '⚪ 手动点停'}
              </button>
              <button
                type="button"
                class={`walk-mini-toggle ${config.prefs.proactiveBriefing !== 'manual' ? 'on' : ''}`}
                onClick={() => {
                  const order: Array<'approvals' | 'all' | 'manual'> = ['approvals', 'all', 'manual'];
                  const next = order[(order.indexOf(config.prefs.proactiveBriefing) + 1) % order.length];
                  void updatePrefPatch({ proactiveBriefing: next });
                }}
              >
                🔔 主动播报：{config.prefs.proactiveBriefing === 'approvals' ? '仅审批' : config.prefs.proactiveBriefing === 'all' ? '审批+完成' : '手动'}
              </button>
              <span class="walk-mini-hint">
                高危：{config.prefs.l2Policy === 'pin' ? '3位确认码' : '仅屏触'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 2. 语音总管配置 & BYOK 调试台半屏抽屉 (#voiceLabSheet, z-index: 140) */}
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
              <span>🎙️ 随行语音总管 & BYOK 配置</span>
              <button
                type="button"
                style="border:none;background:transparent;color:var(--muted);font-size:18px;cursor:pointer;padding:4px 8px;"
                onClick={() => setLabOpen(false)}
              >
                ✕
              </button>
            </div>

            <div class="voice-lab-tabs">
              <button
                type="button"
                class={`voice-lab-tab ${labTab === 'profiles' ? 'active' : ''}`}
                onClick={() => setLabTab('profiles')}
              >
                🎛️ 方案与开关
              </button>
              <button
                type="button"
                class={`voice-lab-tab ${labTab === 'keys' ? 'active' : ''}`}
                onClick={() => setLabTab('keys')}
              >
                🔑 密钥池 ({config.credentials.length})
              </button>
              <button
                type="button"
                class={`voice-lab-tab ${labTab === 'bench' ? 'active' : ''}`}
                onClick={() => setLabTab('bench')}
              >
                🧪 调试台
              </button>
            </div>

            <div class="voice-lab-body">
              {loadingCfg && <div class="voice-muted-note">正在读取加密配置…</div>}

              {/* TAB 1: 方案与开关 */}
              {labTab === 'profiles' && (
                <div class="voice-tab-stack">
                  <div class="voice-card">
                    <div class="voice-card-head">
                      <span class="voice-card-title">当前生效语音方案</span>
                      <button
                        type="button"
                        class="voice-pill-btn primary"
                        onClick={() => setEditingProfile(createEmptyProfileDraft())}
                      >
                        ＋ 新建混搭方案
                      </button>
                    </div>
                    <div class="voice-profile-list">
                      {config.profiles.map(p => {
                        const isActive = p.id === config.prefs.activeProfileId;
                        return (
                          <div key={p.id} class={`voice-profile-row ${isActive ? 'active' : ''}`}>
                            <div
                              style="flex:1;min-width:0;cursor:pointer;"
                              onClick={() => void updatePrefPatch({ activeProfileId: p.id })}
                            >
                              <div class="voice-profile-row-title">
                                <span>{isActive ? '✅ ' : '⚪ '}{p.name}</span>
                              </div>
                              <div class="voice-profile-row-sub">
                                👂 {p.stt.provider}/{p.stt.model || '默认'} · 🧠 {p.brain.provider}/{p.brain.model || '默认'} · 🗣️ {p.tts.provider}/{p.tts.model || '默认'}
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
                        );
                      })}
                    </div>
                  </div>

                  {/* 新建 / 编辑混搭方案 */}
                  {editingProfile && (
                    <div class="voice-card voice-editor-card">
                      <div class="voice-card-head">
                        <span class="voice-card-title">{editingProfile.id ? '编辑混搭方案' : '新建自由混搭方案（耳朵 / 大脑 / 嘴巴独立可选）'}</span>
                        <button type="button" class="voice-pill-btn" onClick={() => setEditingProfile(null)}>取消</button>
                      </div>

                      <label class="voice-field-label">方案名称</label>
                      <input
                        class="voice-field-input"
                        value={editingProfile.name}
                        placeholder="例如：豆包耳朵嘴巴 + Gemini 大脑"
                        onInput={(e: any) => setEditingProfile({ ...editingProfile, name: e.target.value })}
                      />

                      {/* STT */}
                      <div class="voice-stage-box">
                        <div class="voice-stage-title">👂 1. 语音识别 (STT · 耳朵)</div>
                        <select
                          class="voice-field-input"
                          value={editingProfile.stt.provider}
                          onChange={(e: any) => {
                            const prov = e.target.value;
                            const defModel = prov === 'volcengine_asr' ? 'volc.bigasr.auc_turbo' : prov === 'gemini' ? 'gemini-2.5-flash' : prov === 'openai_compat' ? 'whisper-1' : 'browser-web-speech';
                            setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, provider: prov, credId: '', model: defModel } });
                          }}
                        >
                          <option value="native">系统原生浏览器识别（免 Key 免费）</option>
                          <option value="volcengine_asr">火山豆包 Flash ASR</option>
                          <option value="gemini">Google Gemini（音频直识）</option>
                          <option value="openai_compat">OpenAI 兼容接口（Whisper / Transcribe）</option>
                        </select>
                        {renderCredSelect(editingProfile.stt.provider, editingProfile.stt.credId, v =>
                          setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, credId: v } }),
                        )}
                        {editingProfile.stt.provider !== 'native' && (
                          <input
                            class="voice-field-input"
                            value={editingProfile.stt.model}
                            placeholder="模型 / Resource ID（如 volc.bigasr.auc_turbo）"
                            onInput={(e: any) => setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, model: e.target.value } })}
                          />
                        )}
                        {editingProfile.stt.provider === 'gemini' && (
                          <select
                            class="voice-field-input"
                            value={editingProfile.stt.thinkingLevel || 'low'}
                            onChange={(e: any) => setEditingProfile({ ...editingProfile, stt: { ...editingProfile.stt, thinkingLevel: e.target.value } })}
                          >
                            <option value="low">思考档位：low（推荐，防漏字且低延迟）</option>
                            <option value="default">思考档位：模型默认</option>
                            <option value="medium">思考档位：medium</option>
                          </select>
                        )}
                        {editingProfile.stt.provider !== 'native' && (
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
                            <option value="">备用降级 STT：无（主引擎失败直接报错）</option>
                            <option value="gemini">备用降级 STT：Google Gemini</option>
                            <option value="volcengine_asr">备用降级 STT：火山 Flash ASR</option>
                            <option value="openai_compat">备用降级 STT：OpenAI 兼容 Whisper</option>
                          </select>
                        )}
                      </div>

                      {/* Brain */}
                      <div class="voice-stage-box">
                        <div class="voice-stage-title">🧠 2. 语音总管大脑 (Brain · 理解与工具调度)</div>
                        <select
                          class="voice-field-input"
                          value={editingProfile.brain.provider}
                          onChange={(e: any) => {
                            const prov = e.target.value;
                            const defModel = prov === 'gemini' ? 'gemini-2.5-flash' : prov === 'openai_compat' ? 'deepseek-chat' : 'rule-router';
                            setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, provider: prov, credId: '', model: defModel } });
                          }}
                        >
                          <option value="native">本地规则路由（免 Key 基础口令）</option>
                          <option value="gemini">Google Gemini</option>
                          <option value="openai_compat">OpenAI 兼容接口（DeepSeek / 方舟 Ark / OpenAI / Ollama）</option>
                        </select>
                        {renderCredSelect(editingProfile.brain.provider, editingProfile.brain.credId, v =>
                          setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, credId: v } }),
                        )}
                        {editingProfile.brain.provider !== 'native' && (
                          <Fragment>
                            <input
                              class="voice-field-input"
                              value={editingProfile.brain.model}
                              placeholder="模型 ID（如 gemini-2.5-flash / deepseek-v4-1-flash-261017）"
                              onInput={(e: any) => setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, model: e.target.value } })}
                            />
                            <select
                              class="voice-field-input"
                              value={editingProfile.brain.thinkingLevel || 'off'}
                              onChange={(e: any) => setEditingProfile({ ...editingProfile, brain: { ...editingProfile.brain, thinkingLevel: e.target.value } })}
                            >
                              <option value="off">思考档位：关闭思考（极速 ~1s，推荐随行口令）</option>
                              <option value="low">思考档位：low（轻量思考，3.x/4.x 最低档）</option>
                              <option value="medium">思考档位：medium</option>
                              <option value="high">思考档位：high（复杂多任务规划）</option>
                            </select>
                          </Fragment>
                        )}
                      </div>

                      {/* TTS */}
                      <div class="voice-stage-box">
                        <div class="voice-stage-title">🗣️ 3. 语音播报 (TTS · 嘴巴)</div>
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
                          <option value="native">系统原生语音合成（免 Key 免费）</option>
                          <option value="volcengine_tts">火山豆包 Seed-TTS 2.0</option>
                          <option value="gemini">Google Gemini TTS（自动转 WAV）</option>
                          <option value="openai_compat">OpenAI 兼容接口（/audio/speech）</option>
                        </select>
                        {renderCredSelect(editingProfile.tts.provider, editingProfile.tts.credId, v =>
                          setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, credId: v } }),
                        )}
                        {editingProfile.tts.provider !== 'native' && (
                          <div class="voice-two-col">
                            <input
                              class="voice-field-input"
                              value={editingProfile.tts.model}
                              placeholder="模型 / Resource ID"
                              onInput={(e: any) => setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, model: e.target.value } })}
                            />
                            <input
                              class="voice-field-input"
                              value={editingProfile.tts.voice || ''}
                              placeholder="音色 Speaker / Voice"
                              onInput={(e: any) => setEditingProfile({ ...editingProfile, tts: { ...editingProfile.tts, voice: e.target.value } })}
                            />
                          </div>
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
                        <div class="voice-row-main">聊天页「🔊 播报」使用 BYOK 语音合成</div>
                        <div class="voice-row-sub">默认关闭（保持免费系统语音）；开启后复用当前方案 TTS，失败自动降级</div>
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
                        <div class="voice-row-main">聊天页语音输入优先使用 BYOK 识别</div>
                        <div class="voice-row-sub">默认关闭（保持免费系统语音）；开启后可在聊天页复用云端 STT</div>
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

              {/* TAB 2: 密钥池 (BYOK) */}
              {labTab === 'keys' && (
                <div class="voice-tab-stack">
                  <div class="voice-security-banner">
                    🔐 所有密钥均在你的 Hub 服务端以 <strong>AES-256-GCM</strong> 加密落盘（权限 <code>0600</code>），保存后永不回显明文；同一服务商支持存多把 Key 随时热切。
                  </div>

                  {config.credentials.length > 0 && (
                    <div class="voice-card">
                      <div class="voice-card-title" style="margin-bottom:8px;">已保存密钥池 ({config.credentials.length})</div>
                      {config.credentials.map(c => (
                        <div key={c.id} class="voice-cred-item">
                          <div style="flex:1;min-width:0;">
                            <div class="voice-cred-title">
                              <span class="voice-prov-tag">{c.provider}</span>
                              <span>{c.label}</span>
                              {c.active && <span class="voice-active-tag">默认</span>}
                            </div>
                            <div class="voice-cred-sub">{c.authSummary}{c.baseUrl ? ` · ${c.baseUrl.replace(/^https?:\/\//, '').slice(0, 42)}` : ''}</div>
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

                  <div class="voice-card">
                    <div class="voice-card-title" style="margin-bottom:8px;">添加新密钥（开源中立 · 自由填任意厂商）</div>

                    <label class="voice-field-label">服务商协议类型</label>
                    <select class="voice-field-input" value={keyProvider} onChange={(e: any) => onSelectKeyProvider(e.target.value)}>
                      <option value="gemini">Google Gemini API（STT / 大脑 / TTS）</option>
                      <option value="openai_compat">OpenAI 兼容接口（DeepSeek / 方舟 Ark / OpenAI / Ollama）</option>
                      <option value="volcengine_asr">火山豆包语音识别 (Flash ASR · 独立权限池)</option>
                      <option value="volcengine_tts">火山豆包语音合成 (Seed-TTS 2.0 · 独立权限池)</option>
                    </select>
                    {selectedCatalog?.hint && <div class="voice-muted-note">{selectedCatalog.hint}</div>}

                    <label class="voice-field-label">自定义备注名</label>
                    <input
                      class="voice-field-input"
                      value={keyLabel}
                      placeholder="例如：我的主号 Key / 公司方舟 Key"
                      onInput={(e: any) => setKeyLabel(e.target.value)}
                    />

                    <label class="voice-field-label">接口 Base URL</label>
                    <input
                      class="voice-field-input"
                      value={keyBaseUrl}
                      placeholder="https://..."
                      onInput={(e: any) => setKeyBaseUrl(e.target.value)}
                    />
                    {selectedCatalog?.baseUrlExamples && selectedCatalog.baseUrlExamples.length > 1 && (
                      <div class="voice-chip-row">
                        {selectedCatalog.baseUrlExamples.map(ex => (
                          <button
                            key={ex.url}
                            type="button"
                            class="voice-quick-chip"
                            onClick={() => setKeyBaseUrl(ex.url)}
                          >
                            {ex.label}
                          </button>
                        ))}
                      </div>
                    )}

                    <label class="voice-field-label">
                      API Key {(keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts') ? '（或留空改填下方 AppID + Access Token）' : '（必填）'}
                    </label>
                    <input
                      type="password"
                      class="voice-field-input"
                      value={keyApiKey}
                      placeholder="粘贴密钥（只写不回显）"
                      onInput={(e: any) => setKeyApiKey(e.target.value)}
                    />

                    {(keyProvider === 'volcengine_asr' || keyProvider === 'volcengine_tts') && (
                      <Fragment>
                        <div class="voice-two-col">
                          <div>
                            <label class="voice-field-label">AppID（可选替代）</label>
                            <input
                              class="voice-field-input"
                              value={keyAppId}
                              placeholder="火山语音 AppID"
                              onInput={(e: any) => setKeyAppId(e.target.value)}
                            />
                          </div>
                          <div>
                            <label class="voice-field-label">Access Token</label>
                            <input
                              type="password"
                              class="voice-field-input"
                              value={keyAccessToken}
                              placeholder="火山 Access Token"
                              onInput={(e: any) => setKeyAccessToken(e.target.value)}
                            />
                          </div>
                        </div>
                        <label class="voice-field-label">Resource ID</label>
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
                        <label class="voice-field-label">默认模型（可选）</label>
                        <input
                          class="voice-field-input"
                          value={keyDefaultModel}
                          placeholder="留空则按方案指定"
                          onInput={(e: any) => setKeyDefaultModel(e.target.value)}
                        />
                      </div>
                      <div>
                        <label class="voice-field-label">默认音色（可选）</label>
                        <input
                          class="voice-field-input"
                          value={keyDefaultVoice}
                          placeholder="如 Kore / alloy / vv"
                          onInput={(e: any) => setKeyDefaultVoice(e.target.value)}
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      class="primary-block-btn"
                      disabled={savingKey}
                      onClick={() => void handleSaveCredential()}
                    >
                      {savingKey ? '正在加密保存…' : '🔐 加密存入密钥池'}
                    </button>
                  </div>
                </div>
              )}

              {/* TAB 3: 调试台 (Voice Lab Dry-Run) */}
              {labTab === 'bench' && (
                <div class="voice-tab-stack">
                  <div class="voice-card">
                    <div class="voice-toggle-row" style="padding-top:0;border-top:none;">
                      <div>
                        <div class="voice-row-main">🧪 试跑模式 (Dry-Run)</div>
                        <div class="voice-row-sub">完整跑通当前方案的模型与耗时打点，但绝不向电脑真实下发任何指令</div>
                      </div>
                      <input
                        type="checkbox"
                        class="voice-switch"
                        checked={benchDryRun}
                        onChange={(e: any) => setBenchDryRun(e.target.checked)}
                      />
                    </div>

                    <div class="voice-muted-note" style="margin-top:6px;">
                      当前被测方案：<strong>{activeProf.name}</strong>
                    </div>

                    <div class="voice-chip-row" style="margin-top:8px;">
                      {['现在有哪些待审批和运行中的任务？', '放行当前审批', '帮我新建任务跑一遍单测', '确认码 739'].map(sample => (
                        <button
                          key={sample}
                          type="button"
                          class="voice-quick-chip"
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
                        {benchRunning ? '⏳ 跑分测试中…' : '🚀 跑一轮大脑 + 语音测速'}
                      </button>
                      <button
                        type="button"
                        class={`voice-pill-btn ${benchRecording ? 'danger' : ''}`}
                        style="padding:10px 12px;"
                        disabled={benchRunning}
                        onClick={() => void toggleBenchVoiceCapture()}
                      >
                        {benchRecording ? '⏹ 停止并测全链路' : '🎙️ 录真声'}
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
          </div>
        </div>
      )}
    </Fragment>
  );
}
