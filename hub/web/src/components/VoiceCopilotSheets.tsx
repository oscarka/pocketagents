import { h, Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  WalkWavRecorder,
  WalkSpeechPlayer,
  WalkWakeLockManager,
  bindWalkMediaSession,
  isNativeIosShell,
  playEarcon,
  setWalkAudioSessionMode,
  setWalkBackgroundKeepAlive,
} from '../voice/walkAudio';
import {
  VoiceProviderSheet,
  type VoiceConfigState,
  type VoicePrefs,
} from './VoiceProviderSheet';

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

export function VoiceCopilotSheets() {
  const [walkOpen, setWalkOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [labInitialView, setLabInitialView] = useState<'list' | 'add' | 'bench'>('list');
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
  const [hubSummary, setHubSummary] = useState(() => summarizeHubState((window as any).__dshLastHubState));

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
    (window as any).openVoiceLab = (tab?: 'simple' | 'profiles' | 'keys' | 'bench' | 'add' | 'list') => {
      setSoundCheckMsg(null);
      setLabInitialView(tab === 'bench' ? 'bench' : tab === 'add' ? 'add' : 'list');
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
        const activeRec = chatDictRecorder;
        chatDictRecorder = null;
        chatDictBtnId = '';
        void activeRec.stopAsync().then(rec => {
          if (!rec || rec.byteLength < 1200) {
            showToastFn('⏹ 录音太短，已取消');
            return;
          }
          showToastFn('👂 BYOK 云端识别中…');
          return apiCall('/api/voice/stt', {
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

    // Initial background sync once authenticated
    const initTimer = setTimeout(() => {
      void refreshConfig(true);
    }, 800);

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
    if (!walkOpen) {
      playerRef.current?.stop();
      stopAllListening();
      briefingQueueRef.current = [];
      drainingBriefingRef.current = false;
      focusedApprovalRef.current = null;
      void setWalkBackgroundKeepAlive(false, false, false);
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
    if (duckMusic) {
      setWalkAudioSessionMode('ambient');
    }
    void setWalkBackgroundKeepAlive(true, duckMusic, keepMicWarm);

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
    );
  }, [walkOpen, config.prefs.duckMusicMode, config.prefs.autoListenAfterBriefing]);

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
    setLabInitialView('list');
    setLabOpen(true);
    void refreshConfig(false);
  };
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
                onClick={openLabFromWalk}
                title="点击快速切换语音配置"
              >
                <span>🎧</span>
                <span class="walk-profile-name">{activeProf.name}</span>
                <span>▾</span>
              </button>
              {hubSummary.approvals.length > 0 && (
                <span class="walk-badge-warn">⚠️ {hubSummary.approvals.length} 待审批</span>
              )}
              {nativeShell && <span class="walk-badge-subtle">🔒 后台常驻</span>}
              {wakeLocked && <span class="walk-badge-subtle">🔆 常亮</span>}
            </div>
            <div class="walk-top-right">
              <button
                type="button"
                class="walk-top-btn"
                id="walkOpenLabBtn"
                onClick={openLabFromWalk}
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
