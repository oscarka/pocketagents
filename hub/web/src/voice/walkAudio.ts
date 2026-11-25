// Pure-JS cross-browser 16kHz WAV recorder + VAD + WebAudio Earcons + Progressive TTS Queue + Safari AudioSession Ducking + MediaSession + WakeLock

export type EarconKind = 'listen' | 'done' | 'approval' | 'pin_ok' | 'alert';
export type WalkAudioSessionMode = 'ambient' | 'transient' | 'play-and-record' | 'auto';

export interface NativeAudioBridgeApi {
  platform?: string;
  version?: string;
  setBackgroundKeepAlive?: (active: boolean, duckMusic?: boolean, keepMicWarm?: boolean) => Promise<boolean>;
  playBase64Audio?: (
    base64: string,
    mimeType?: string,
    opts?: { duckMusic?: boolean; keepSessionAfter?: boolean },
  ) => Promise<boolean>;
  speakSystemText?: (
    text: string,
    rate?: number,
    opts?: { duckMusic?: boolean; keepSessionAfter?: boolean },
  ) => Promise<boolean>;
  stopPlayback?: (restoreIdle?: boolean) => Promise<boolean>;
  playEarcon?: (kind: EarconKind) => Promise<boolean>;
  startRecording?: (opts?: {
    autoVad?: boolean;
    vadSilenceMs?: number;
    noSpeechTimeoutMs?: number;
    maxDurationMs?: number;
  }) => Promise<boolean>;
  stopRecording?: () => Promise<WavRecordingResult | null>;
  on?: (eventName: 'level' | 'recordingAutoStop', fn: (detail: any) => void) => () => void;
}

export function getNativeAudioBridge(): NativeAudioBridgeApi | null {
  try {
    if (typeof window === 'undefined') return null;
    const api = (window as any).__dshNativeAudio;
    return api && typeof api === 'object' ? (api as NativeAudioBridgeApi) : null;
  } catch {
    return null;
  }
}

export function isNativeIosShell(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    return Boolean((window as any).__dshNativeShell?.platform === 'ios-native' || (window as any).__dshNativeAudio?.platform === 'ios-native');
  } catch {
    return false;
  }
}

export async function setWalkBackgroundKeepAlive(
  active: boolean,
  duckMusic = true,
  keepMicWarm = false,
): Promise<boolean> {
  try {
    if (typeof window !== 'undefined') {
      (window as any).__dshWalkKeepAliveActive = Boolean(active);
    }
    const bridge = getNativeAudioBridge();
    if (!bridge?.setBackgroundKeepAlive) return false;
    return Boolean(await bridge.setBackgroundKeepAlive(Boolean(active), Boolean(duckMusic), Boolean(keepMicWarm)));
  } catch {
    return false;
  }
}

/**
 * Configure the W3C / iOS Safari 16.4+ Audio Session API (`navigator.audioSession`).
 * - `'ambient'`: idle listening to Apple Music / Spotify at full stereo quality
 * - `'transient'`: short spoken prompt that ducks background music volume and auto-restores after
 * - `'play-and-record'`: full-duplex AirPods microphone + speaker voice interaction
 * - `'auto'`: release explicit audio session override when closing Walk Mode
 */
export function setWalkAudioSessionMode(mode: WalkAudioSessionMode): boolean {
  if (isNativeIosShell()) return true;
  try {
    const as = typeof navigator !== 'undefined' ? (navigator as any).audioSession : null;
    if (!as) return false;
    if (as.type !== mode) {
      as.type = mode;
    }
    return true;
  } catch {
    return false;
  }
}

export function supportsWalkAudioSession(): boolean {
  try {
    return typeof navigator !== 'undefined' && Boolean((navigator as any).audioSession);
  } catch {
    return false;
  }
}

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new Ctor();
    }
    if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
      void sharedAudioCtx.resume().catch(() => {});
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

export function playEarcon(kind: EarconKind): void {
  const nativeBridge = getNativeAudioBridge();
  if (nativeBridge?.playEarcon) {
    void nativeBridge.playEarcon(kind).catch(() => {});
    return;
  }
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const playTone = (freq: number, startOffset: number, dur: number, vol = 0.08, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.0001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(vol, now + startOffset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + dur + 0.02);
    };

    if (kind === 'listen') {
      playTone(587.33, 0, 0.09, 0.07);
      playTone(880, 0.07, 0.11, 0.07);
    } else if (kind === 'done') {
      playTone(523.25, 0, 0.11, 0.08);
      playTone(783.99, 0.1, 0.16, 0.08);
    } else if (kind === 'approval') {
      playTone(659.25, 0, 0.1, 0.085, 'triangle');
      playTone(880, 0.11, 0.12, 0.085, 'triangle');
      playTone(1046.5, 0.23, 0.16, 0.07, 'triangle');
    } else if (kind === 'pin_ok') {
      playTone(698.46, 0, 0.09, 0.08);
      playTone(1046.5, 0.09, 0.16, 0.09);
    } else if (kind === 'alert') {
      playTone(392, 0, 0.14, 0.09, 'triangle');
      playTone(311.13, 0.15, 0.18, 0.09, 'triangle');
    }
  } catch {
    // ignore audio policy block
  }
}

export function downsampleFloat32To16kInt16(input: Float32Array, inputSampleRate: number, targetRate = 16000): Int16Array {
  if (!input.length) return new Int16Array(0);
  if (inputSampleRate === targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = inputSampleRate / targetRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = input[idx] || 0;
    const s1 = input[Math.min(idx + 1, input.length - 1)] || s0;
    const val = Math.max(-1, Math.min(1, s0 + (s1 - s0) * frac));
    out[i] = val < 0 ? val * 0x8000 : val * 0x7fff;
  }
  return out;
}

export function encodeInt16ToWavBytes(samples: Int16Array, sampleRate = 16000): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(offset, samples[i], true);
    offset += 2;
  }
  return new Uint8Array(buf);
}

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, Math.min(i + chunk, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(slice));
  }
  return btoa(binary);
}

export interface WavRecordingResult {
  wavBase64: string;
  byteLength: number;
  durationMs: number;
  sampleRate: number;
  hadSpeech: boolean;
  silentTimeout?: boolean;
}

export interface WalkRecorderOptions {
  autoVad?: boolean;
  vadSilenceMs?: number;
  noSpeechTimeoutMs?: number;
  maxDurationMs?: number;
  onLevel?: (level: number) => void;
  onAutoStop?: (result: WavRecordingResult) => void;
}

export class WalkWavRecorder {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private procNode: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 48000;
  private startedAt = 0;
  private hadSpeech = false;
  private lastVoiceAt = 0;
  private active = false;
  private nativeMode = false;
  private nativeUnsubs: Array<() => void> = [];
  private maxTimer: any = null;
  private noSpeechTimer: any = null;
  private onAutoStop: ((res: WavRecordingResult) => void) | null = null;

  private clearNativeListeners(): void {
    for (const fn of this.nativeUnsubs) {
      try { fn(); } catch {}
    }
    this.nativeUnsubs = [];
  }

  isRecording(): boolean {
    return this.active;
  }

  async start(opts: WalkRecorderOptions = {}): Promise<void> {
    if (this.active) return;

    const nativeBridge = getNativeAudioBridge();
    if (nativeBridge?.startRecording) {
      this.active = true;
      this.nativeMode = true;
      this.onAutoStop = opts.onAutoStop || null;
      this.clearNativeListeners();
      if (nativeBridge.on) {
        if (opts.onLevel) {
          this.nativeUnsubs.push(
            nativeBridge.on('level', detail => {
              if (!this.active) return;
              const lvl = typeof detail === 'number' ? detail : Number(detail?.level || 0);
              opts.onLevel?.(lvl);
            }),
          );
        }
        this.nativeUnsubs.push(
          nativeBridge.on('recordingAutoStop', detail => {
            if (!this.active) return;
            this.active = false;
            this.nativeMode = false;
            this.clearNativeListeners();
            if (detail && this.onAutoStop) {
              this.onAutoStop(detail as WavRecordingResult);
            }
          }),
        );
      }
      try {
        await nativeBridge.startRecording({
          autoVad: Boolean(opts.autoVad),
          vadSilenceMs: Math.max(400, Number(opts.vadSilenceMs) || 850),
          noSpeechTimeoutMs: Number(opts.noSpeechTimeoutMs) || 0,
          maxDurationMs: Math.max(3000, Number(opts.maxDurationMs) || 25000),
        });
        return;
      } catch (err) {
        this.active = false;
        this.nativeMode = false;
        this.clearNativeListeners();
        throw err;
      }
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持麦克风采集（需 HTTPS 或 localhost 环境）');
    }
    // iOS Safari 16.4+/18+/26+: navigator.audioSession MUST be 'play-and-record' (or 'auto')
    // BEFORE calling getUserMedia(); otherwise WebKit throws "AudioSession category is not compatible with audio capture."
    setWalkAudioSessionMode('play-and-record');
    const audioConstraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
    } catch (err: any) {
      if (/audiosession|category|compatible with audio capture/i.test(String(err?.message || ''))) {
        setWalkAudioSessionMode('auto');
        stream = await navigator.mediaDevices.getUserMedia(audioConstraints);
      } else {
        throw err;
      }
    }
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) {
      stream.getTracks().forEach(t => t.stop());
      throw new Error('当前浏览器不支持 WebAudio 音频处理');
    }
    const ctx: AudioContext = new Ctor();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    this.stream = stream;
    this.audioCtx = ctx;
    this.sampleRate = ctx.sampleRate || 48000;
    this.chunks = [];
    this.startedAt = Date.now();
    this.hadSpeech = false;
    this.lastVoiceAt = this.startedAt;
    this.active = true;
    this.onAutoStop = opts.onAutoStop || null;

    const autoVad = Boolean(opts.autoVad);
    const vadSilenceMs = Math.max(400, Number(opts.vadSilenceMs) || 850);
    const maxDurationMs = Math.max(3000, Number(opts.maxDurationMs) || 25000);

    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;

    proc.onaudioprocess = ev => {
      if (!this.active) return;
      const input = ev.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.chunks.push(copy);

      let sumSq = 0;
      for (let i = 0; i < copy.length; i += 1) {
        sumSq += copy[i] * copy[i];
      }
      const rms = Math.sqrt(sumSq / Math.max(1, copy.length));
      const normalizedLevel = Math.min(1, rms * 7.5);
      opts.onLevel?.(normalizedLevel);

      const now = Date.now();
      if (rms > 0.018) {
        this.hadSpeech = true;
        this.lastVoiceAt = now;
      } else if (autoVad && this.hadSpeech && now - this.startedAt > 550 && now - this.lastVoiceAt >= vadSilenceMs) {
        const res = this.stop();
        if (res && this.onAutoStop) {
          this.onAutoStop(res);
        }
      }
    };

    source.connect(proc);
    proc.connect(silentGain);
    silentGain.connect(ctx.destination);

    this.sourceNode = source;
    this.procNode = proc;
    this.silentGain = silentGain;

    const noSpeechTimeoutMs = Number(opts.noSpeechTimeoutMs) || 0;
    if (noSpeechTimeoutMs >= 1500) {
      this.noSpeechTimer = setTimeout(() => {
        if (!this.active || this.hadSpeech) return;
        const res = this.stop();
        if (res && this.onAutoStop) {
          this.onAutoStop({ ...res, silentTimeout: true });
        }
      }, noSpeechTimeoutMs);
    }

    this.maxTimer = setTimeout(() => {
      if (!this.active) return;
      const res = this.stop();
      if (res && this.onAutoStop) {
        this.onAutoStop(res);
      }
    }, maxDurationMs);
  }

  async stopAsync(): Promise<WavRecordingResult | null> {
    if (!this.active) return null;
    if (this.nativeMode) {
      this.active = false;
      this.nativeMode = false;
      this.clearNativeListeners();
      const nativeBridge = getNativeAudioBridge();
      if (!nativeBridge?.stopRecording) return null;
      try {
        const res = await nativeBridge.stopRecording();
        return res && typeof res === 'object' && res.wavBase64 ? res : null;
      } catch {
        return null;
      }
    }
    return this.stop();
  }

  stop(): WavRecordingResult | null {
    if (!this.active) return null;
    if (this.nativeMode) {
      this.active = false;
      this.nativeMode = false;
      this.clearNativeListeners();
      const nativeBridge = getNativeAudioBridge();
      void nativeBridge?.stopRecording?.().catch(() => {});
      return null;
    }
    this.active = false;
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.noSpeechTimer) {
      clearTimeout(this.noSpeechTimer);
      this.noSpeechTimer = null;
    }
    const durationMs = Math.max(0, Date.now() - this.startedAt);
    const hadSpeech = this.hadSpeech;
    const srcRate = this.sampleRate;
    const chunks = this.chunks;
    this.chunks = [];

    try {
      this.procNode?.disconnect();
      this.sourceNode?.disconnect();
      this.silentGain?.disconnect();
    } catch {}
    try {
      this.stream?.getTracks().forEach(t => t.stop());
    } catch {}
    try {
      void this.audioCtx?.close();
    } catch {}

    this.procNode = null;
    this.sourceNode = null;
    this.silentGain = null;
    this.stream = null;
    this.audioCtx = null;

    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const pcm16 = downsampleFloat32To16kInt16(merged, srcRate, 16000);
    const wavBytes = encodeInt16ToWavBytes(pcm16, 16000);
    return {
      wavBase64: uint8ToBase64(wavBytes),
      byteLength: wavBytes.length,
      durationMs,
      sampleRate: 16000,
      hadSpeech,
    };
  }
}

export class WalkSpeechPlayer {
  private runId = 0;
  private activeAudio: HTMLAudioElement | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private playbackCtx: AudioContext | null = null;
  private activeObjectUrl = '';
  private abortCtrl: AbortController | null = null;
  private playing = false;

  /**
   * Call synchronously inside a user tap/click handler BEFORE any async fetch()
   * so iOS Safari / Home-Screen PWA unlocks audio playback reliably across async TTS calls.
   */
  unlockAudio(): void {
    try {
      const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      if (!this.playbackCtx || this.playbackCtx.state === 'closed') {
        this.playbackCtx = new Ctor();
      }
      if (this.playbackCtx.state === 'suspended') {
        void this.playbackCtx.resume().catch(() => {});
      }
      // 1-sample silent buffer unlock for iOS WebKit
      const buf = this.playbackCtx.createBuffer(1, 1, 22050);
      const src = this.playbackCtx.createBufferSource();
      src.buffer = buf;
      src.connect(this.playbackCtx.destination);
      src.start(0);
    } catch {
      // ignore unlock errors on unsupported browsers
    }
  }

  isPlaying(): boolean {
    return this.playing;
  }

  stop(): void {
    this.runId += 1;
    this.playing = false;
    if (this.abortCtrl) {
      try { this.abortCtrl.abort(); } catch {}
      this.abortCtrl = null;
    }
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {}
      this.activeSource = null;
    }
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.src = '';
      } catch {}
      this.activeAudio = null;
    }
    if (this.activeObjectUrl) {
      try { URL.revokeObjectURL(this.activeObjectUrl); } catch {}
      this.activeObjectUrl = '';
    }
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    } catch {}
    const nativeBridge = getNativeAudioBridge();
    if (nativeBridge?.stopPlayback) {
      void nativeBridge.stopPlayback(true).catch(() => {});
    }
  }

  async playAudioBase64(
    base64: string,
    mimeType = 'audio/mpeg',
    opts: { duckMusic?: boolean; keepSessionAfter?: boolean } = {},
  ): Promise<boolean> {
    const myRun = this.runId;
    const nativeBridge = getNativeAudioBridge();
    if (nativeBridge?.playBase64Audio) {
      try {
        const ok = await nativeBridge.playBase64Audio(base64, mimeType || 'audio/mpeg', {
          duckMusic: opts.duckMusic !== false,
          keepSessionAfter: Boolean(opts.keepSessionAfter),
        });
        return Boolean(ok) && this.runId === myRun;
      } catch {
        return false;
      }
    }
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

    // Prefer unlocked Web Audio API (immune to iOS Safari async HTMLAudioElement autoplay block)
    if (this.playbackCtx && this.playbackCtx.state !== 'closed') {
      try {
        if (this.playbackCtx.state === 'suspended') {
          await this.playbackCtx.resume().catch(() => {});
        }
        const arrayBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
          const maybePromise = this.playbackCtx!.decodeAudioData(
            arrayBuf,
            b => resolve(b),
            err => reject(err || new Error('decode failed')),
          );
          if (maybePromise && typeof (maybePromise as any).then === 'function') {
            (maybePromise as Promise<AudioBuffer>).then(resolve, reject);
          }
        });
        if (this.runId !== myRun) return false;
        return await new Promise<boolean>(resolve => {
          const src = this.playbackCtx!.createBufferSource();
          src.buffer = decoded;
          src.connect(this.playbackCtx!.destination);
          this.activeSource = src;
          src.onended = () => {
            if (this.activeSource === src) this.activeSource = null;
            resolve(this.runId === myRun);
          };
          src.start(0);
        });
      } catch {
        // Fallback cleanly to HTMLAudioElement if decodeAudioData fails for a codec
      }
    }

    const blob = new Blob([bytes], { type: mimeType || 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    if (this.runId !== myRun) {
      URL.revokeObjectURL(url);
      return false;
    }
    this.activeObjectUrl = url;
    const audio = new Audio(url);
    (audio as any).playsInline = true;
    this.activeAudio = audio;

    return new Promise<boolean>(resolve => {
      const cleanup = (ok: boolean) => {
        if (this.activeAudio === audio) this.activeAudio = null;
        if (this.activeObjectUrl === url) {
          URL.revokeObjectURL(url);
          this.activeObjectUrl = '';
        }
        resolve(ok);
      };
      audio.onended = () => cleanup(true);
      audio.onerror = () => cleanup(false);
      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => cleanup(false));
      }
    });
  }

  async speakNativeBrowser(
    text: string,
    rate = 1.0,
    opts: { duckMusic?: boolean; keepSessionAfter?: boolean } = {},
  ): Promise<boolean> {
    const myRun = this.runId;
    const nativeBridge = getNativeAudioBridge();
    if (nativeBridge?.speakSystemText) {
      try {
        const ok = await nativeBridge.speakSystemText(text, rate, {
          duckMusic: opts.duckMusic !== false,
          keepSessionAfter: Boolean(opts.keepSessionAfter),
        });
        return Boolean(ok) && this.runId === myRun;
      } catch {
        return false;
      }
    }
    return new Promise<boolean>(resolve => {
      if (typeof window === 'undefined' || !window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
        resolve(false);
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = /[\u4e00-\u9fa5]/.test(text) ? 'zh-CN' : 'en-US';
        u.rate = Math.max(0.6, Math.min(2.0, Number(rate) || 1.0));
        u.onend = () => resolve(this.runId === myRun);
        u.onerror = () => resolve(false);
        window.speechSynthesis.speak(u);
      } catch {
        resolve(false);
      }
    });
  }

  async speakChunksProgressive(
    chunks: string[],
    {
      useCloudTts,
      fetchTts,
      speechRate = 1.0,
      duckMusicMode = false,
      keepAudioSessionAfter = false,
      onFirstLatency,
      onStateChange,
    }: {
      useCloudTts: boolean;
      fetchTts: (text: string, signal: AbortSignal) => Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; useBrowserSpeech?: boolean; latencyMs?: number }>;
      speechRate?: number;
      duckMusicMode?: boolean;
      keepAudioSessionAfter?: boolean;
      onFirstLatency?: (ms: number) => void;
      onStateChange?: (playing: boolean) => void;
    },
  ): Promise<void> {
    this.stop();
    const list = (chunks || []).map(c => String(c || '').trim()).filter(Boolean);
    if (list.length === 0) return;

    const myRun = this.runId;
    const ctrl = new AbortController();
    this.abortCtrl = ctrl;
    this.playing = true;
    if (duckMusicMode) {
      setWalkAudioSessionMode('transient');
    }
    onStateChange?.(true);

    try {
      if (!useCloudTts) {
        await this.speakNativeBrowser(list.join(' '), speechRate, {
          duckMusic: duckMusicMode,
          keepSessionAfter: keepAudioSessionAfter,
        });
        return;
      }

      // Pipeline prefetch: while chunk i plays, start synthesizing chunk i+1!
      let nextPromise: Promise<any> | null = fetchTts(list[0], ctrl.signal).catch(() => ({ ok: false }));
      for (let i = 0; i < list.length; i += 1) {
        if (this.runId !== myRun) break;
        const res = await nextPromise;
        if (this.runId !== myRun) break;

        if (i + 1 < list.length) {
          nextPromise = fetchTts(list[i + 1], ctrl.signal).catch(() => ({ ok: false }));
        } else {
          nextPromise = null;
        }

        if (i === 0 && typeof res?.latencyMs === 'number') {
          onFirstLatency?.(res.latencyMs);
        }

        const chunkOpts = {
          duckMusic: duckMusicMode,
          keepSessionAfter: keepAudioSessionAfter || i + 1 < list.length,
        };

        if (res?.ok && res.audioBase64) {
          const played = await this.playAudioBase64(res.audioBase64, res.mimeType || 'audio/mpeg', chunkOpts);
          if (!played && this.runId === myRun) {
            await this.speakNativeBrowser(list[i], speechRate, chunkOpts);
          }
        } else if (this.runId === myRun) {
          // Graceful fallback to native browser TTS if cloud TTS fails/unconfigured
          await this.speakNativeBrowser(list[i], speechRate, chunkOpts);
        }
      }
    } finally {
      if (this.runId === myRun) {
        this.playing = false;
        this.abortCtrl = null;
        if (duckMusicMode && !keepAudioSessionAfter) {
          setWalkAudioSessionMode('ambient');
        }
        onStateChange?.(false);
      }
    }
  }
}

export class WalkWakeLockManager {
  private sentinel: any = null;
  private wanted = false;
  private visHandler: (() => void) | null = null;

  isActive(): boolean {
    return Boolean(this.sentinel);
  }

  async enable(): Promise<boolean> {
    this.wanted = true;
    if (!this.visHandler && typeof document !== 'undefined') {
      this.visHandler = () => {
        if (this.wanted && document.visibilityState === 'visible') {
          void this._acquire();
        }
      };
      document.addEventListener('visibilitychange', this.visHandler);
    }
    return this._acquire();
  }

  private async _acquire(): Promise<boolean> {
    try {
      const wl = (navigator as any)?.wakeLock;
      if (!wl || typeof wl.request !== 'function') return false;
      this.sentinel = await wl.request('screen');
      this.sentinel?.addEventListener?.('release', () => {
        this.sentinel = null;
      });
      return true;
    } catch {
      this.sentinel = null;
      return false;
    }
  }

  async disable(): Promise<void> {
    this.wanted = false;
    if (this.visHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visHandler);
      this.visHandler = null;
    }
    if (this.sentinel) {
      try { await this.sentinel.release(); } catch {}
      this.sentinel = null;
    }
  }
}

export function bindWalkMediaSession(handlers: {
  onToggleListen: () => void;
  onNextBriefing: () => void;
  onStopSpeaking: () => void;
}): () => void {
  // Inside the native iOS shell, keep Lock Screen Now Playing owned by Apple Music / NetEase Music
  if (isNativeIosShell()) return () => {};
  const ms = typeof navigator !== 'undefined' ? (navigator as any).mediaSession : null;
  if (!ms || typeof ms.setActionHandler !== 'function') return () => {};
  try {
    if (typeof (window as any).MediaMetadata === 'function') {
      ms.metadata = new (window as any).MediaMetadata({
        title: 'PocketAgents 随行语音总管',
        artist: 'Walk Mode · AirPods Ready',
        album: 'Hands-Free AI Copilot',
      });
    }
    ms.setActionHandler('play', () => handlers.onToggleListen());
    ms.setActionHandler('pause', () => handlers.onStopSpeaking());
    ms.setActionHandler('nexttrack', () => handlers.onNextBriefing());
    ms.setActionHandler('previoustrack', () => handlers.onToggleListen());
  } catch {
    // unsupported media session action
  }
  return () => {
    try {
      ms.setActionHandler('play', null);
      ms.setActionHandler('pause', null);
      ms.setActionHandler('nexttrack', null);
      ms.setActionHandler('previoustrack', null);
    } catch {}
  };
}
