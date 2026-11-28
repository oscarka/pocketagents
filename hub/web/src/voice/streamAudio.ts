// Unified WebSocket Streaming Voice Client for PocketAgents Voice AI Hub.
// Captures continuous 16kHz mono PCM16 via AudioWorklet (with ScriptProcessorNode fallback),
// streams raw binary frames over single-port `/api/voice/stream`, renders live subtitles,
// and plays either 24kHz streaming PCM16 (Route A: Qwen Omni / OpenAI Realtime)
// or sequential MP3/WAV TTS chunks (Route B: Streaming ASR + ANY Brain + ANY TTS)
// with instant barge-in cancellation.

import type { WalkSpeechPlayer } from './walkAudio';

const PCM16_WORKLET_CODE = `
class PocketAgentsPcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.cursor = 0;
    this.output = [];
    this.ratio = sampleRate / 16000;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.pending.push(channel[i]);
    }
    while (this.cursor + this.ratio <= this.pending.length) {
      let value;
      if (this.ratio >= 1) {
        const start = Math.floor(this.cursor);
        const end = Math.max(start + 1, Math.floor(this.cursor + this.ratio));
        let sum = 0;
        for (let i = start; i < end; i += 1) sum += this.pending[i];
        value = sum / (end - start);
      } else {
        const start = Math.floor(this.cursor);
        const frac = this.cursor - start;
        const next = Math.min(start + 1, this.pending.length - 1);
        value = this.pending[start] * (1 - frac) + this.pending[next] * frac;
      }
      this.output.push(Math.max(-1, Math.min(1, value)));
      this.cursor += this.ratio;

      // 1600 samples = 100ms @ 16kHz = 3200 bytes PCM16
      if (this.output.length >= 1600) {
        const pcm = new Int16Array(1600);
        let peak = 0;
        for (let i = 0; i < 1600; i += 1) {
          const s = this.output[i];
          const a = Math.abs(s);
          if (a > peak) peak = a;
          pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
        }
        this.output.splice(0, 1600);
        this.port.postMessage({ level: peak, pcm16: pcm.buffer }, [pcm.buffer]);
      }
    }
    const consumed = Math.floor(this.cursor);
    if (consumed > 0) {
      this.pending.splice(0, consumed);
      this.cursor -= consumed;
    }
    return true;
  }
}
registerProcessor('pocketagents-pcm16-input', PocketAgentsPcm16Processor);
`;

function decodeBase64ToBytes(b64: string): Uint8Array {
  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function downsampleFloat32ToPcm16(input: Float32Array, inRate: number, outRate = 16000): { pcm: Int16Array; level: number } {
  if (input.length === 0) return { pcm: new Int16Array(0), level: 0 };
  const ratio = Math.max(0.25, inRate / outRate);
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const pcm = new Int16Array(outLen);
  let peak = 0;
  for (let i = 0; i < outLen; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    const a = Math.abs(sample);
    if (a > peak) peak = a;
    pcm[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return { pcm, level: peak };
}

class Pcm24kStreamPlayer {
  private ctx: AudioContext | null = null;
  private nextTime = 0;
  private activeNodes: Set<AudioBufferSourceNode> = new Set();
  private playbackRate = 1.0;
  private onSpeakingChange?: (speaking: boolean) => void;

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange;
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new Ctor();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.75, Math.min(2.0, Number(rate) || 1.0));
  }

  enqueuePcm16Base64(b64: string, sampleRate = 24000): void {
    const ctx = this.ensureContext();
    if (!ctx || !b64) return;
    const bytes = decodeBase64ToBytes(b64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount <= 0) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    const floats = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      floats[i] = view.getInt16(i * 2, true) / 32768;
    }
    const audioBuf = ctx.createBuffer(1, sampleCount, sampleRate);
    audioBuf.copyToChannel(floats, 0);

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    try { src.playbackRate.value = this.playbackRate; } catch {}
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    const startAt = Math.max(now + 0.015, this.nextTime);
    const dur = audioBuf.duration / this.playbackRate;
    this.nextTime = startAt + dur;

    const wasEmpty = this.activeNodes.size === 0;
    this.activeNodes.add(src);
    if (wasEmpty) this.onSpeakingChange?.(true);

    src.onended = () => {
      this.activeNodes.delete(src);
      if (this.activeNodes.size === 0) {
        this.onSpeakingChange?.(false);
      }
    };
    try {
      src.start(startAt);
    } catch {
      this.activeNodes.delete(src);
    }
  }

  clear(): void {
    for (const node of this.activeNodes) {
      try { node.onended = null; node.stop(); } catch {}
    }
    this.activeNodes.clear();
    if (this.ctx) {
      this.nextTime = this.ctx.currentTime;
    } else {
      this.nextTime = 0;
    }
    this.onSpeakingChange?.(false);
  }

  dispose(): void {
    this.clear();
    if (this.ctx) {
      try { void this.ctx.close(); } catch {}
      this.ctx = null;
    }
  }
}

export interface WalkStreamCallbacks {
  onReady?: (info: { mode: string; adapter: string; providerLabel: string; model: string; voice?: string }) => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onPartial?: (text: string) => void;
  onFinal?: (text: string, sttMs: number) => void;
  onThinking?: (text: string) => void;
  onTurnResult?: (turn: any, fromRealtimeTool?: boolean) => void;
  onAssistantDelta?: (delta: string) => void;
  onAssistantDone?: (text: string) => void;
  onSpeakingChange?: (speaking: boolean) => void;
  onLevel?: (level: number) => void;
  onError?: (msg: string, fatal: boolean) => void;
  onClose?: () => void;
}

export interface WalkStreamStartOptions {
  authToken: string;
  voiceSessionId: string;
  profileId?: string;
  mode?: 'auto' | 'pipeline' | 'realtime';
  activeHostId?: string;
  activeSessionId?: string;
  focusedApproval?: any;
  speechRate?: number;
  speechPlayer?: WalkSpeechPlayer | null;
  callbacks?: WalkStreamCallbacks;
}

export class WalkVoiceStreamClient {
  private ws: WebSocket | null = null;
  private micStream: MediaStream | null = null;
  private inputCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private workletBlobUrl = '';
  private pcmPlayer: Pcm24kStreamPlayer | null = null;
  private speechPlayer: WalkSpeechPlayer | null = null;
  private cb: WalkStreamCallbacks = {};
  private active = false;
  private ready = false;
  private currentEpoch = 1;
  private mode: 'pipeline' | 'realtime' = 'pipeline';
  private speechRate = 1.0;
  private chunkQueue: Array<{ audioBase64: string; mimeType: string; epoch: number }> = [];
  private drainingChunks = false;

  isActive(): boolean {
    return this.active;
  }

  isReady(): boolean {
    return this.active && this.ready;
  }

  setPlaybackRate(rate: number): void {
    this.speechRate = Math.max(0.75, Math.min(2.0, Number(rate) || 1.0));
    this.pcmPlayer?.setPlaybackRate(this.speechRate);
    this.speechPlayer?.setPlaybackRate(this.speechRate);
  }

  async start(opts: WalkStreamStartOptions): Promise<void> {
    this.stop();
    this.active = true;
    this.ready = false;
    this.cb = opts.callbacks || {};
    this.speechPlayer = opts.speechPlayer || null;
    this.speechRate = Math.max(0.75, Math.min(2.0, Number(opts.speechRate) || 1.0));
    this.pcmPlayer = new Pcm24kStreamPlayer(speaking => {
      if (this.active) this.cb.onSpeakingChange?.(speaking);
    });
    this.pcmPlayer.setPlaybackRate(this.speechRate);

    // 1. Open browser microphone (hardware AEC + NS + AGC ON; ZERO client volume threshold!)
    if (!navigator?.mediaDevices?.getUserMedia) {
      this.active = false;
      throw new Error('当前浏览器不支持麦克风流式采集（需要 HTTPS）');
    }
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!this.active) {
      this.stop();
      return;
    }

    // 2. Connect single-port `/api/voice/stream` WebSocket
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tok = encodeURIComponent(String(opts.authToken || '').trim());
    const wsUrl = `${proto}//${window.location.host}/api/voice/stream${tok ? `?token=${tok}` : ''}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('连接实时语音通道超时，请检查网络或 Nginx WebSocket 代理'));
        }
      }, 15_000);

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'start',
          voiceSessionId: opts.voiceSessionId,
          profileId: opts.profileId || '',
          mode: opts.mode || 'auto',
          activeHostId: opts.activeHostId || '',
          activeSessionId: opts.activeSessionId || '',
          focusedApproval: opts.focusedApproval || null,
        }));
      };

      ws.onmessage = ev => {
        if (typeof ev.data !== 'string') return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === 'ready') {
          this.ready = true;
          this.mode = msg.mode === 'realtime' ? 'realtime' : 'pipeline';
          if (typeof msg.epoch === 'number') this.currentEpoch = msg.epoch;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
          this.cb.onReady?.({
            mode: this.mode,
            adapter: String(msg.adapter || ''),
            providerLabel: String(msg.providerLabel || ''),
            model: String(msg.model || ''),
            voice: String(msg.voice || ''),
          });
          return;
        }

        if (msg.type === 'error') {
          const errText = String(msg.message || '实时语音通道异常');
          if (!settled && msg.fatal) {
            settled = true;
            clearTimeout(timer);
            reject(new Error(errText));
            return;
          }
          this.cb.onError?.(errText, Boolean(msg.fatal));
          if (msg.fatal) this.stop();
          return;
        }

        this._handleServerEvent(msg);
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('无法建立实时语音 WebSocket 连接'));
        }
      };

      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error('实时语音连接已断开'));
          return;
        }
        const wasActive = this.active;
        this._cleanupMediaAndSocket();
        if (wasActive) this.cb.onClose?.();
      };
    });

    if (!this.active) {
      this.stop();
      return;
    }

    // 3. Start AudioWorklet (or ScriptProcessorNode fallback) streaming 16kHz PCM16 binary frames
    await this._startPcmCapture();
  }

  private async _startPcmCapture(): Promise<void> {
    if (!this.micStream || !this.active) return;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) throw new Error('浏览器不支持 Web Audio');
    const ctx: AudioContext = new Ctor();
    this.inputCtx = ctx;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    const source = ctx.createMediaStreamSource(this.micStream);
    // Route through a zero-gain node so Safari/WKWebView keeps pulling audio frames without speaker feedback!
    const muteGain = ctx.createGain();
    muteGain.gain.value = 0;

    const sendPcmBuffer = (buf: ArrayBuffer, level: number) => {
      if (!this.active) return;
      this.cb.onLevel?.(Math.min(1, Math.max(0, level * 2.2)));
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) {
        this.ws.send(buf);
      }
    };

    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const blob = new Blob([PCM16_WORKLET_CODE], { type: 'application/javascript' });
        this.workletBlobUrl = URL.createObjectURL(blob);
        await ctx.audioWorklet.addModule(this.workletBlobUrl);
        if (!this.active) return;
        const node = new AudioWorkletNode(ctx, 'pocketagents-pcm16-input');
        this.workletNode = node;
        node.port.onmessage = ev => {
          const payload = ev.data;
          if (payload?.pcm16 instanceof ArrayBuffer) {
            sendPcmBuffer(payload.pcm16, Number(payload.level) || 0);
          }
        };
        source.connect(node);
        node.connect(muteGain);
        muteGain.connect(ctx.destination);
        return;
      } catch {
        // Fall through cleanly to ScriptProcessorNode on restricted WebViews
      }
    }

    const scriptNode = ctx.createScriptProcessor(4096, 1, 1);
    this.scriptNode = scriptNode;
    scriptNode.onaudioprocess = ev => {
      if (!this.active) return;
      const input = ev.inputBuffer.getChannelData(0);
      const { pcm, level } = downsampleFloat32ToPcm16(input, ctx.sampleRate, 16000);
      if (pcm.byteLength > 0) {
        sendPcmBuffer(pcm.buffer, level);
      }
    };
    source.connect(scriptNode);
    scriptNode.connect(muteGain);
    muteGain.connect(ctx.destination);
  }

  private _clearAudioOutput(): void {
    this.chunkQueue = [];
    this.pcmPlayer?.clear();
    this.speechPlayer?.stop();
    this.cb.onSpeakingChange?.(false);
  }

  private async _drainEncodedAudioQueue(): Promise<void> {
    if (this.drainingChunks) return;
    this.drainingChunks = true;
    this.cb.onSpeakingChange?.(true);
    try {
      while (this.active && this.chunkQueue.length > 0) {
        const next = this.chunkQueue.shift()!;
        if (next.epoch !== this.currentEpoch) continue;
        if (this.speechPlayer) {
          this.speechPlayer.setPlaybackRate(this.speechRate);
          await this.speechPlayer.playAudioBase64(next.audioBase64, next.mimeType);
        }
      }
    } finally {
      this.drainingChunks = false;
      if (this.chunkQueue.length === 0) {
        this.cb.onSpeakingChange?.(false);
      }
    }
  }

  private _handleServerEvent(msg: any): void {
    const evEpoch = typeof msg.epoch === 'number' ? msg.epoch : this.currentEpoch;

    switch (msg.type) {
      case 'clear_output':
        if (typeof msg.epoch === 'number') this.currentEpoch = msg.epoch;
        this._clearAudioOutput();
        break;
      case 'speech_started':
        this.cb.onSpeechStarted?.();
        break;
      case 'speech_stopped':
        this.cb.onSpeechStopped?.();
        break;
      case 'transcript_partial':
        this.cb.onPartial?.(String(msg.text || ''));
        break;
      case 'transcript_final':
        this.cb.onFinal?.(String(msg.text || ''), Number(msg.sttMs) || 0);
        break;
      case 'turn_thinking':
        this.cb.onThinking?.(String(msg.text || ''));
        break;
      case 'turn_result':
        this.cb.onTurnResult?.(msg.turn, Boolean(msg.fromRealtimeTool));
        break;
      case 'assistant_delta':
        this.cb.onAssistantDelta?.(String(msg.delta || ''));
        break;
      case 'assistant_done':
        this.cb.onAssistantDone?.(String(msg.text || ''));
        break;
      case 'audio_chunk': {
        if (evEpoch < this.currentEpoch) return;
        if (msg.format === 'pcm16') {
          this.pcmPlayer?.enqueuePcm16Base64(String(msg.audioBase64 || ''), Number(msg.sampleRate) || 24000);
        } else if (msg.audioBase64) {
          this.chunkQueue.push({
            audioBase64: String(msg.audioBase64),
            mimeType: String(msg.mimeType || 'audio/mpeg'),
            epoch: evEpoch,
          });
          void this._drainEncodedAudioQueue();
        }
        break;
      }
      case 'audio_done':
        if (msg.useNativeTts) {
          this.cb.onSpeakingChange?.(false);
        }
        break;
      default:
        break;
    }
  }

  bargeIn(): void {
    this.currentEpoch += 1;
    this._clearAudioOutput();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'barge_in' }));
    }
  }

  sendContext(ctx: { activeHostId?: string; activeSessionId?: string; focusedApproval?: any }): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) {
      this.ws.send(JSON.stringify({ type: 'context', ...ctx }));
    }
  }

  sendTextTurn(text: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return false;
    this.ws.send(JSON.stringify({ type: 'text_turn', text }));
    return true;
  }

  private _cleanupMediaAndSocket(): void {
    this.active = false;
    this.ready = false;
    this.chunkQueue = [];
    this.pcmPlayer?.dispose();
    this.pcmPlayer = null;
    if (this.workletNode) {
      try { this.workletNode.port.onmessage = null; this.workletNode.disconnect(); } catch {}
      this.workletNode = null;
    }
    if (this.scriptNode) {
      try { this.scriptNode.onaudioprocess = null; this.scriptNode.disconnect(); } catch {}
      this.scriptNode = null;
    }
    if (this.workletBlobUrl) {
      try { URL.revokeObjectURL(this.workletBlobUrl); } catch {}
      this.workletBlobUrl = '';
    }
    if (this.inputCtx) {
      try { void this.inputCtx.close(); } catch {}
      this.inputCtx = null;
    }
    if (this.micStream) {
      for (const t of this.micStream.getTracks()) {
        try { t.stop(); } catch {}
      }
      this.micStream = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'stop' }));
        }
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  stop(): void {
    this._cleanupMediaAndSocket();
    this.cb.onLevel?.(0);
    this.cb.onSpeakingChange?.(false);
  }
}
