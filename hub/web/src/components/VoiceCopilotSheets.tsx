import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyLangToDom, getLangPref } from '../utils/i18n.js';
import {
  WalkWavRecorder,
  WalkSpeechPlayer,
  WalkWakeLockManager,
  bindWalkMediaSession,
  canNativeAutoListenNow,
  claimNativeBackgroundWakeForCloudTts,
  isNativeIosShell,
  notifyNativeBackgroundWakeDone,
  playEarcon,
  setWalkAudioSessionMode,
  setWalkBackgroundKeepAlive,
} from '../voice/walkAudio';
import {
  VoiceProviderSheet,
  type VoiceConfigState,
  type VoicePrefs,
} from './VoiceProviderSheet';
import { resolveFeatureStageConfig } from '../voice/provider-routing.js';

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
    briefingDetail: 'detailed',
    autoVad: true,
    vadSilenceMs: 850,
    autoListenAfterBriefing: true,
    duckMusicMode: true,
    useByokForChatStt: false,
    useByokForChatTts: false,
    chatSttTarget: 'native',
    chatTtsTarget: 'native',
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

export function VoiceCopilotSheets() {
  const [walkOpen, setWalkOpen] = useState(false); // Mode active (engine + background audio + briefings)
  const [walkExpanded, setWalkExpanded] = useState(false); // Full-screen canvas vs minimized Apple Music-style Mini Bar
  const [chatScreenOpen, setChatScreenOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [labInitialView, setLabInitialView] = useState<'models' | 'walk' | 'chat' | 'add' | 'bench'>('walk');
  const [config, setConfig] = useState<VoiceConfigState>(DEFAULT_CONFIG);
  const [loadingCfg, setLoadingCfg] = useState(false);
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
  const [walkPrefsOpen, setWalkPrefsOpen] = useState(false);
  const [hubSummary, setHubSummary] = useState(() => summarizeHubState((window as any).__dshLastHubState));

  // Bench / Dry-Run Lab state
  const [benchDryRun, setBenchDryRun] = useState(true);
  const [benchText, setBenchText] = useState(() =>
    getLangPref() === 'en'
      ? 'What pending approvals and running tasks do I have?'
      : '现在有哪些待审批和运行中的任务？',
  );
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchRecording, setBenchRecording] = useState(false);
  const [benchReport, setBenchReport] = useState<any>(null);
  const [, setLangTick] = useState(() => getLangPref());

  useEffect(() => {
    const onLang = (ev: any) => {
      const next = String(ev?.detail || getLangPref());
      setLangTick(next);
      setBenchText(prev => {
        if (next === 'en' && prev === '现在有哪些待审批和运行中的任务？') {
          return 'What pending approvals and running tasks do I have?';
        }
        if (next === 'zh' && prev === 'What pending approvals and running tasks do I have?') {
          return '现在有哪些待审批和运行中的任务？';
        }
        return prev;
      });
    };
    window.addEventListener('dsh:lang-change', onLang);
    return () => window.removeEventListener('dsh:lang-change', onLang);
  }, []);

  // Re-apply English DOM translation after every Preact commit while Walk Mode (full or mini bar) is visible
  useEffect(() => {
    if (!walkOpen) return;
    const overlayEl = document.getElementById('walkModeOverlay');
    if (overlayEl) applyLangToDom(overlayEl, getLangPref());
    const miniEl = document.getElementById('walkMiniBar');
    if (miniEl) applyLangToDom(miniEl, getLangPref());
  });

  // Track whether mobile fullscreen chat view is open so the minimized Mini Bar moves cleanly below chat navbar
  useEffect(() => {
    const syncChatOpen = () => {
      const chatEl = document.getElementById('chatFullscreen');
      setChatScreenOpen(Boolean(chatEl && chatEl.classList.contains('open')));
    };
    syncChatOpen();
    const chatEl = document.getElementById('chatFullscreen');
    if (!chatEl || typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(syncChatOpen);
    mo.observe(chatEl, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // Broadcast Walk Mode live state so TopBar headphone icon reflects active / speaking / listening status
  useEffect(() => {
    document.body.classList.toggle('walk-minibar-active', Boolean(walkOpen && !walkExpanded));
    window.dispatchEvent(
      new CustomEvent('dsh:walk-state', {
        detail: { active: walkOpen, expanded: walkExpanded, phase: walkPhase },
      }),
    );
    return () => {
      document.body.classList.remove('walk-minibar-active');
    };
  }, [walkOpen, walkExpanded, walkPhase]);

  const recorderRef = useRef<WalkWavRecorder | null>(null);
  const playerRef = useRef<WalkSpeechPlayer | null>(null);
  const wakeRef = useRef<WalkWakeLockManager | null>(null);
  const nativeRecRef = useRef<any>(null);
  const voiceSessionIdRef = useRef(`walk_${Math.random().toString(36).slice(2, 10)}`);
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  const seenCompletedRef = useRef<Set<string>>(new Set());
  const recentPushAgentsRef = useRef<Map<string, number>>(new Map());
  const focusedApprovalRef = useRef<{ hostId: string; code: string; slot?: number; announcedAt?: number } | null>(null);
  const focusedSessionRef = useRef<{ hostId: string; agentId: string; title?: string; announcedAt: number } | null>(null);
  const briefingQueueRef = useRef<Array<{ kind: 'approval' | 'completed'; key: string; hostId: string; hostName: string; code?: string; agentId?: string; title?: string }>>([]);
  const drainingBriefingRef = useRef(false);
  const walkOpenRef = useRef(false);
  const walkPhaseRef = useRef(walkPhase);
  const configRef = useRef(config);
  const configLoadedRef = useRef(false);

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
        configLoadedRef.current = true;
        configRef.current = next;
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
    (window as any).openWalkMode = (opts?: { minimized?: boolean }) => {
      setWalkOpen(true);
      setWalkExpanded(!opts?.minimized);
      void refreshConfig(true);
    };
    (window as any).minimizeWalkMode = () => {
      setWalkPrefsOpen(false);
      setWalkExpanded(false);
    };
    (window as any).closeWalkMode = () => {
      setWalkPrefsOpen(false);
      setWalkExpanded(false);
      setWalkOpen(false);
    };
    (window as any).openVoiceLab = (tab?: 'models' | 'walk' | 'chat' | 'simple' | 'profiles' | 'keys' | 'bench' | 'add' | 'list') => {
      setSoundCheckMsg(null);
      const nextView =
        tab === 'models' || tab === 'keys'
          ? 'models'
          : tab === 'chat'
            ? 'chat'
            : tab === 'bench'
              ? 'bench'
              : tab === 'add'
                ? 'add'
                : 'walk';
      setLabInitialView(nextView);
      setLabOpen(true);
      void refreshConfig(false);
    };
    (window as any).closeVoiceLab = () => {
      setLabOpen(false);
    };
    (window as any).__dshRefreshVoiceConfig = () => refreshConfig(true);
    (window as any).__dshOnBackgroundPushWake = (payload?: any) => {
      if (!walkOpenRef.current) {
        notifyNativeBackgroundWakeDone();
        return false;
      }
      // Immediately disarm native Siri fallback whenever cloud TTS is configured (or config hasn't
      // finished hydrating yet), so Doubao / cloud voice ALWAYS wins instead of Apple machine voice!
      const ttsProv = configRef.current?.activeProfile?.tts?.provider || 'native';
      if (!configLoadedRef.current || ttsProv !== 'native') {
        claimNativeBackgroundWakeForCloudTts();
      }

      const mode = configRef.current?.prefs?.proactiveBriefing || 'approvals';
      const evType = String(payload?.type || '').trim();
      const hostId = String(payload?.hostId || '').trim();
      const agentId = String(payload?.agentId || '').trim();
      const code = String(payload?.code || '').trim().toUpperCase();

      // Fast-path: enqueue directly from APNs payload without waiting ~1.5s for full 390KB /api/state!
      let directEnqueued = false;
      if (mode !== 'manual' && hostId) {
        const snap = summarizeHubState((window as any).__dshLastHubState);
        const matchedHost = (Array.isArray((window as any).__dshLastHubState?.hosts)
          ? (window as any).__dshLastHubState.hosts.find((h: any) => h?.hostId === hostId)
          : null);
        const hostName = String(matchedHost?.hostName || hostId);
        if (evType === 'approval' && code) {
          const k = `${hostId}:${code}`;
          if (!seenApprovalsRef.current.has(k)) {
            seenApprovalsRef.current.add(k);
            briefingQueueRef.current.push({
              kind: 'approval',
              key: k,
              hostId,
              hostName,
              code,
              agentId,
              title: code,
            });
            directEnqueued = true;
          }
        } else if ((evType === 'completed' || evType === 'failed') && mode === 'all' && agentId) {
          const agentKey = `${hostId}:${agentId}`;
          const prevPushAt = recentPushAgentsRef.current.get(agentKey) || 0;
          if (Date.now() - prevPushAt > 12_000) {
            recentPushAgentsRef.current.set(agentKey, Date.now());
            const matchedTask = snap.completedKeys.find(c => c.hostId === hostId && c.agentId === agentId);
            briefingQueueRef.current.push({
              kind: 'completed',
              key: `push:${agentKey}:${Date.now()}`,
              hostId,
              hostName,
              agentId,
              title: matchedTask?.title || '',
            });
            directEnqueued = true;
          }
        }
      }

      if (directEnqueued && walkPhaseRef.current === 'idle') {
        void drainBriefingQueue();
      }

      const fetchFn = (window as any).fetchState;
      if (typeof fetchFn === 'function') {
        void Promise.resolve(fetchFn({ silent: true, forceFresh: true }))
          .catch(() => null)
          .finally(() => {
            setTimeout(() => {
              if (
                !drainingBriefingRef.current
                && briefingQueueRef.current.length === 0
                && walkPhaseRef.current === 'idle'
              ) {
                notifyNativeBackgroundWakeDone();
              }
            }, 1400);
          });
        return true;
      }
      if (!directEnqueued) {
        notifyNativeBackgroundWakeDone();
      }
      return directEnqueued;
    };
    (window as any).__dshWalkStartReplyForPush = (payload?: any) => {
      if (!walkOpenRef.current) return false;
      const hostId = String(payload?.hostId || '').trim();
      const agentId = String(payload?.agentId || '').trim();
      const code = String(payload?.code || '').trim().toUpperCase();
      if (hostId && agentId) {
        focusedSessionRef.current = { hostId, agentId, announcedAt: Date.now() };
      }
      if (hostId && code) {
        focusedApprovalRef.current = { hostId, code, announcedAt: Date.now() };
      }
      if (walkPhaseRef.current === 'speaking') {
        playerRef.current?.stop();
        setWalkPhase('idle');
      }
      setTimeout(() => {
        if (walkOpenRef.current && walkPhaseRef.current === 'idle') {
          void startWalkListening({ isAutoFollowUp: false });
        }
      }, 260);
      return true;
    };

    // Independent Chat Read-Aloud TTS helpers: ALWAYS check `chatTtsTarget` (independent of Walk Mode!)
    const resolveChatTtsStageOverride = () => {
      const cfg = configRef.current;
      const ttsTarget = String(cfg?.prefs?.chatTtsTarget || (cfg?.prefs?.useByokForChatTts ? 'follow_walk' : 'native'));
      return resolveFeatureStageConfig(ttsTarget, 'tts', cfg?.activeProfile, cfg?.credentials || []);
    };
    (window as any).__dshVoiceByokCanSpeak = () => Boolean(resolveChatTtsStageOverride());
    (window as any).__dshVoiceByokSpeak = async (text: string, onDone?: () => void) => {
      if (!configLoadedRef.current) {
        await refreshConfig(true);
      }
      const cfg = configRef.current;
      const stageOverride = resolveChatTtsStageOverride();
      if (!stageOverride) {
        return false;
      }
      const chunks = String(text || '')
        .split(/(?<=[。！？.!?\n])\s*/)
        .map(s => s.trim())
        .filter(s => Boolean(s) && /[\p{L}\p{N}]/u.test(s))
        .reduce<string[]>((acc, s) => {
          const lim = acc.length === 0 ? 48 : 160;
          if (!acc.length || acc[acc.length - 1].length + s.length > lim) acc.push(s);
          else acc[acc.length - 1] += s;
          return acc;
        }, []);
      if (!chunks.length) return false;
      await playerRef.current!.speakChunksProgressive(chunks, {
        useCloudTts: true,
        allowNativeFallback: false,
        speechRate: cfg.prefs.speechRate || 1.0,
        fetchTts: async (chunk, signal) => {
          const r = await apiCall('/api/voice/tts', {
            method: 'POST',
            signal,
            body: JSON.stringify({
              text: chunk,
              profileId: cfg.activeProfile.id,
              stageOverride,
            }),
          });
          return r.json().catch(() => ({ ok: false }));
        },
        onCloudTtsError: () => {
          toast('⚠️ 云端语音合成偶发波动，已自动跳过该句（未混入机器音）');
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

    // Independent Chat Voice Dictation helper: routes via `chatSttTarget` ('native' | 'follow_walk' | 'cred:<id>')
    let chatDictRecorder: WalkWavRecorder | null = null;
    let chatDictBtnId = '';
    (window as any).__dshVoiceByokToggleDictation = (
      targetInputId: string,
      btnId: string,
      showToastFn: (m: string) => void,
      onComposerInputFn: () => void,
    ) => {
      const cfg = configRef.current;
      const sttTarget = String(cfg?.prefs?.chatSttTarget || (cfg?.prefs?.useByokForChatStt ? 'follow_walk' : 'native'));
      const stageOverride = resolveFeatureStageConfig(sttTarget, 'stt', cfg?.activeProfile, cfg?.credentials || []);
      if (!stageOverride) {
        return false;
      }
      const btn = document.getElementById(btnId);
      const input = document.getElementById(targetInputId) as HTMLTextAreaElement | HTMLInputElement | null;
      if (!input) return false;

      if (chatDictRecorder?.isRecording()) {
        const prevBtn = document.getElementById(chatDictBtnId || btnId);
        prevBtn?.classList.remove('recording');
        const activeRec = chatDictRecorder;
        chatDictRecorder = null;
        chatDictBtnId = '';
        void activeRec.stopAsync().then(rec => {
          if (!rec || rec.byteLength < 1200) {
            showToastFn('⏹ 录音太短，已取消');
            return;
          }
          showToastFn('👂 云端语音识别中…');
          return apiCall('/api/voice/stt', {
            method: 'POST',
            body: JSON.stringify({
              audioBase64: rec.wavBase64,
              mimeType: 'audio/wav',
              profileId: cfg.activeProfile.id,
              stageOverride,
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
        });
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

    // Initial background sync once authenticated (fast hydration so Chat 🔊 Listen always uses cloud TTS)
    const initTimer = setTimeout(() => {
      void refreshConfig(true);
    }, 120);

    return () => {
      clearTimeout(initTimer);
      playerRef.current?.stop();
      recorderRef.current?.stop();
      void setWalkBackgroundKeepAlive(false, false, false);
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

  // WakeLock + AirPods MediaSession + Safari AudioSession + Native iOS Background Keepalive lifecycle
  useEffect(() => {
    (window as any).__dshWalkModeOpen = walkOpen;
    if (!walkOpen) {
      playerRef.current?.stop();
      stopAllListening();
      briefingQueueRef.current = [];
      drainingBriefingRef.current = false;
      focusedApprovalRef.current = null;
      focusedSessionRef.current = null;
      void setWalkBackgroundKeepAlive(false, false, false, 'manual');
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
    const duckMusic = configRef.current?.prefs?.duckMusicMode !== false;
    const keepMicWarm = Boolean(configRef.current?.prefs?.autoListenAfterBriefing);
    const proactiveBriefing = configRef.current?.prefs?.proactiveBriefing || 'approvals';
    const walkUsesCloudTts = (configRef.current?.activeProfile?.tts?.provider || 'native') !== 'native';
    if (duckMusic) {
      setWalkAudioSessionMode('ambient');
    }
    void setWalkBackgroundKeepAlive(true, duckMusic, keepMicWarm, proactiveBriefing, walkUsesCloudTts);

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

  // Keep native iOS background keepalive options in sync when user toggles footer switches inside Walk Mode
  useEffect(() => {
    if (!walkOpen) return;
    void setWalkBackgroundKeepAlive(
      true,
      config.prefs.duckMusicMode !== false,
      Boolean(config.prefs.autoListenAfterBriefing),
      config.prefs.proactiveBriefing || 'approvals',
      (config.activeProfile?.tts?.provider || 'native') !== 'native',
    );
  }, [walkOpen, config.prefs.duckMusicMode, config.prefs.autoListenAfterBriefing, config.prefs.proactiveBriefing, config.activeProfile?.tts?.provider]);

  const drainBriefingQueue = async () => {
    if (drainingBriefingRef.current || !walkOpenRef.current) return;
    if (walkPhaseRef.current !== 'idle') return;
    const nextItem = briefingQueueRef.current.shift();
    if (!nextItem) return;
    drainingBriefingRef.current = true;
    let startedAutoListen = false;
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
          detailLevel: cfg.prefs.briefingDetail || 'detailed',
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
      if (data?.focusedSession?.hostId && data?.focusedSession?.agentId) {
        focusedSessionRef.current = {
          hostId: String(data.focusedSession.hostId),
          agentId: String(data.focusedSession.agentId),
          title: String(data.focusedSession.title || nextItem.title || ''),
          announcedAt: Date.now(),
        };
      } else if (nextItem.kind === 'completed' && nextItem.hostId && nextItem.agentId) {
        focusedSessionRef.current = {
          hostId: nextItem.hostId,
          agentId: nextItem.agentId,
          title: nextItem.title || '',
          announcedAt: Date.now(),
        };
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

      // When user turned on `autoListenAfterBriefing`, allow hands-free follow-up after BOTH
      // approvals and task completions (silent 5.5s auto-exit if user doesn't speak).
      // Query native iOS shell first: if a foreground video app interrupted the warm mic,
      // skip background mic activation cleanly so foreground video restores to 100% immediately!
      const wantsAutoListen = Boolean(
        cfg.prefs.autoListenAfterBriefing
        && walkOpenRef.current
        && (nextItem.kind === 'approval' || nextItem.kind === 'completed' || Boolean(data?.expectReply)),
      );
      const micReadyForAutoListen = wantsAutoListen ? await canNativeAutoListenNow() : false;

      await speakWalkReply(chunks, undefined, {
        keepAudioSessionAfter: micReadyForAutoListen,
        allowNativeFallback: nextItem.kind === 'approval',
      });

      if (micReadyForAutoListen && walkOpenRef.current && walkPhaseRef.current === 'idle') {
        startedAutoListen = true;
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
      } else if (!startedAutoListen && briefingQueueRef.current.length === 0) {
        notifyNativeBackgroundWakeDone();
      }
    }
  };

  // Subscribe to live Hub SSE state updates for proactive Walk Mode briefings
  useEffect(() => {
    const onHubState = (ev: any) => {
      if (!configLoadedRef.current) {
        void refreshConfig(true);
      }
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
        const nowTs = Date.now();
        for (const c of snap.completedKeys) {
          if (seenCompletedRef.current.has(c.key)) continue;
          seenCompletedRef.current.add(c.key);
          // Avoid duplicate briefing if APNs fast-path just enqueued this exact task seconds ago
          const pushedAt = recentPushAgentsRef.current.get(`${c.hostId}:${c.agentId}`) || 0;
          if (nowTs - pushedAt < 18_000) continue;
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
    opts: { keepAudioSessionAfter?: boolean; allowNativeFallback?: boolean } = {},
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
      allowNativeFallback: Boolean(opts.allowNativeFallback),
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
      onCloudTtsError: () => {
        toast('⚠️ 豆包语音偶发波动，已跳过该段（未混入机器音）');
      },
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
      const recentFocused =
        focusedSessionRef.current && Date.now() - focusedSessionRef.current.announcedAt < 180_000
          ? focusedSessionRef.current
          : null;
      const res = await apiCall('/api/voice/turn', {
        method: 'POST',
        body: JSON.stringify({
          text: clean,
          voiceSessionId: voiceSessionIdRef.current,
          activeHostId: recentFocused?.hostId || snap.activeHostId,
          activeSessionId: recentFocused?.agentId || snap.activeSessionId,
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

      const wantsAutoListen = Boolean(
        data.expectReply
        && configRef.current.prefs.autoListenAfterBriefing
        && walkOpenRef.current,
      );
      const shouldAutoListen = wantsAutoListen ? await canNativeAutoListenNow() : false;

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
    if (isAutoFollowUp) {
      const canListen = await canNativeAutoListenNow();
      if (!canListen) {
        if (configRef.current?.prefs?.duckMusicMode !== false) {
          setWalkAudioSessionMode('ambient');
        }
        return;
      }
    }
    const sttProvider = configRef.current.activeProfile?.stt?.provider || 'native';
    if (sttProvider === 'native') {
      startNativeWalkSpeech(isAutoFollowUp);
      return;
    }
    try {
      // Switch iOS Safari AudioSession BEFORE playing earcon or opening microphone
      setWalkAudioSessionMode('play-and-record');
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
    playerRef.current?.unlockAudio();
    // Instant Barge-in: tapping orb while speaking cuts off TTS immediately and starts listening!
    if (walkPhaseRef.current === 'speaking') {
      playerRef.current?.stop();
    }
    if (walkPhaseRef.current === 'listening') {
      if (recorderRef.current?.isRecording()) {
        const res = await recorderRef.current.stopAsync();
        if (res) void handleWalkWavReady(res, false);
        else setWalkPhase('idle');
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
    // Synchronously unlock iOS Safari / PWA Web Audio BEFORE any async fetch()
    playerRef.current?.unlockAudio();
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
          const extraHint = prof.tts?.provider === 'volcengine_tts'
            ? '（若该火山密钥仅开了听写未开播报，可先把上方「播报」切为「手机自带免费」）'
            : '';
          const msg = `播报失败：${data?.error || '请检查密钥与权限'}${extraHint}`;
          setSoundCheckMsg({ ok: false, text: msg });
          toast(`❌ 播报失败：${data?.error || '请检查配置'}`);
          return;
        }
        if (data.useBrowserSpeech || !data.audioBase64) {
          void playerRef.current?.speakChunksProgressive([sampleLine], {
            useCloudTts: false,
            speechRate: configRef.current.prefs.speechRate || 1.0,
          });
          setSoundCheckMsg({ ok: true, text: '免费本机播报已开始（请确保手机未静音）' });
          return;
        }
        const played = await playerRef.current?.playAudioBase64(data.audioBase64, data.mimeType);
        if (!played) {
          setSoundCheckMsg({ ok: false, text: `云端音频已返回 (${data.latencyMs ?? 0}ms)，但手机拦截了播放，请检查静音键或再点一次试听` });
          return;
        }
        setSoundCheckMsg({ ok: true, text: `云端人声正常 (${data.latencyMs ?? 0}ms)` });
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
            setSoundCheckMsg({ ok: true, text: `手机播报正常 · 大脑已连通 (${testData.latencyMs ?? 0}ms)` });
          } else {
            const msg = `手机已播报，但大脑测试失败：${testData?.error || '请检查密钥或模型名'}`;
            setSoundCheckMsg({ ok: false, text: msg });
            toast(`⚠️ 大脑异常：${testData?.error || '请检查配置'}`);
          }
          return;
        }
      }
      setSoundCheckMsg({ ok: true, text: '免费本机播报已开始（请确保手机未静音）' });
    } catch (err: any) {
      const msg = `试听异常：${err?.message || '网络失败'}`;
      setSoundCheckMsg({ ok: false, text: msg });
      toast(`❌ ${msg}`);
    } finally {
      setSoundChecking(false);
    }
  };

  const handleConfigChange = (next: VoiceConfigState) => {
    setConfig(next);
    (window as any).__dshVoiceConfig = next;
    window.dispatchEvent(new CustomEvent('dsh:voice-config', { detail: next }));
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
      const rec = await recorderRef.current?.stopAsync();
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

  const activeProf = config.activeProfile || DEFAULT_CONFIG.activeProfile;
  const nativeShell = isNativeIosShell();
  const openLabFromWalk = () => {
    setSoundCheckMsg(null);
    setLabInitialView('walk');
    setLabOpen(true);
    void refreshConfig(false);
  };
  const orbScale = walkPhase === 'listening' ? 1 + Math.min(0.16, micLevel * 0.22) : 1;
  const briefingLabel =
    config.prefs.proactiveBriefing === 'approvals'
      ? '仅审批播报'
      : config.prefs.proactiveBriefing === 'all'
        ? '审批与完成播报'
        : '手动播报';
  const detailMode = config.prefs.briefingDetail || 'detailed';
  const detailLabel =
    detailMode === 'verbatim'
      ? '原文精读'
      : detailMode === 'concise'
        ? '极简一句'
        : '详细要点';
  const prefsSummaryParts: string[] = [briefingLabel, detailLabel];
  if (config.prefs.autoListenAfterBriefing) prefsSummaryParts.push('自动开麦');
  if (config.prefs.duckMusicMode) prefsSummaryParts.push('听歌混音');
  const prefsSummaryText = prefsSummaryParts.slice(0, 3).join(' · ');

  const miniBarTitle =
    walkPhase === 'speaking'
      ? '边走边听 · 正在播报'
      : walkPhase === 'listening'
        ? '边走边听 · 正在聆听…'
        : walkPhase === 'thinking' || walkPhase === 'transcribing'
          ? '边走边听 · 处理中…'
          : '边走边听 · 待命';
  const miniBarPreview =
    walkPhase === 'listening'
      ? (lastUserText || '说完自动发送 · 点右侧方块停止')
      : (lastReplyText || '轻点展开语音台');

  const statusMetaParts: string[] = [];
  if (walkPhase === 'idle') {
    statusMetaParts.push('就绪');
    if (nativeShell) statusMetaParts.push('后台常驻');
    if (wakeLocked) statusMetaParts.push('常亮');
  } else if (walkPhase === 'listening') {
    statusMetaParts.push('正在聆听…');
  } else if (walkPhase === 'transcribing') {
    statusMetaParts.push('正在转写…');
  } else if (walkPhase === 'thinking') {
    statusMetaParts.push('思考中…');
  } else if (walkPhase === 'speaking') {
    statusMetaParts.push('正在播报 · 点字幕静音');
  }
  const statusSubline = statusMetaParts.join(' · ');
  const isLongReply = (lastReplyText || '').length > 96;

  return (
    <Fragment>
      {/* 1. 全屏极简留白随行语音台（展开态；点左上角收起成悬浮迷你条，点右上角关闭才真正退出模式） */}
      {walkOpen && walkExpanded && (
        <div
          id="walkModeOverlay"
          class={`walk-mode-overlay walk-phase-${walkPhase}`}
          role="dialog"
          aria-label="随行耳机模式"
          onClick={() => {
            if (walkPrefsOpen) setWalkPrefsOpen(false);
          }}
        >
          {/* 顶部极简导航：左收起 · 中配置标题与状态 · 右配置+结束 */}
          <div class="walk-top-bar" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              class="walk-circle-nav-btn"
              id="walkMinimizeBtn"
              aria-label="收起"
              title="收起至悬浮条（后台继续播报）"
              onClick={() => {
                setWalkPrefsOpen(false);
                setWalkExpanded(false);
                toast('🎧 已收起至悬浮条，后台播报继续运行');
              }}
            >
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>

            <button
              type="button"
              class="walk-profile-trigger"
              onClick={openLabFromWalk}
              title="点击切换语音配置"
            >
              <span class="walk-profile-title-row">
                <span class="walk-profile-name">{activeProf.name}</span>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </span>
              <span class={`walk-profile-subline phase-${walkPhase}`}>
                <span class={`walk-status-dot phase-${walkPhase}`} />
                <span>{statusSubline}</span>
              </span>
            </button>

            <div class="walk-top-right-group">
              <button
                type="button"
                class="walk-circle-nav-btn"
                id="walkOpenLabBtn"
                aria-label="语音配置"
                title="语音配置"
                onClick={openLabFromWalk}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
                  <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
                </svg>
              </button>
              <button
                type="button"
                class="walk-circle-nav-btn danger"
                id="walkExitBtn"
                aria-label="结束边走边听"
                title="结束边走边听"
                onClick={() => {
                  setWalkPrefsOpen(false);
                  setWalkExpanded(false);
                  setWalkOpen(false);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                  <line x1="12" y1="2" x2="12" y2="12" />
                </svg>
              </button>
            </div>
          </div>

          {/* 中央大留白无框字幕区（播报时轻点静音） */}
          <div
            class="walk-stage"
            onClick={() => {
              if (walkPrefsOpen) {
                setWalkPrefsOpen(false);
                return;
              }
              if (walkPhase === 'speaking') {
                playerRef.current?.stop();
                setWalkPhase('idle');
                toast('🔇 已跳过当前播报');
              }
            }}
          >
            <button
              type="button"
              class={`walk-status-strip ${hubSummary.approvals.length > 0 ? 'has-approvals' : ''}`}
              onClick={e => {
                e.stopPropagation();
                setWalkPrefsOpen(false);
                void runBriefingTurn();
              }}
            >
              <span class={hubSummary.approvals.length > 0 ? 'walk-strip-amber' : ''}>
                {`${hubSummary.approvals.length} 项待审批`}
              </span>
              <span class="walk-strip-sep">·</span>
              <span>{`${hubSummary.runningCount} 个任务运行中`}</span>
            </button>

            {activePin && (
              <div class="walk-pin-card" onClick={e => e.stopPropagation()}>
                <div class="walk-pin-head">
                  <span>高危操作语音确认码</span>
                  <span class="walk-pin-timer">{`${pinSecLeft}s 后过期`}</span>
                </div>
                <div class="walk-pin-digits">{activePin.pin.split('').join(' ')}</div>
                <div class="walk-pin-desc">
                  {`${activePin.summary || activePin.code} · 请念出上方 3 位数字放行，或说「拒绝」`}
                </div>
                <div class="walk-pin-actions">
                  <button type="button" class="walk-pin-btn-deny" onClick={() => void handleClearPin(true)}>
                    立即拒绝
                  </button>
                  <button type="button" class="walk-pin-btn-cancel" onClick={() => void handleClearPin(false)}>
                    取消弹窗
                  </button>
                </div>
              </div>
            )}

            <div class="walk-subtitle-box">
              {lastUserText && <div class="walk-user-line">{`你：${lastUserText}`}</div>}
              <div class={`walk-reply-line ${isLongReply ? 'compact' : ''}`}>{lastReplyText}</div>
              {(lastActionBadge || lastLatencyBadge) && (
                <div class="walk-meta-row">
                  {lastActionBadge && <span class="walk-action-tag">{lastActionBadge}</span>}
                  {lastLatencyBadge && <span class="walk-latency-tag">{lastLatencyBadge}</span>}
                </div>
              )}
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

          {/* 底部对称三键控制台 + 可展开偏好胶囊 */}
          <div class="walk-orb-dock" onClick={e => e.stopPropagation()}>
            <div class="walk-controls-row">
              <div class="walk-side-btn-wrap">
                <button
                  type="button"
                  id="walkKeyboardBtn"
                  class={`walk-side-btn ${walkTextInputOpen ? 'active' : ''}`}
                  aria-label="静音打字"
                  onClick={() => {
                    setWalkPrefsOpen(false);
                    setWalkTextInputOpen(v => !v);
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="2" y="5" width="20" height="14" rx="3" />
                    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4" />
                  </svg>
                </button>
                <span class="walk-side-lbl">{walkTextInputOpen ? '收起打字' : '静音打字'}</span>
              </div>

              <div class={`walk-mic-ring phase-${walkPhase}`}>
                <button
                  type="button"
                  id="walkMicOrbBtn"
                  class={`walk-mic-orb phase-${walkPhase}`}
                  style={`transform: scale(${orbScale.toFixed(3)});`}
                  aria-label={walkPhase === 'listening' ? '停止说话并发送' : '开始说话'}
                  onClick={() => {
                    if (walkPrefsOpen) setWalkPrefsOpen(false);
                    void toggleWalkMic();
                  }}
                >
                  {walkPhase === 'listening' ? (
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="3" />
                    </svg>
                  ) : walkPhase === 'thinking' || walkPhase === 'transcribing' ? (
                    <svg class="walk-orb-spinner" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : (
                    <svg width="31" height="31" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="9" y="2" width="6" height="12" rx="3" />
                      <path d="M5 10a7 7 0 0 0 14 0" />
                      <path d="M12 17v5" />
                      <path d="M9 22h6" />
                    </svg>
                  )}
                </button>
              </div>

              <div class="walk-side-btn-wrap">
                <button
                  type="button"
                  id="walkBriefingBtn"
                  class="walk-side-btn"
                  aria-label="汇报进度"
                  onClick={() => {
                    setWalkPrefsOpen(false);
                    void runBriefingTurn();
                  }}
                >
                  {hubSummary.approvals.length > 0 && (
                    <span class="walk-side-badge">{hubSummary.approvals.length > 9 ? '9+' : hubSummary.approvals.length}</span>
                  )}
                  <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="5 4 15 12 5 20 5 4" />
                    <line x1="19" y1="5" x2="19" y2="19" />
                  </svg>
                </button>
                <span class="walk-side-lbl">汇报进度</span>
              </div>
            </div>

            <div class={`walk-mic-caption phase-${walkPhase}`}>
              {walkPhase === 'listening'
                ? '说完自动发送 · 或轻点红色方块停止'
                : walkPhase === 'speaking'
                  ? '轻点圆麦随时插话 · 点字幕静音'
                  : walkPhase === 'transcribing' || walkPhase === 'thinking'
                    ? '正在处理你的语音指令…'
                    : '轻点开始说话 · 戴耳机随时插话'}
            </div>

            <div class="walk-prefs-wrap">
              {walkPrefsOpen && (
                <div class="walk-prefs-drawer" role="region" aria-label="随行偏好设置">
                  <button
                    type="button"
                    id="walkBriefingDetailTile"
                    class={`walk-pref-tile full-span ${detailMode !== 'concise' ? 'on' : ''}`}
                    onClick={() => {
                      const order: Array<'detailed' | 'verbatim' | 'concise'> = ['detailed', 'verbatim', 'concise'];
                      const cur = (config.prefs.briefingDetail || 'detailed') as 'detailed' | 'verbatim' | 'concise';
                      const next = order[(order.indexOf(cur) + 1) % order.length];
                      void updatePrefPatch({ briefingDetail: next });
                    }}
                  >
                    <span class="walk-pref-ico">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="4" y1="6" x2="20" y2="6" />
                        <line x1="4" y1="12" x2="18" y2="12" />
                        <line x1="4" y1="18" x2="14" y2="18" />
                      </svg>
                    </span>
                    <span class="walk-pref-copy">
                      <span class="walk-pref-t1">播报详略（点击切换）</span>
                      <span class="walk-pref-t2">
                        {detailMode === 'verbatim'
                          ? '原文精读 · 几乎不压缩，保留原话直读（最快）'
                          : detailMode === 'concise'
                            ? '极简一句 · 约 60–80 字快速摘要'
                            : '详细要点 · 约 140–280 字讲清结论与选项'}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    class={`walk-pref-tile ${config.prefs.proactiveBriefing !== 'manual' ? 'on' : ''}`}
                    onClick={() => {
                      const order: Array<'approvals' | 'all' | 'manual'> = ['approvals', 'all', 'manual'];
                      const next = order[(order.indexOf(config.prefs.proactiveBriefing) + 1) % order.length];
                      void updatePrefPatch({ proactiveBriefing: next });
                    }}
                  >
                    <span class="walk-pref-ico">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                      </svg>
                    </span>
                    <span class="walk-pref-copy">
                      <span class="walk-pref-t1">主动播报</span>
                      <span class="walk-pref-t2">
                        {config.prefs.proactiveBriefing === 'approvals'
                          ? '仅审批提醒'
                          : config.prefs.proactiveBriefing === 'all'
                            ? '审批与完成'
                            : '仅手动播报'}
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    class={`walk-pref-tile ${config.prefs.autoListenAfterBriefing ? 'on' : ''}`}
                    onClick={() => void updatePrefPatch({ autoListenAfterBriefing: !config.prefs.autoListenAfterBriefing })}
                  >
                    <span class="walk-pref-ico">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path d="M5 10a7 7 0 0 0 14 0" />
                      </svg>
                    </span>
                    <span class="walk-pref-copy">
                      <span class="walk-pref-t1">连续对话</span>
                      <span class="walk-pref-t2">{config.prefs.autoListenAfterBriefing ? '播完自动开麦' : '手动点开麦'}</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    class={`walk-pref-tile ${config.prefs.duckMusicMode ? 'on' : ''}`}
                    onClick={() => {
                      const nextDuck = !config.prefs.duckMusicMode;
                      setWalkAudioSessionMode(nextDuck ? 'ambient' : 'auto');
                      void updatePrefPatch({ duckMusicMode: nextDuck });
                    }}
                  >
                    <span class="walk-pref-ico">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
                        <path d="M9 18V5l12-2v13" />
                        <circle cx="6" cy="18" r="3" />
                        <circle cx="18" cy="16" r="3" />
                      </svg>
                    </span>
                    <span class="walk-pref-copy">
                      <span class="walk-pref-t1">听歌混音</span>
                      <span class="walk-pref-t2">{config.prefs.duckMusicMode ? '压低背景音乐' : '独占音频'}</span>
                    </span>
                  </button>

                  <button
                    type="button"
                    class={`walk-pref-tile ${config.prefs.autoVad ? 'on' : ''}`}
                    onClick={() => void updatePrefPatch({ autoVad: !config.prefs.autoVad })}
                  >
                    <span class="walk-pref-ico">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
                        <circle cx="12" cy="12" r="9" />
                        <path d="M9 10v4M15 10v4" />
                      </svg>
                    </span>
                    <span class="walk-pref-copy">
                      <span class="walk-pref-t1">停顿发送</span>
                      <span class="walk-pref-t2">{config.prefs.autoVad ? '自动停顿发送' : '手动点停止'}</span>
                    </span>
                  </button>
                </div>
              )}

              <button
                type="button"
                id="walkPrefsToggleBtn"
                class={`walk-prefs-capsule ${walkPrefsOpen ? 'open' : ''}`}
                aria-expanded={walkPrefsOpen}
                onClick={() => {
                  setWalkTextInputOpen(false);
                  setWalkPrefsOpen(v => !v);
                }}
              >
                <span class="walk-prefs-left">
                  <span class="walk-prefs-dots" aria-hidden="true">
                    <i class={config.prefs.proactiveBriefing !== 'manual' ? '' : 'off'} />
                    <i class={config.prefs.autoListenAfterBriefing ? '' : 'off'} />
                    <i class={config.prefs.duckMusicMode ? '' : 'off'} />
                    <i class={config.prefs.autoVad ? '' : 'off'} />
                  </span>
                  <span class="walk-prefs-summary">{prefsSummaryText}</span>
                </span>
                <svg class="walk-prefs-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
                  <path d="M18 15l-6-6-6 6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 1b. 收起态：Apple Music 式迷你悬浮语音条（边看对话/文件边听播报，点空白展开，右侧一键插话或关闭） */}
      {walkOpen && !walkExpanded && (
        <div
          id="walkMiniBar"
          class={`walk-mini-bar phase-${walkPhase} ${chatScreenOpen ? 'in-chat' : ''}`}
          role="region"
          aria-label="边走边听悬浮条"
        >
          <button
            type="button"
            class="walk-mini-main"
            id="walkMiniExpandBtn"
            onClick={() => setWalkExpanded(true)}
            title="点击展开全屏语音台"
          >
            <span class={`walk-mini-orb phase-${walkPhase}`} aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
              </svg>
            </span>
            <span class="walk-mini-copy">
              <span class="walk-mini-title-row">
                <span class="walk-mini-title">{miniBarTitle}</span>
                {hubSummary.approvals.length > 0 && (
                  <span class="walk-mini-badge">{`${hubSummary.approvals.length} 待审批`}</span>
                )}
              </span>
              <span class="walk-mini-sub">{miniBarPreview}</span>
            </span>
          </button>

          <div class="walk-mini-actions">
            <button
              type="button"
              id="walkMiniMicBtn"
              class={`walk-mini-btn primary phase-${walkPhase}`}
              aria-label={walkPhase === 'speaking' ? '跳过播报' : walkPhase === 'listening' ? '停止说话并发送' : '开始说话'}
              title={walkPhase === 'speaking' ? '跳过当前播报' : walkPhase === 'listening' ? '停止并发送' : '直接说话'}
              onClick={e => {
                e.stopPropagation();
                if (walkPhase === 'speaking') {
                  playerRef.current?.stop();
                  setWalkPhase('idle');
                  toast('🔇 已跳过当前播报');
                } else {
                  void toggleWalkMic();
                }
              }}
            >
              {walkPhase === 'listening' ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="3" />
                </svg>
              ) : walkPhase === 'speaking' ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <line x1="23" y1="9" x2="17" y2="15" />
                  <line x1="17" y1="9" x2="23" y2="15" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="2" width="6" height="12" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <path d="M12 17v5" />
                </svg>
              )}
            </button>
            <button
              type="button"
              id="walkMiniEndBtn"
              class="walk-mini-btn end"
              aria-label="结束边走边听"
              title="结束边走边听"
              onClick={e => {
                e.stopPropagation();
                setWalkPrefsOpen(false);
                setWalkExpanded(false);
                setWalkOpen(false);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* 2. 独立拆出的 DeepSeek-Harness 风格 Provider 列表与默认路由配置抽屉 */}
      <VoiceProviderSheet
        open={labOpen}
        onClose={() => setLabOpen(false)}
        config={config}
        loadingCfg={loadingCfg}
        initialView={labInitialView}
        onConfigChange={handleConfigChange}
        onUpdatePrefs={updatePrefPatch}
        onSoundCheck={handleQuickSoundCheck}
        onUnlockAudio={() => playerRef.current?.unlockAudio()}
        onPlayTestAudio={(b64, mime) => playerRef.current?.playAudioBase64(b64, mime) ?? Promise.resolve(false)}
        soundChecking={soundChecking}
        soundCheckMsg={soundCheckMsg}
        onClearSoundCheckMsg={() => setSoundCheckMsg(null)}
        onRunBenchTurn={() => runBenchTurn()}
        onToggleBenchVoice={toggleBenchVoiceCapture}
        benchDryRun={benchDryRun}
        onSetBenchDryRun={setBenchDryRun}
        benchText={benchText}
        onSetBenchText={setBenchText}
        benchRunning={benchRunning}
        benchRecording={benchRecording}
        benchReport={benchReport}
        apiCall={apiCall}
        toast={toast}
      />
    </Fragment>
  );
}
