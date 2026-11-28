import { h, Fragment } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { applyLangToDom, getLangPref } from '../utils/i18n.js';
import {
  WalkBargeInMonitor,
  WalkWavRecorder,
  WalkSpeechPlayer,
  WalkWakeLockManager,
  bindWalkMediaSession,
  canNativeAutoListenNow,
  claimNativeBackgroundWakeForCloudTts,
  claimNativeBriefingKey,
  delegateNativeBackgroundBriefing,
  drainNativeSpokenBriefings,
  hasNativeZeroWebViewBackgroundBriefing,
  isNativeIosShell,
  notifyNativeBackgroundWakeDone,
  playEarcon,
  postNativeVoiceDiag,
  setWalkAudioSessionMode,
  setWalkBackgroundKeepAlive,
} from '../voice/walkAudio';
import { evaluateBargeInUtterance } from '../voice/bargeInGate.js';
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

interface DraftCard {
  id: string;
  status: 'collecting' | 'awaiting_confirm';
  hostId: string;
  hostName: string;
  workspaceMode: '' | 'existing' | 'new';
  cwd: string;
  workspaceLabel: string;
  newWorkspaceName: string;
  createDir: boolean;
  harness: string;
  harnessLabel: string;
  prompt: string;
  missingFields: string[];
}

interface BroadcastQueueItem {
  id: string;
  kind: 'approval' | 'completed';
  priority: number; // 0 = approval (P0), 1 = completed (P1)
  key: string;
  hostId: string;
  hostName: string;
  code?: string;
  agentId?: string;
  title: string;
  spokenText?: string;
  spokenChunks?: string[];
  status: 'pending' | 'playing' | 'partial' | 'done' | 'skipped';
  createdAt: number;
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

function getVoiceAuthToken(): string {
  try {
    const fn = (window as any).__dshGetVoiceAuthToken;
    if (typeof fn === 'function') {
      const tok = String(fn() || '').trim();
      if (tok) return tok;
    }
    return String(localStorage.getItem('dsh_hub_token') || '').trim();
  } catch {
    return '';
  }
}

function buildWalkNativeExtraOpts(cfg: VoiceConfigState | null | undefined) {
  const origin = (() => {
    try { return typeof window !== 'undefined' && window.location ? String(window.location.origin || '') : ''; } catch { return ''; }
  })();
  return {
    apiOrigin: origin,
    authToken: getVoiceAuthToken(),
    profileId: String(cfg?.activeProfile?.id || ''),
    briefingDetail: String(cfg?.prefs?.briefingDetail || 'detailed'),
    speechRate: Number(cfg?.prefs?.speechRate) || 1.0,
    autoPlayWalkReplies: cfg?.prefs?.autoPlayWalkReplies !== false,
  };
}

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
  const [walkOpen, setWalkOpenState] = useState(false); // Mode active (engine + background audio + briefings)
  const [walkExpanded, setWalkExpanded] = useState(false); // Full-screen canvas vs minimized Apple Music-style Mini Bar
  const [aiTabActive, setAiTabActive] = useState(false); // Docked inside bottom center AI Tab
  const [chatScreenOpen, setChatScreenOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [labInitialView, setLabInitialView] = useState<'models' | 'walk' | 'chat' | 'add' | 'bench'>('walk');
  const [config, setConfig] = useState<VoiceConfigState>(DEFAULT_CONFIG);
  const [loadingCfg, setLoadingCfg] = useState(false);
  const [soundChecking, setSoundChecking] = useState(false);
  const [soundCheckMsg, setSoundCheckMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Walk mode live state
  const [walkPhase, setWalkPhaseState] = useState<'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking'>('idle');
  const [micLevel, setMicLevel] = useState(0);
  const [wakeLocked, setWakeLocked] = useState(false);
  const [lastUserText, setLastUserText] = useState('');
  const [lastReplyText, setLastReplyText] = useState('我在听，直接说话就行：可核对新建任务、审批放行、查进度或操控任意电脑会话。');
  const [lastActionBadge, setLastActionBadge] = useState('');
  const [lastLatencyBadge, setLastLatencyBadge] = useState('');
  const [walkReceipts, setWalkReceipts] = useState<Array<{ id: string; time: string; heard: string; badge: string; ok: boolean }>>([]);
  const [activeDraft, setActiveDraft] = useState<DraftCard | null>(null);
  const [draftSubmitting, setDraftSubmitting] = useState(false);
  const [queueItems, setQueueItems] = useState<BroadcastQueueItem[]>([]);
  const [queueCursor, setQueueCursor] = useState(-1);
  const [queuePaused, setQueuePaused] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
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
  const bargeInMonitorRef = useRef<WalkBargeInMonitor | null>(null);
  const playerRef = useRef<WalkSpeechPlayer | null>(null);
  const wakeRef = useRef<WalkWakeLockManager | null>(null);
  const nativeRecRef = useRef<any>(null);
  const activeSpeakingTextRef = useRef('');
  const bargeInTriggeredRef = useRef(false);
  const bargeInVerifyingRef = useRef(false);
  const voiceSessionIdRef = useRef(`walk_${Math.random().toString(36).slice(2, 10)}`);
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  const seenCompletedRef = useRef<Set<string>>(new Set());
  const recentPushAgentsRef = useRef<Map<string, number>>(new Map());
  const focusedApprovalRef = useRef<{ hostId: string; code: string; slot?: number; announcedAt?: number } | null>(null);
  const focusedSessionRef = useRef<{ hostId: string; agentId: string; title?: string; announcedAt: number } | null>(null);
  const briefingQueueRef = useRef<Array<{ kind: 'approval' | 'completed'; key: string; hostId: string; hostName: string; code?: string; agentId?: string; title?: string; queueItemId?: string }>>([]);
  const queueItemsRef = useRef<BroadcastQueueItem[]>([]);
  const queueCursorRef = useRef(-1);
  const queuePausedRef = useRef(false);
  const activeQueueItemIdRef = useRef('');
  const drainingBriefingRef = useRef(false);
  const walkOpenRef = useRef(false);
  const walkPhaseRef = useRef(walkPhase);
  const aiTabActiveRef = useRef(false);
  const walkTextInputOpenRef = useRef(false);
  const userPausedHandsFreeRef = useRef(false);
  const lastKeepAliveSigRef = useRef('');
  const keepAlivePromiseRef = useRef<Promise<any> | null>(null);
  const configRef = useRef(config);
  const configLoadedRef = useRef(false);

  // Synchronous ref + state updaters so async post-TTS transitions (e.g. speakWalkReply -> startWalkListening)
  // NEVER observe a stale 'speaking' phase or stale walkOpen flag before Preact flushes its next render/effect commit!
  const setWalkOpen = (next: boolean) => {
    walkOpenRef.current = next;
    setWalkOpenState(next);
  };
  const setWalkPhase = (next: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking') => {
    walkPhaseRef.current = next;
    setWalkPhaseState(next);
  };

  useEffect(() => { walkOpenRef.current = walkOpen; }, [walkOpen]);
  useEffect(() => { walkPhaseRef.current = walkPhase; }, [walkPhase]);
  useEffect(() => { aiTabActiveRef.current = aiTabActive; }, [aiTabActive]);
  useEffect(() => { walkTextInputOpenRef.current = walkTextInputOpen; }, [walkTextInputOpen]);
  useEffect(() => { configRef.current = config; }, [config]);

  if (!recorderRef.current) recorderRef.current = new WalkWavRecorder();
  if (!bargeInMonitorRef.current) bargeInMonitorRef.current = new WalkBargeInMonitor();
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
        if (data.activeDraft !== undefined) setActiveDraft(data.activeDraft || null);
        playerRef.current?.setPlaybackRate(next.prefs.speechRate || 1.0);
        (window as any).__dshVoiceConfig = next;
        window.dispatchEvent(new CustomEvent('dsh:voice-config', { detail: next }));
      }
    } catch {
      // keep fallback native config when offline / unauthenticated
    } finally {
      if (!silent) setLoadingCfg(false);
    }
  };

  // Sync with bottom center AI tab (`switchTab('ai')`)
  // Doubao-style hands-free UX: tapping the center AI icon unlocks audio, waits for config + native
  // keepalive session setup to settle (so iOS setBackgroundKeepAlive NEVER collides with live recording!),
  // and immediately begins listening when `autoVad` is enabled.
  useEffect(() => {
    const onTabChange = (ev: any) => {
      const nextTab = String(ev?.detail?.tab || '');
      if (nextTab === 'ai') {
        aiTabActiveRef.current = true;
        userPausedHandsFreeRef.current = false;
        playerRef.current?.unlockAudio();
        setAiTabActive(true);
        setWalkOpen(true);
        setWalkExpanded(true);
        void (async () => {
          await refreshConfig(true);
          // Let React commit `[walkOpen]` keepalive effect, then await its native bridge promise
          await new Promise(resolve => setTimeout(resolve, 120));
          if (keepAlivePromiseRef.current) {
            await keepAlivePromiseRef.current.catch(() => {});
          }
          await new Promise(resolve => setTimeout(resolve, 60));
          if (
            aiTabActiveRef.current
            && walkOpenRef.current
            && walkPhaseRef.current === 'idle'
            && configRef.current?.prefs?.autoVad
            && !userPausedHandsFreeRef.current
            && !walkTextInputOpenRef.current
          ) {
            void startWalkListening({ isAutoFollowUp: true, noSpeechTimeoutMs: 14000, silentOnNoMic: true });
          }
        })();
      } else {
        aiTabActiveRef.current = false;
        setAiTabActive(false);
        setWalkExpanded(false);
        if (walkPhaseRef.current === 'listening') {
          stopAllListening();
        }
      }
    };
    window.addEventListener('dsh:tab-change', onTabChange);
    return () => window.removeEventListener('dsh:tab-change', onTabChange);
  }, []);

  // Expose global openers & chat BYOK helpers on window
  useEffect(() => {
    (window as any).openWalkMode = (opts?: { minimized?: boolean }) => {
      setWalkOpen(true);
      if (opts?.minimized) {
        setWalkExpanded(false);
      } else if (typeof (window as any).switchTab === 'function') {
        (window as any).switchTab('ai');
      } else {
        setWalkExpanded(true);
      }
      void refreshConfig(true);
    };
    (window as any).minimizeWalkMode = () => {
      setWalkPrefsOpen(false);
      setWalkExpanded(false);
      if (aiTabActive && typeof (window as any).switchTab === 'function') {
        (window as any).switchTab('chats');
      }
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
    const applyNativeSpokenBriefings = (items: any[], { triggerAutoListen = false } = {}) => {
      if (!Array.isArray(items) || items.length === 0) return true;
      let latestFreshSpokenKind = '';
      let latestFreshSpokenAt = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const kind = String(item.kind || '');
        const hostId = String(item.hostId || '');
        const code = String(item.code || '').trim().toUpperCase();
        const agentId = String(item.agentId || '');
        const spokenReply = String(item.spokenReply || '').trim();
        const spokenAt = Number(item.spokenAt) || Date.now();
        if (kind === 'approval' && hostId && code) {
          const k = `${hostId}:${code}`;
          seenApprovalsRef.current.add(k);
          briefingQueueRef.current = briefingQueueRef.current.filter(
            q => !(q.kind === 'approval' && q.hostId === hostId && String(q.code || '').toUpperCase() === code),
          );
        } else if (hostId && agentId) {
          recentPushAgentsRef.current.set(`${hostId}:${agentId}`, spokenAt);
          briefingQueueRef.current = briefingQueueRef.current.filter(
            q => !(q.kind === 'completed' && q.hostId === hostId && q.agentId === agentId),
          );
        }
        if (item.focusedApproval && typeof item.focusedApproval === 'object') {
          focusedApprovalRef.current = item.focusedApproval;
        }
        if (item.focusedSession?.hostId && item.focusedSession?.agentId) {
          focusedSessionRef.current = {
            hostId: String(item.focusedSession.hostId),
            agentId: String(item.focusedSession.agentId),
            title: String(item.focusedSession.title || ''),
            announcedAt: spokenAt,
          };
        } else if (kind === 'completed' && hostId && agentId) {
          focusedSessionRef.current = {
            hostId,
            agentId,
            announcedAt: spokenAt,
          };
        }
        if (spokenReply) {
          setLastReplyText(spokenReply);
          setLastActionBadge(
            kind === 'approval'
              ? `🔔 ${item.approval?.slot ? `${item.approval.slot}号` : '后台已播'}待审批 ${code}`
              : `✅ 后台已播报${item.summarizedByBrain ? ' · AI 摘要' : ''}`,
          );
        }
        if (spokenAt > latestFreshSpokenAt && (kind === 'approval' || kind === 'completed')) {
          latestFreshSpokenAt = spokenAt;
          latestFreshSpokenKind = kind;
        }
      }
      // If Native Swift zero-WebView briefing JUST finished speaking (e.g. locked-screen AirPods)
      // and user has `autoListenAfterBriefing` enabled, open the mic immediately for hands-free reply!
      const isFresh = latestFreshSpokenAt > 0 && Math.abs(Date.now() - latestFreshSpokenAt) < 4500;
      if (
        triggerAutoListen
        && isFresh
        && latestFreshSpokenKind
        && walkOpenRef.current
        && walkPhaseRef.current === 'idle'
        && configRef.current?.prefs?.autoListenAfterBriefing
      ) {
        void startWalkListening({ isAutoFollowUp: true });
      }
      return true;
    };
    (window as any).__dshOnNativeBackgroundBriefingsSynced = (items: any[]) =>
      applyNativeSpokenBriefings(items, { triggerAutoListen: true });
    const onVisSyncNative = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void drainNativeSpokenBriefings().then(items => {
          if (items.length > 0) applyNativeSpokenBriefings(items, { triggerAutoListen: false });
        });
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisSyncNative);
    }
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

    // Independent Chat Voice Dictation & Hold-to-Talk helper: routes via `chatSttTarget` ('native' | 'follow_walk' | 'cred:<id>')
    const resolveChatSttStageOverride = () => {
      const cfg = configRef.current;
      const sttTarget = String(cfg?.prefs?.chatSttTarget || (cfg?.prefs?.useByokForChatStt ? 'follow_walk' : 'native'));
      return resolveFeatureStageConfig(sttTarget, 'stt', cfg?.activeProfile, cfg?.credentials || []);
    };
    const postCloudSttWithRetry = async (wavBase64: string, stageOverride: any) => {
      const cfg = configRef.current;
      let lastRes: any = { ok: false, error: '网络异常' };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        try {
          const r = await apiCall('/api/voice/stt', {
            method: 'POST',
            body: JSON.stringify({
              audioBase64: wavBase64,
              mimeType: 'audio/wav',
              profileId: cfg.activeProfile.id,
              ...(stageOverride ? { stageOverride } : {}),
            }),
          });
          const data = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
          if (r.ok && data?.ok) return data;
          lastRes = data || { ok: false, error: `HTTP ${r.status}` };
          if (r.status >= 500 || r.status === 429) continue;
          return lastRes;
        } catch (err: any) {
          lastRes = { ok: false, error: err?.message || '网络异常' };
        }
      }
      return lastRes;
    };

    (window as any).__dshVoiceByokStt = {
      canUse: () => Boolean(resolveChatSttStageOverride()),
      getProviderLabel: () => {
        const st = resolveChatSttStageOverride();
        if (!st) return '';
        if (st.provider === 'volcengine_asr') return '豆包';
        if (st.provider === 'gemini') return 'Gemini';
        return '云端';
      },
      createSession: ({ onLevel }: { onLevel?: (lvl: number) => void } = {}) => {
        const stageOverride = resolveChatSttStageOverride();
        const rec = new WalkWavRecorder();
        let cancelled = false;
        let started = false;
        let stopped = false;
        return {
          start: async () => {
            if (!stageOverride) throw new Error('未配置云端语音听写');
            if (cancelled || stopped) return;
            setWalkAudioSessionMode('play-and-record');
            started = true;
            await rec.start({ autoVad: false, maxDurationMs: 60000, onLevel });
          },
          cancel: () => {
            cancelled = true;
            stopped = true;
            try { rec.stop(); } catch {}
            if (configRef.current?.prefs?.duckMusicMode !== false) {
              setWalkAudioSessionMode('ambient');
            }
          },
          stopAndTranscribe: async ({ tailGraceMs = 150 }: { tailGraceMs?: number } = {}) => {
            if (cancelled || stopped || !started) {
              return { ok: true, text: '', silence: true, cancelled: true };
            }
            stopped = true;
            if (tailGraceMs > 0) {
              await new Promise(resolve => setTimeout(resolve, tailGraceMs));
            }
            if (cancelled) {
              try { rec.stop(); } catch {}
              return { ok: true, text: '', silence: true, cancelled: true };
            }
            const wav = await rec.stopAsync().catch(() => null);
            if (configRef.current?.prefs?.duckMusicMode !== false) {
              setWalkAudioSessionMode('ambient');
            }
            if (!wav || wav.byteLength < 1200) {
              return { ok: true, text: '', silence: true, tooShort: true };
            }
            return postCloudSttWithRetry(wav.wavBase64, stageOverride);
          },
        };
      },
    };

    let chatDictRecorder: WalkWavRecorder | null = null;
    let chatDictBtnId = '';
    (window as any).__dshVoiceByokToggleDictation = (
      targetInputId: string,
      btnId: string,
      showToastFn: (m: string) => void,
      onComposerInputFn: () => void,
    ) => {
      const stageOverride = resolveChatSttStageOverride();
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
        void new Promise(resolve => setTimeout(resolve, 150))
          .then(() => activeRec.stopAsync())
          .then(rec => {
            if (!rec || rec.byteLength < 1200) {
              showToastFn('⏹ 录音太短，已取消');
              return;
            }
            showToastFn('👂 云端语音识别中…');
            return postCloudSttWithRetry(rec.wavBase64, stageOverride).then(data => {
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
            });
          })
          .catch(() => showToastFn('⚠️ 网络异常，云端识别失败'));
        return true;
      }

      chatDictRecorder = new WalkWavRecorder();
      chatDictBtnId = btnId;
      btn?.classList.add('recording');
      showToastFn('🎙️ 云端录音中…说完再点一次发送转写');
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
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisSyncNative);
      }
      playerRef.current?.stop();
      bargeInMonitorRef.current?.stop();
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
      lastKeepAliveSigRef.current = '';
      keepAlivePromiseRef.current = setWalkBackgroundKeepAlive(false, false, false, 'manual');
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
    const extraOpts = buildWalkNativeExtraOpts(configRef.current);
    const keepAliveSig = JSON.stringify([true, duckMusic, keepMicWarm, proactiveBriefing, walkUsesCloudTts, extraOpts]);
    lastKeepAliveSigRef.current = keepAliveSig;
    if (walkPhaseRef.current !== 'listening' && walkPhaseRef.current !== 'speaking') {
      keepAlivePromiseRef.current = setWalkBackgroundKeepAlive(true, duckMusic, keepMicWarm, proactiveBriefing, walkUsesCloudTts, extraOpts);
    }
    void drainNativeSpokenBriefings().then(items => {
      if (items.length > 0 && typeof (window as any).__dshOnNativeBackgroundBriefingsSynced === 'function') {
        (window as any).__dshOnNativeBackgroundBriefingsSynced(items);
      }
    });

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

  // Keep native iOS background keepalive options in sync when user toggles footer switches or config hydrates.
  // CRITICAL: NEVER invoke setBackgroundKeepAlive while `listening` or `speaking` — on iOS PocketAgentsShell v1.1.6,
  // setBackgroundKeepAlive resets AVAudioSession to idle A2DP mix mode and freezes an active AVAudioEngine recording tap!
  useEffect(() => {
    if (!walkOpen) return;
    if (walkPhase === 'listening' || walkPhase === 'speaking' || walkPhaseRef.current === 'listening' || walkPhaseRef.current === 'speaking') {
      return;
    }
    const duckMusic = config.prefs.duckMusicMode !== false;
    const keepMicWarm = Boolean(config.prefs.autoListenAfterBriefing);
    const proactiveBriefing = config.prefs.proactiveBriefing || 'approvals';
    const walkUsesCloudTts = (config.activeProfile?.tts?.provider || 'native') !== 'native';
    const extraOpts = buildWalkNativeExtraOpts(config);
    const sig = JSON.stringify([true, duckMusic, keepMicWarm, proactiveBriefing, walkUsesCloudTts, extraOpts]);
    if (sig === lastKeepAliveSigRef.current) return;
    lastKeepAliveSigRef.current = sig;
    keepAlivePromiseRef.current = setWalkBackgroundKeepAlive(true, duckMusic, keepMicWarm, proactiveBriefing, walkUsesCloudTts, extraOpts);
  }, [
    walkOpen,
    walkPhase,
    config.prefs.duckMusicMode,
    config.prefs.autoListenAfterBriefing,
    config.prefs.proactiveBriefing,
    config.prefs.briefingDetail,
    config.prefs.speechRate,
    config.prefs.autoPlayWalkReplies,
    config.activeProfile?.id,
    config.activeProfile?.tts?.provider,
  ]);

  const syncQueueState = (nextList: BroadcastQueueItem[], nextCursor = queueCursorRef.current) => {
    const trimmed = nextList.slice(-20);
    queueItemsRef.current = trimmed;
    const clampedCursor = trimmed.length === 0 ? -1 : Math.max(0, Math.min(trimmed.length - 1, nextCursor));
    queueCursorRef.current = clampedCursor;
    setQueueItems(trimmed);
    setQueueCursor(clampedCursor);
  };

  const updateQueueItemStatus = (itemId: string, patch: Partial<BroadcastQueueItem>) => {
    if (!itemId) return;
    const next = queueItemsRef.current.map(it => (it.id === itemId ? { ...it, ...patch } : it));
    syncQueueState(next);
  };

  const replayQueueItemAt = async (idx: number, { prefixResume = false } = {}) => {
    const list = queueItemsRef.current;
    if (idx < 0 || idx >= list.length) {
      toast('📋 队列里没有更多条目了');
      return;
    }
    const item = list[idx];
    syncQueueState(
      list.map((it, i) => (i === idx ? { ...it, status: 'playing' } : it)),
      idx,
    );
    activeQueueItemIdRef.current = item.id;
    let text = String(item.spokenText || '').trim();
    let chunks = Array.isArray(item.spokenChunks) && item.spokenChunks.length > 0 ? item.spokenChunks : [];
    if (!text) {
      try {
        const res = await apiCall('/api/voice/briefing', {
          method: 'POST',
          body: JSON.stringify({
            kind: item.kind,
            hostId: item.hostId,
            code: item.code || '',
            agentId: item.agentId || '',
            profileId: configRef.current.activeProfile.id,
            voiceSessionId: voiceSessionIdRef.current,
            detailLevel: configRef.current.prefs.briefingDetail || 'detailed',
          }),
        });
        const data = await res.json().catch(() => null);
        text = String(data?.spokenReply || `${item.hostName}：${item.title}`).trim();
        chunks = Array.isArray(data?.spokenChunks) && data.spokenChunks.length > 0 ? data.spokenChunks : [text];
        if (data?.focusedApproval) focusedApprovalRef.current = data.focusedApproval;
      } catch {
        text = `${item.hostName}：${item.title}`;
        chunks = [text];
      }
      updateQueueItemStatus(item.id, { spokenText: text, spokenChunks: chunks });
    }
    const spoken = prefixResume && item.status === 'partial'
      ? `刚才没说完，补充一下：${text}`
      : text;
    const playChunks = prefixResume && item.status === 'partial' ? [spoken] : chunks;
    setLastReplyText(spoken);
    setLastActionBadge(
      item.kind === 'approval'
        ? `🔔 第 ${idx + 1}/${list.length} 条 · 待审批 ${item.code || ''}`
        : `✅ 第 ${idx + 1}/${list.length} 条 · 任务完成`,
    );
    await speakWalkReply(playChunks, undefined, { allowNativeFallback: item.kind === 'approval' });
    if (bargeInTriggeredRef.current) {
      updateQueueItemStatus(item.id, { status: 'partial' });
    } else {
      updateQueueItemStatus(item.id, { status: 'done' });
    }
  };

  const applyPlaybackControl = async (ctrl: { kind: string; speechRate?: number; spokenReply?: string }) => {
    if (!ctrl || !ctrl.kind) return;
    if (ctrl.kind === 'set_speed' && typeof ctrl.speechRate === 'number') {
      const rate = playerRef.current?.setPlaybackRate(ctrl.speechRate) ?? ctrl.speechRate;
      setConfig(prev => {
        const next = { ...prev, prefs: { ...prev.prefs, speechRate: rate } };
        configRef.current = next;
        return next;
      });
      toast(`⏩ 播报语速已调至 ${rate}x`);
      return;
    }
    if (ctrl.kind === 'handsfree_pause') {
      playerRef.current?.stop();
      setWalkPhase('idle');
      toast('⏸️ 已静音待命，轻点圆麦可继续对话');
      return;
    }
    if (ctrl.kind === 'queue_pause') {
      queuePausedRef.current = true;
      setQueuePaused(true);
      playerRef.current?.stop();
      if (activeQueueItemIdRef.current) {
        updateQueueItemStatus(activeQueueItemIdRef.current, { status: 'partial' });
      }
      setWalkPhase('idle');
      toast('⏸️ 已暂停播报队列');
      return;
    }
    if (ctrl.kind === 'queue_resume') {
      queuePausedRef.current = false;
      setQueuePaused(false);
      const list = queueItemsRef.current;
      const nextIdx = list.findIndex(it => it.status === 'partial' || it.status === 'pending');
      if (nextIdx >= 0) {
        void replayQueueItemAt(nextIdx, { prefixResume: true });
      } else if (briefingQueueRef.current.length > 0) {
        void drainBriefingQueue();
      } else {
        toast('📋 当前没有待播报条目');
      }
      return;
    }
    if (ctrl.kind === 'queue_next') {
      playerRef.current?.stop();
      if (activeQueueItemIdRef.current) {
        updateQueueItemStatus(activeQueueItemIdRef.current, { status: 'skipped' });
      }
      queuePausedRef.current = false;
      setQueuePaused(false);
      const list = queueItemsRef.current;
      const cur = queueCursorRef.current;
      const nextIdx = list.findIndex((it, i) => i > cur && it.status !== 'done' && it.status !== 'skipped');
      if (nextIdx >= 0) {
        void replayQueueItemAt(nextIdx);
      } else if (cur + 1 < list.length) {
        void replayQueueItemAt(cur + 1);
      } else if (briefingQueueRef.current.length > 0) {
        void drainBriefingQueue();
      } else {
        setWalkPhase('idle');
        toast('📋 已经是最后一条了');
      }
      return;
    }
    if (ctrl.kind === 'queue_prev') {
      playerRef.current?.stop();
      queuePausedRef.current = false;
      setQueuePaused(false);
      const prevIdx = Math.max(0, queueCursorRef.current - 1);
      if (queueItemsRef.current.length > 0) {
        void replayQueueItemAt(prevIdx);
      } else {
        toast('📋 暂无上一条记录');
      }
      return;
    }
    if (ctrl.kind === 'queue_repeat') {
      playerRef.current?.stop();
      queuePausedRef.current = false;
      setQueuePaused(false);
      const cur = queueCursorRef.current >= 0 ? queueCursorRef.current : queueItemsRef.current.length - 1;
      if (cur >= 0 && queueItemsRef.current[cur]) {
        void replayQueueItemAt(cur);
      } else if (lastReplyText) {
        void speakWalkReply([lastReplyText]);
      }
    }
  };

  const handleDraftCardAction = async (action: 'confirm' | 'cancel') => {
    if (draftSubmitting) return;
    if (walkPhaseRef.current === 'listening') {
      stopAllListening();
    }
    setDraftSubmitting(true);
    try {
      const res = await apiCall('/api/voice/draft/action', {
        method: 'POST',
        body: JSON.stringify({
          voiceSessionId: voiceSessionIdRef.current,
          action,
          dryRun: false,
        }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      if (!res.ok || !data?.ok) {
        toast(`⚠️ ${data?.error || '操作失败'}`);
        return;
      }
      setActiveDraft(data.draftCard || null);
      const reply = String(data.spokenReply || (action === 'confirm' ? '已创建任务。' : '已取消新建任务。'));
      setLastReplyText(reply);
      const badge = action === 'confirm' ? '✨ 已确认创建任务' : '🚫 已取消新建草稿';
      setLastActionBadge(badge);
      playEarcon(action === 'confirm' ? 'pin_ok' : 'done');
      const d = new Date();
      const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
      setWalkReceipts(prev => [
        { id: `${Date.now()}_card`, time: timeStr, heard: action === 'confirm' ? '点击确认创建' : '点击取消草稿', badge, ok: action === 'confirm' },
        ...prev,
      ].slice(0, 3));
      const chunks = Array.isArray(data.spokenChunks) && data.spokenChunks.length > 0 ? data.spokenChunks : [reply];
      void speakWalkReply(chunks);
    } finally {
      setDraftSubmitting(false);
    }
  };

  const drainBriefingQueue = async () => {
    if (drainingBriefingRef.current || !walkOpenRef.current || queuePausedRef.current) return;
    if (walkPhaseRef.current !== 'idle') return;
    const nextItem = briefingQueueRef.current.shift();
    if (!nextItem) return;
    drainingBriefingRef.current = true;
    let startedAutoListen = false;
    const qId = nextItem.queueItemId || '';
    if (qId) {
      activeQueueItemIdRef.current = qId;
      const idx = queueItemsRef.current.findIndex(it => it.id === qId);
      syncQueueState(
        queueItemsRef.current.map(it => (it.id === qId ? { ...it, status: 'playing' } : it)),
        idx >= 0 ? idx : queueCursorRef.current,
      );
    }
    try {
      const cfg = configRef.current;
      const duckMusic = cfg.prefs.duckMusicMode !== false;
      const dedupeKey = nextItem.kind === 'approval' && nextItem.code
        ? `approval:${nextItem.hostId}:${String(nextItem.code).toUpperCase()}`
        : `completed:${nextItem.hostId}:${nextItem.agentId || ''}`;

      // When backgrounded inside PocketAgentsShell v1.1.5+, hand off directly to Native Swift
      // URLSession + AVAudioPlayer so iOS WKWebView suspension can NEVER freeze mid-briefing!
      const isHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (isHidden && hasNativeZeroWebViewBackgroundBriefing()) {
        const delegated = await delegateNativeBackgroundBriefing({
          kind: nextItem.kind,
          hostId: nextItem.hostId,
          hostName: nextItem.hostName,
          code: nextItem.code || '',
          agentId: nextItem.agentId || '',
          title: nextItem.title || '',
          dedupeKey,
        });
        if (delegated) {
          return;
        }
      }

      // Atomic cross-layer dedupe: skip if Native Swift already spoke this exact approval/task while backgrounded
      const claimed = await claimNativeBriefingKey(dedupeKey);
      if (!claimed) {
        return;
      }

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
      if (qId) {
        updateQueueItemStatus(qId, { spokenText, spokenChunks: chunks });
      }
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

      if (bargeInTriggeredRef.current) {
        if (qId) updateQueueItemStatus(qId, { status: 'partial' });
        startedAutoListen = true;
        return;
      }
      if (qId) updateQueueItemStatus(qId, { status: 'done' });

      const canListenAfterSpeak = wantsAutoListen
        ? (micReadyForAutoListen || await canNativeAutoListenNow())
        : false;
      if (canListenAfterSpeak && walkOpenRef.current && walkPhaseRef.current === 'idle') {
        startedAutoListen = true;
        postNativeVoiceDiag('auto_listen_after_briefing', `kind=${nextItem.kind} phase=${walkPhaseRef.current}`);
        void startWalkListening({ isAutoFollowUp: true });
      } else if (wantsAutoListen) {
        postNativeVoiceDiag(
          'auto_listen_skipped',
          `kind=${nextItem.kind} can=${canListenAfterSpeak ? 1 : 0} open=${walkOpenRef.current ? 1 : 0} phase=${walkPhaseRef.current}`,
        );
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
      const addedQueueItems: BroadcastQueueItem[] = [];
      for (const a of snap.approvals) {
        const k = `${a.hostId}:${a.code}`;
        if (seenApprovalsRef.current.has(k)) continue;
        seenApprovalsRef.current.add(k);
        const qItemId = `qi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        addedQueueItems.push({
          id: qItemId,
          kind: 'approval',
          priority: 0,
          key: k,
          hostId: a.hostId,
          hostName: a.hostName,
          code: a.code,
          agentId: a.agentId,
          title: a.title || a.code,
          status: 'pending',
          createdAt: Date.now(),
        });
        // P0 approvals go ahead of pending completed items while keeping FIFO among approvals
        const insertIdx = briefingQueueRef.current.findIndex(q => q.kind !== 'approval');
        const entry = {
          kind: 'approval' as const,
          key: k,
          hostId: a.hostId,
          hostName: a.hostName,
          code: a.code,
          agentId: a.agentId,
          title: a.title,
          queueItemId: qItemId,
        };
        if (insertIdx >= 0) briefingQueueRef.current.splice(insertIdx, 0, entry);
        else briefingQueueRef.current.push(entry);
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
          const qItemId = `qi_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          addedQueueItems.push({
            id: qItemId,
            kind: 'completed',
            priority: 1,
            key: c.key,
            hostId: c.hostId,
            hostName: c.hostName,
            agentId: c.agentId,
            title: c.title || '任务完成',
            status: 'pending',
            createdAt: Date.now(),
          });
          briefingQueueRef.current.push({
            kind: 'completed',
            key: c.key,
            hostId: c.hostId,
            hostName: c.hostName,
            agentId: c.agentId,
            title: c.title,
            queueItemId: qItemId,
          });
          enqueued = true;
        }
      }

      if (addedQueueItems.length > 0) {
        syncQueueState([...queueItemsRef.current, ...addedQueueItems]);
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
    bargeInMonitorRef.current?.stop();
    if (recorderRef.current?.isRecording()) {
      recorderRef.current.stop();
    }
    if (nativeRecRef.current) {
      try { nativeRecRef.current.stop(); } catch {}
      nativeRecRef.current = null;
    }
    setMicLevel(0);
  };

  const handleVerifiedBargeInCandidate = async (rec: { wavBase64: string; byteLength: number }) => {
    if (
      !walkOpenRef.current
      || walkPhaseRef.current !== 'speaking'
      || bargeInTriggeredRef.current
      || bargeInVerifyingRef.current
    ) {
      return;
    }
    if (!rec?.wavBase64 || rec.byteLength < 2000) return;
    bargeInVerifyingRef.current = true;
    // Softly lower TTS volume while Doubao verifies the utterance — NEVER hard-stop until verified!
    playerRef.current?.setVolume(0.25);
    try {
      const cfg = configRef.current;
      const res = await apiCall('/api/voice/stt', {
        method: 'POST',
        body: JSON.stringify({
          audioBase64: rec.wavBase64,
          mimeType: 'audio/wav',
          profileId: cfg.activeProfile.id,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!walkOpenRef.current || walkPhaseRef.current !== 'speaking' || bargeInTriggeredRef.current) {
        return;
      }
      const rawText = res.ok && data?.ok && !data?.silence ? String(data.text || '').trim() : '';
      const hasPendingApproval = Boolean(
        focusedApprovalRef.current
        || summarizeHubState((window as any).__dshLastHubState).approvals.length > 0,
      );
      const verdict = evaluateBargeInUtterance(rawText, activeSpeakingTextRef.current, { hasPendingApproval });
      if (!verdict.accept) {
        postNativeVoiceDiag('barge_in_rejected', `reason=${verdict.reason} app=${hasPendingApproval ? 1 : 0} txt=${rawText.slice(0, 32)}`);
        playerRef.current?.setVolume(1.0);
        return;
      }

      // Verified real user speech! Stop TTS cleanly and execute immediately.
      bargeInTriggeredRef.current = true;
      bargeInMonitorRef.current?.stop();
      playerRef.current?.stop();
      playerRef.current?.setVolume(1.0);
      postNativeVoiceDiag('barge_in_accepted', `reason=${verdict.reason} stopOnly=${verdict.stopOnly ? 1 : 0} len=${verdict.cleaned.length}`);

      if (verdict.stopOnly) {
        setLastUserText(verdict.cleaned);
        setLastActionBadge('🔇 已语音打断播报');
        setWalkPhase('idle');
        playEarcon('done');
        if (cfg.prefs.duckMusicMode !== false) {
          setWalkAudioSessionMode('ambient');
        }
        return;
      }

      playEarcon('pin_ok');
      const wavKb = Math.max(1, Math.round(rec.byteLength / 1024));
      void handleWalkUserText(verdict.cleaned, data?.latencyMs ?? 0, wavKb);
    } catch {
      if (walkPhaseRef.current === 'speaking' && !bargeInTriggeredRef.current) {
        playerRef.current?.setVolume(1.0);
      }
    } finally {
      bargeInVerifyingRef.current = false;
    }
  };

  const speakWalkReply = async (
    chunks: string[],
    onFirstTtsMs?: (ms: number) => void,
    opts: { keepAudioSessionAfter?: boolean; allowNativeFallback?: boolean; enableBargeIn?: boolean } = {},
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
    const hasCloudStt = Boolean(cfg.activeProfile?.stt?.provider && cfg.activeProfile.stt.provider !== 'native');
    activeSpeakingTextRef.current = (chunks || []).join(' ');
    bargeInTriggeredRef.current = false;
    bargeInVerifyingRef.current = false;
    playerRef.current?.setVolume(1.0);
    setWalkPhase('speaking');

    // Start verified voice barge-in monitor while speaking (only stops playback after Doubao confirms
    // a real command or >=4-char non-echo utterance — ignores coughs, fillers, and speaker echo!)
    const shouldMonitorBargeIn = Boolean(
      opts.enableBargeIn !== false
      && walkOpenRef.current
      && cfg.prefs.autoListenAfterBriefing
      && hasCloudStt,
    );
    if (shouldMonitorBargeIn) {
      void canNativeAutoListenNow().then(canNow => {
        if (!canNow || !walkOpenRef.current || walkPhaseRef.current !== 'speaking' || bargeInTriggeredRef.current) {
          return;
        }
        void bargeInMonitorRef.current?.start({
          minSpeechMs: 420,
          vadSilenceMs: 700,
          maxDurationMs: 10000,
          rmsThreshold: 0.028,
          onCandidate: rec => {
            void handleVerifiedBargeInCandidate(rec);
          },
        });
      });
    }

    try {
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
    } finally {
      bargeInMonitorRef.current?.stop();
      playerRef.current?.setVolume(1.0);
      if (walkPhaseRef.current === 'speaking') {
        setWalkPhase('idle');
      }
    }
  };

  const handleWalkUserText = async (
    spokenText: string,
    sttMs: number | null = null,
    wavKb: number | null = null,
    fromTextInput = false,
  ) => {
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
      if (data.draftCard !== undefined) {
        setActiveDraft(data.draftCard || null);
      }
      if (data.focusedSession?.hostId && data.focusedSession?.agentId) {
        focusedSessionRef.current = {
          hostId: String(data.focusedSession.hostId),
          agentId: String(data.focusedSession.agentId),
          title: String(data.focusedSession.title || ''),
          announcedAt: Date.now(),
        };
      }
      if (data.nextFocusedApproval !== undefined) {
        focusedApprovalRef.current = data.nextFocusedApproval || null;
      } else if (data.execution?.executed) {
        focusedApprovalRef.current = null;
      }

      const pushReceipt = (heard: string, badge: string, ok: boolean) => {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        setWalkReceipts(prev => [
          { id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, time: `${hh}:${mm}:${ss}`, heard: heard.slice(0, 28), badge, ok },
          ...prev,
        ].slice(0, 3));
      };

      // Handle 0ms playback & queue control fast-path directly
      if (data.playbackControl && data.playbackControl.kind) {
        const pc = data.playbackControl;
        const pcBadge =
          pc.kind === 'set_speed'
            ? `⏩ 语速 ${pc.speechRate}x`
            : pc.kind === 'queue_next'
              ? '⏭️ 下一条'
              : pc.kind === 'queue_prev'
                ? '⏮️ 上一条'
                : pc.kind === 'queue_repeat'
                  ? '🔁 重播'
                  : pc.kind === 'handsfree_pause'
                    ? '⏸️ 已静音待命'
                    : pc.kind === 'queue_pause'
                      ? '⏸️ 已暂停播报'
                      : '▶️ 继续播报';
        setLastActionBadge(pcBadge);
        pushReceipt(clean, pcBadge, true);
        playEarcon('done');
        if (pc.kind === 'handsfree_pause' || pc.kind === 'queue_pause') {
          userPausedHandsFreeRef.current = true;
          await applyPlaybackControl(pc);
          await speakWalkReply(chunks);
          return;
        }
        await applyPlaybackControl(pc);
        if (pc.kind === 'set_speed') {
          const keepLoop = Boolean(
            !fromTextInput
            && aiTabActiveRef.current
            && walkOpenRef.current
            && configRef.current.prefs.autoVad
            && configRef.current.prefs.autoListenAfterBriefing
            && !userPausedHandsFreeRef.current
            && !walkTextInputOpenRef.current,
          );
          const keepAudio = keepLoop ? await canNativeAutoListenNow() : false;
          await speakWalkReply(chunks, undefined, { keepAudioSessionAfter: keepAudio });
          if (keepLoop && !bargeInTriggeredRef.current && walkOpenRef.current && walkPhaseRef.current === 'idle') {
            void startWalkListening({ isAutoFollowUp: true, noSpeechTimeoutMs: 14000, silentOnNoMic: true });
          }
        }
        return;
      }

      if (data.fastPath === 'l2_pin_matched') {
        playEarcon('pin_ok');
        const b = `🔓 确认码通过 · 已放行 ${data.action?.code || ''}`.trim();
        setLastActionBadge(b);
        pushReceipt(clean, b, true);
      } else if (data.action?.type === 'stage_new_task' || data.draftCard) {
        playEarcon('listen');
        const b = data.draftCard?.status === 'awaiting_confirm'
          ? '📝 等待确认新建任务'
          : '📝 核对新建任务信息';
        setLastActionBadge(b);
        pushReceipt(clean, b, true);
      } else if (data.execution?.requiresPin) {
        playEarcon('alert');
        const b = `⚠️ 高危需念确认码 ${data.pinChallenge?.pin || ''}`.trim();
        setLastActionBadge(b);
        pushReceipt(clean, b, false);
      } else if (data.execution?.ambiguousApprovals || data.action?.ambiguousApprovals) {
        playEarcon('alert');
        const b = '🔢 多条待审批 · 请说编号';
        setLastActionBadge(b);
        pushReceipt(clean, b, false);
      } else if (data.execution?.executed) {
        playEarcon('pin_ok');
        const slotStr = data.execution?.approval?.slot ? ` ${data.execution.approval.slot}号` : '';
        const mapLabel: Record<string, string> = {
          approve: `✅ 已放行${slotStr}`,
          reject: `🚫 已拒绝${slotStr}`,
          answer_question: `✅ 已提交选择${slotStr}`,
          send_prompt: '📤 已发送追问',
          create_task: '✨ 已新建任务',
          stop_session: '⏹ 已发送停止指令',
          focus_session: '🎯 已切换锁定会话',
          pin_session: '📌 已更新置顶',
          rename_session: '✏️ 已重命名会话',
          switch_model: '🧠 已切换模型',
          delete_session: '🗑️ 已删除会话',
        };
        const b = mapLabel[data.execution.type] || `✅ ${data.execution.type}`;
        setLastActionBadge(b);
        pushReceipt(clean, b, true);
      } else if (data.action?.type === 'query_status' || data.action?.type === 'inspect_session') {
        const b = '📊 状态播报（未改状态）';
        setLastActionBadge(b);
        pushReceipt(clean, b, true);
      } else {
        const b = '⏸️ 未执行操作';
        setLastActionBadge(b);
        pushReceipt(clean, b, false);
      }

      const baseMetrics: string[] = [];
      if (wavKb !== null) baseMetrics.push(`WAV ${wavKb}KB`);
      if (sttMs !== null) baseMetrics.push(`STT ${sttMs}ms`);
      baseMetrics.push(`大脑 ${data.latencyMs ?? 0}ms${data.fastPath ? ' ⚡' : ''}`);
      setLastLatencyBadge(baseMetrics.join(' · '));

      const stayHandsFreeLoop = Boolean(
        !fromTextInput
        && aiTabActiveRef.current
        && walkOpenRef.current
        && configRef.current.prefs.autoVad
        && configRef.current.prefs.autoListenAfterBriefing
        && !userPausedHandsFreeRef.current
        && !walkTextInputOpenRef.current,
      );
      const wantsAutoListen = Boolean(
        !fromTextInput
        && !walkTextInputOpenRef.current
        && (data.expectReply || stayHandsFreeLoop)
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

      if (bargeInTriggeredRef.current) {
        return;
      }

      const shouldAutoListenAfterSpeak = wantsAutoListen
        ? (shouldAutoListen || await canNativeAutoListenNow())
        : false;
      if (shouldAutoListenAfterSpeak && walkOpenRef.current && walkPhaseRef.current === 'idle') {
        postNativeVoiceDiag('auto_listen_after_turn', `phase=${walkPhaseRef.current} continuous=${stayHandsFreeLoop ? 1 : 0}`);
        void startWalkListening({
          isAutoFollowUp: true,
          noSpeechTimeoutMs: aiTabActiveRef.current ? 14000 : 7000,
          silentOnNoMic: true,
        });
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
    postNativeVoiceDiag('wav_ready', `auto=${isAutoFollowUp ? 1 : 0} timeout=${rec.silentTimeout ? 1 : 0} speech=${rec.hadSpeech ? 1 : 0} bytes=${rec.byteLength}`);
    if (rec.silentTimeout || (isAutoFollowUp && !rec.hadSpeech)) {
      // User stayed silent during auto-listen window -> quietly restore background music!
      postNativeVoiceDiag('auto_listen_silent_exit', `timeout=${rec.silentTimeout ? 1 : 0} hadSpeech=${rec.hadSpeech ? 1 : 0} bytes=${rec.byteLength}`);
      setWalkPhase('idle');
      if (aiTabActiveRef.current) {
        setLastActionBadge('⏸️ 暂未听到说话 · 已待命');
      }
      if (duckMusic) setWalkAudioSessionMode('ambient');
      if (walkOpenRef.current && briefingQueueRef.current.length > 0) {
        setTimeout(() => { void drainBriefingQueue(); }, 350);
      } else {
        notifyNativeBackgroundWakeDone();
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
      postNativeVoiceDiag('stt_done', `ok=${res.ok && data?.ok ? 1 : 0} silence=${data?.silence ? 1 : 0} len=${String(data?.text || '').length} ms=${data?.latencyMs ?? 0}`);
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
          playEarcon('alert');
          setLastReplyText('没有检测到清晰人声（静音），轻点圆球重新说。');
          setLastActionBadge('❓ 未听清 · 未执行');
          setLastLatencyBadge(`WAV ${wavKb}KB · STT ${data.latencyMs ?? 0}ms · 静音`);
        } else if (rec.hadSpeech) {
          playEarcon('alert');
          setLastActionBadge('❓ 刚没听清 · 未执行');
          setLastLatencyBadge(`WAV ${wavKb}KB · STT 静音`);
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

  const startWalkListening = async ({
    isAutoFollowUp = false,
    noSpeechTimeoutMs,
    silentOnNoMic = false,
  }: { isAutoFollowUp?: boolean; noSpeechTimeoutMs?: number; silentOnNoMic?: boolean } = {}) => {
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
    const effectiveAutoVad = isAutoFollowUp ? true : Boolean(configRef.current.prefs.autoVad);
    const effectiveNoSpeechMs =
      typeof noSpeechTimeoutMs === 'number'
        ? noSpeechTimeoutMs
        : isAutoFollowUp
          ? (aiTabActiveRef.current ? 14000 : 7000)
          : (effectiveAutoVad ? 14000 : 0);
    try {
      // Switch iOS Safari AudioSession BEFORE playing earcon or opening microphone.
      // Play the 170ms listen chime FIRST and wait 210ms so the chime is clearly heard AND
      // finishes before the mic/VAD arms (preventing speaker earcon bleed from false-triggering VAD!).
      setWalkAudioSessionMode('play-and-record');
      setWalkPhase('listening');
      playEarcon('listen');
      await new Promise(resolve => setTimeout(resolve, 210));
      if (!walkOpenRef.current || walkPhaseRef.current !== 'listening') {
        return;
      }
      await recorderRef.current!.start({
        autoVad: effectiveAutoVad,
        vadSilenceMs: configRef.current.prefs.vadSilenceMs || 850,
        noSpeechTimeoutMs: effectiveNoSpeechMs,
        onLevel: lvl => setMicLevel(lvl),
        onAutoStop: res => {
          void handleWalkWavReady(res, isAutoFollowUp);
        },
      });
      postNativeVoiceDiag('listen_started', `auto=${isAutoFollowUp ? 1 : 0} vad=${effectiveAutoVad ? 1 : 0} noSpeech=${effectiveNoSpeechMs}`);
    } catch (err: any) {
      setWalkPhase('idle');
      postNativeVoiceDiag('listen_start_error', `auto=${isAutoFollowUp ? 1 : 0} err=${String(err?.message || 'unknown').slice(0, 120)}`);
      if (configRef.current?.prefs?.duckMusicMode !== false) {
        setWalkAudioSessionMode('ambient');
      }
      if (!isAutoFollowUp && !silentOnNoMic) {
        toast(err?.message || '无法打开麦克风，请检查浏览器权限');
      } else {
        notifyNativeBackgroundWakeDone();
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
        if (res && res.hadSpeech) {
          void handleWalkWavReady(res, false);
        } else {
          // Tapping orb before speaking cleanly pauses hands-free listening instead of showing a silence error
          userPausedHandsFreeRef.current = true;
          setMicLevel(0);
          setWalkPhase('idle');
          if (configRef.current?.prefs?.duckMusicMode !== false) {
            setWalkAudioSessionMode('ambient');
          }
          toast('⏸️ 已暂停聆听，轻点圆麦随时继续');
        }
      } else if (nativeRecRef.current) {
        try { nativeRecRef.current.stop(); } catch {}
      }
      return;
    }
    if (walkPhaseRef.current === 'transcribing' || walkPhaseRef.current === 'thinking') {
      return;
    }
    userPausedHandsFreeRef.current = false;
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
  const currentSpeed = Math.round((Number(config.prefs.speechRate) || 1.0) * 100) / 100;
  const cyclePlaybackSpeed = () => {
    const steps = [1.0, 1.25, 1.5, 1.75, 2.0, 0.75];
    const idx = steps.findIndex(s => Math.abs(s - currentSpeed) < 0.06);
    const nextRate = steps[(idx + 1) % steps.length];
    void applyPlaybackControl({ kind: 'set_speed', speechRate: nextRate });
    void updatePrefPatch({ speechRate: nextRate });
  };
  const aiMountNode =
    aiTabActive && typeof document !== 'undefined'
      ? document.getElementById('aiTabMount')
      : null;

  const walkCanvasEl = walkOpen && walkExpanded ? (
        <div
          id="walkModeOverlay"
          class={`walk-mode-overlay ${aiTabActive ? 'is-tab-docked' : ''} walk-phase-${walkPhase}`}
          role={aiTabActive ? 'region' : 'dialog'}
          aria-label="AI 语音中枢"
          onClick={() => {
            if (walkPrefsOpen) setWalkPrefsOpen(false);
            if (queueExpanded) setQueueExpanded(false);
          }}
        >
          {/* 顶部极简导航：左语速胶囊（或收起）· 中方案与状态 · 右配置+停止 */}
          <div class="walk-top-bar" onClick={e => e.stopPropagation()}>
            {aiTabActive ? (
              <button
                type="button"
                class="walk-speed-pill"
                id="walkSpeedPillBtn"
                title="点击切换播报语速（也可直接说「加速/慢一点」）"
                onClick={cyclePlaybackSpeed}
              >
                {`${currentSpeed}x`}
              </button>
            ) : (
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
            )}

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
                aria-label="暂停并结束后台监听"
                title="结束后台监听"
                onClick={() => {
                  setWalkPrefsOpen(false);
                  setWalkExpanded(false);
                  setWalkOpen(false);
                  if (aiTabActive && typeof (window as any).switchTab === 'function') {
                    (window as any).switchTab('chats');
                  }
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                  <line x1="12" y1="2" x2="12" y2="12" />
                </svg>
              </button>
            </div>
          </div>

          {/* 有序播报队列控制条（支持顺序播报、上一条/下一条/暂停/半截补播） */}
          {queueItems.length > 0 && (
            <div class="walk-queue-wrap" onClick={e => e.stopPropagation()}>
              <div class="walk-queue-bar">
                <button
                  type="button"
                  class="walk-queue-summary"
                  onClick={() => setQueueExpanded(v => !v)}
                >
                  <span>{`📋 队列 ${Math.max(1, queueCursor + 1)} / ${queueItems.length}`}</span>
                  {queuePaused && <span class="walk-queue-paused-tag">已暂停</span>}
                </button>
                <div class="walk-queue-btns">
                  <button
                    type="button"
                    class="walk-queue-btn"
                    title="上一条"
                    onClick={() => void applyPlaybackControl({ kind: 'queue_prev' })}
                  >
                    ◀
                  </button>
                  <button
                    type="button"
                    class="walk-queue-btn"
                    title={queuePaused ? '继续播报' : '暂停播报'}
                    onClick={() => void applyPlaybackControl({ kind: queuePaused ? 'queue_resume' : 'queue_pause' })}
                  >
                    {queuePaused ? '▶' : '⏸'}
                  </button>
                  <button
                    type="button"
                    class="walk-queue-btn"
                    title="下一条"
                    onClick={() => void applyPlaybackControl({ kind: 'queue_next' })}
                  >
                    ⏭
                  </button>
                </div>
              </div>
              {queueExpanded && (
                <div class="walk-queue-list">
                  {queueItems.map((it, idx) => (
                    <button
                      type="button"
                      key={it.id}
                      class={`walk-queue-item ${idx === queueCursor ? 'is-current' : ''} status-${it.status}`}
                      onClick={() => {
                        setQueueExpanded(false);
                        void replayQueueItemAt(idx, { prefixResume: it.status === 'partial' });
                      }}
                    >
                      <span class="walk-queue-idx">{`${idx + 1}.`}</span>
                      <span class="walk-queue-kind">{it.kind === 'approval' ? '🔔' : '✅'}</span>
                      <span class="walk-queue-title">{`${it.hostName} · ${it.title}`}</span>
                      <span class="walk-queue-st">
                        {it.status === 'playing'
                          ? '播报中'
                          : it.status === 'partial'
                            ? '待补播'
                            : it.status === 'done'
                              ? '已播'
                              : it.status === 'skipped'
                                ? '已跳过'
                                : '排队中'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 中央大留白无框字幕区（播报时轻点静音） */}
          <div
            class={`walk-stage ${(activeDraft || activePin) ? 'has-active-card' : ''}`}
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
            {!activeDraft && (
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
            )}

            {/* 多轮校验新建任务核对卡（支持已有项目 & 新建工作区，可语音确认也可一键点按） */}
            {activeDraft && (
              <div class={`walk-draft-card ${activeDraft.status === 'awaiting_confirm' ? 'is-ready' : ''}`} id="walkDraftCard" onClick={e => e.stopPropagation()}>
                <div class="walk-draft-head">
                  <span>{activeDraft.status === 'awaiting_confirm' ? '📝 新建任务核对单 · 等待确认' : '📝 正在核对新建任务信息'}</span>
                  <span class="walk-draft-badge">
                    {activeDraft.createDir ? '✨ 新建工作区' : activeDraft.workspaceMode === 'existing' ? '📂 已有项目' : '待选目录'}
                  </span>
                </div>
                <div class="walk-draft-rows">
                  <div class="walk-draft-row">
                    <span class="walk-draft-k">电脑</span>
                    <span class={`walk-draft-v ${activeDraft.hostId ? 'ok' : 'pending'}`}>
                      {activeDraft.hostName || '🟡 待你指定（如 Air / mini）'}
                    </span>
                  </div>
                  <div class="walk-draft-row">
                    <span class="walk-draft-k">工作区</span>
                    <span class={`walk-draft-v ${activeDraft.cwd ? 'ok' : 'pending'}`}>
                      {activeDraft.workspaceLabel || '🟡 已有项目 或 说「新建工作区叫…」'}
                    </span>
                  </div>
                  <div class="walk-draft-row">
                    <span class="walk-draft-k">工具</span>
                    <span class="walk-draft-v ok">{activeDraft.harnessLabel || 'Antigravity'}</span>
                  </div>
                  <div class="walk-draft-row">
                    <span class="walk-draft-k">任务</span>
                    <span class={`walk-draft-v ${activeDraft.prompt ? 'ok' : 'pending'}`}>
                      {activeDraft.prompt || '🟡 待你说明要做什么'}
                    </span>
                  </div>
                </div>
                <div class="walk-draft-actions">
                  {activeDraft.status === 'awaiting_confirm' && (
                    <button
                      type="button"
                      class="walk-draft-btn-ok"
                      disabled={draftSubmitting}
                      onClick={() => void handleDraftCardAction('confirm')}
                    >
                      {draftSubmitting ? '创建中…' : '✅ 确认创建'}
                    </button>
                  )}
                  <button
                    type="button"
                    class="walk-draft-btn-cancel"
                    disabled={draftSubmitting}
                    onClick={() => void handleDraftCardAction('cancel')}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

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
              <div class={`walk-reply-line ${(isLongReply || activeDraft) ? 'compact' : ''}`}>{lastReplyText}</div>
              {(lastActionBadge || lastLatencyBadge) && (
                <div class="walk-meta-row">
                  {lastActionBadge && <span class="walk-action-tag">{lastActionBadge}</span>}
                  {lastLatencyBadge && <span class="walk-latency-tag">{lastLatencyBadge}</span>}
                </div>
              )}
              {walkReceipts.length > 0 && !activeDraft && (
                <div class="walk-receipt-log" aria-label="近期语音执行记录">
                  {walkReceipts.map(rc => (
                    <div key={rc.id} class={`walk-receipt-item ${rc.ok ? 'is-ok' : 'is-warn'}`}>
                      <span class="walk-receipt-time">{rc.time}</span>
                      <span class="walk-receipt-heard">{`「${rc.heard}」`}</span>
                      <span class="walk-receipt-badge">{rc.badge}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 底部对称三键控制台 + 可展开偏好胶囊 */}
          <div class="walk-orb-dock" onClick={e => e.stopPropagation()}>
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
                      void handleWalkUserText(t, null, null, true);
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
                    void handleWalkUserText(t, null, null, true);
                  }}
                >
                  发送
                </button>
              </div>
            )}
            <div class="walk-controls-row">
              <div class="walk-side-btn-wrap">
                <button
                  type="button"
                  id="walkKeyboardBtn"
                  class={`walk-side-btn ${walkTextInputOpen ? 'active' : ''}`}
                  aria-label="静音打字"
                  onClick={() => {
                    setWalkPrefsOpen(false);
                    setWalkTextInputOpen(v => {
                      const next = !v;
                      walkTextInputOpenRef.current = next;
                      if (next) {
                        userPausedHandsFreeRef.current = true;
                        if (walkPhaseRef.current === 'listening') stopAllListening();
                      }
                      return next;
                    });
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
                ? (config.prefs.autoVad
                    ? '正在听你说… 说完停顿自动发送（轻点暂停）'
                    : '正在录音… 说完轻点红色方块发送')
                : walkPhase === 'speaking'
                  ? '轻点圆麦随时插话 · 点字幕静音'
                  : walkPhase === 'transcribing' || walkPhase === 'thinking'
                    ? '正在处理你的语音指令…'
                    : (config.prefs.autoVad
                        ? '待命中 · 轻点圆麦开启免提连续对话'
                        : '轻点开始说话 · 戴耳机随时插话')}
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
                      <span class="walk-pref-t1">免提连续对话</span>
                      <span class="walk-pref-t2">{config.prefs.autoVad ? '说完自动发 · 播完继续听' : '手动点开始/结束'}</span>
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
  ) : null;

  return (
    <Fragment>
      {/* 1. AI 语音中枢：在中间 AI Tab 时直接嵌入 #aiTabMount，否则全屏弹出 */}
      {walkCanvasEl && (aiMountNode ? createPortal(walkCanvasEl, aiMountNode) : walkCanvasEl)}

      {/* 1b. 收起态：Apple Music 式迷你悬浮语音条（边看对话/设置边听播报，点空白回到中间 AI Tab，右侧一键插话或关闭） */}
      {walkOpen && !walkExpanded && !aiTabActive && (
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
            onClick={() => {
              if (typeof (window as any).switchTab === 'function') {
                (window as any).switchTab('ai');
              } else {
                setWalkExpanded(true);
              }
            }}
            title="点击切回 AI 语音中枢"
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
