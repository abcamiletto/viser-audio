// Web Audio engine: one clip per scene node, driven entirely by messages.
//
// Playback semantics follow the ones a THREE.Audio would give us, minus
// three.js: play(offset) restarts a finished clip, pause() keeps the playhead,
// appends swap in a longer buffer without a gap, and a source that runs out
// leaves the playhead at the end so a stream that ran dry resumes there.

import type { AudioMessage } from "./protocol";
import type { MatrixElements, Viser } from "./viser";

/** Lead time for swapping in a longer buffer mid-playback: long enough to
 * survive a slow frame, short enough to be imperceptible. */
const APPEND_SWAP_LEAD_SECONDS = 0.05;
const UNLOCK_NOTIFICATION_UUID = "viser-audio-unlock";

type Vec3 = [number, number, number];

type Clip = {
  name: string;
  sampleRate: number;
  numChannels: number;
  /** Interleaved, frame-major: samples[frame * numChannels + channel]. */
  samples: Float32Array;
  volume: number;
  loop: boolean;
  positional: boolean;
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  gain: GainNode | null;
  panner: PannerNode | null;
  playing: boolean;
  /** What the server last asked for; stays true when a source ends on its own. */
  playRequested: boolean;
  /** Playhead, in seconds, as of `startedAt` (or now, when paused). */
  progress: number;
  startedAt: number;
};

export type ClipDebugState = {
  name: string;
  numChannels: number;
  sampleRate: number;
  numFrames: number;
  duration: number;
  playing: boolean;
  position: number;
  volume: number;
  loop: boolean;
  positional: boolean;
  contextState: string;
};

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, -1];
}

function setPannerPose(panner: PannerNode, position: Vec3, forward: Vec3): void {
  if (panner.positionX) {
    panner.positionX.value = position[0];
    panner.positionY.value = position[1];
    panner.positionZ.value = position[2];
    panner.orientationX.value = forward[0];
    panner.orientationY.value = forward[1];
    panner.orientationZ.value = forward[2];
  } else {
    panner.setPosition(position[0], position[1], position[2]);
    panner.setOrientation(forward[0], forward[1], forward[2]);
  }
}

function setListenerPose(
  listener: AudioListener,
  position: Vec3,
  forward: Vec3,
  up: Vec3,
): void {
  if (listener.positionX) {
    listener.positionX.value = position[0];
    listener.positionY.value = position[1];
    listener.positionZ.value = position[2];
    listener.forwardX.value = forward[0];
    listener.forwardY.value = forward[1];
    listener.forwardZ.value = forward[2];
    listener.upX.value = up[0];
    listener.upY.value = up[1];
    listener.upZ.value = up[2];
  } else {
    listener.setPosition(position[0], position[1], position[2]);
    listener.setOrientation(
      forward[0],
      forward[1],
      forward[2],
      up[0],
      up[1],
      up[2],
    );
  }
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private clips = new Map<string, Clip>();
  private frame: number | null = null;
  private unlockShown = false;

  constructor(private readonly viser: Viser) {}

  handle(message: AudioMessage): void {
    switch (message.type) {
      case "AudioAddMessage": {
        this.removeClip(message.name);
        const clip: Clip = {
          name: message.name,
          sampleRate: message.sample_rate,
          numChannels: message.num_channels,
          samples: message.samples,
          volume: message.volume,
          loop: message.loop,
          positional: message.positional,
          buffer: null,
          source: null,
          gain: null,
          panner: null,
          playing: false,
          playRequested: false,
          progress: 0.0,
          startedAt: 0.0,
        };
        this.clips.set(clip.name, clip);
        clip.buffer = this.buildBuffer(clip);
        break;
      }
      case "AudioUpdateMessage": {
        const clip = this.clips.get(message.name);
        if (!clip) break;
        const updates = message.updates;
        if (updates.samples !== undefined) {
          this.loadSamples(
            clip,
            updates.samples,
            updates.num_channels ?? clip.numChannels,
          );
        }
        if (updates.volume !== undefined) {
          clip.volume = updates.volume;
          if (clip.gain) clip.gain.gain.value = clip.volume;
        }
        if (updates.loop !== undefined) {
          clip.loop = updates.loop;
          if (clip.source) clip.source.loop = clip.loop;
        }
        if (updates.positional !== undefined) {
          // The source stays connected to the gain node, so re-routing the
          // gain's output keeps the playhead exactly where it was.
          clip.positional = updates.positional;
          if (clip.gain) this.connectOutput(clip);
        }
        break;
      }
      case "AudioAppendMessage": {
        const clip = this.clips.get(message.name);
        if (clip) this.append(clip, message.samples);
        break;
      }
      case "AudioPlaybackMessage": {
        const clip = this.clips.get(message.name);
        if (!clip) break;
        if (message.playing) this.play(clip, message.offset);
        else this.pause(clip);
        break;
      }
      case "AudioRemoveMessage": {
        this.removeClip(message.name);
        break;
      }
    }
    this.syncPositionalLoop();
  }

  debug(): ClipDebugState[] {
    const contextState = this.ctx === null ? "none" : this.ctx.state;
    return [...this.clips.values()].map((clip) => {
      const numFrames = Math.floor(clip.samples.length / clip.numChannels);
      return {
        name: clip.name,
        numChannels: clip.numChannels,
        sampleRate: clip.sampleRate,
        numFrames,
        duration: numFrames / clip.sampleRate,
        playing: clip.playing,
        position: this.playhead(clip),
        volume: clip.volume,
        loop: clip.loop,
        positional: clip.positional,
        contextState,
      };
    });
  }

  dispose(): void {
    for (const name of [...this.clips.keys()]) this.removeClip(name);
    this.syncPositionalLoop();
    document.removeEventListener("pointerdown", this.unlock);
    document.removeEventListener("keydown", this.unlock);
    void this.ctx?.close();
    this.ctx = null;
  }

  // --- Context ---------------------------------------------------------

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      // Browsers keep a context suspended until the page sees a user gesture.
      document.addEventListener("pointerdown", this.unlock);
      document.addEventListener("keydown", this.unlock);
    }
    return this.ctx;
  }

  private unlock = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running") return;
    void ctx.resume().then(() => {
      if (this.unlockShown) {
        this.unlockShown = false;
        this.viser.pushToViser({
          type: "RemoveNotificationMessage",
          uuid: UNLOCK_NOTIFICATION_UUID,
        });
      }
    });
  };

  private requestUnlock(): void {
    if (!this.unlockShown) {
      this.unlockShown = true;
      this.viser.pushToViser({
        type: "NotificationShowMessage",
        uuid: UNLOCK_NOTIFICATION_UUID,
        props: {
          title: "Audio is waiting",
          body: "Click or press a key to enable audio.",
          loading: false,
          with_close_button: true,
          auto_close_seconds: null,
          color: null,
        },
      });
    }
    this.unlock();
  }

  // --- Clip plumbing ---------------------------------------------------

  private buildBuffer(clip: Clip): AudioBuffer | null {
    const frames = Math.floor(clip.samples.length / clip.numChannels);
    // A streamed clip can start empty, waiting for its first chunk.
    if (frames === 0) return null;
    const ctx = this.context();
    const buffer = ctx.createBuffer(clip.numChannels, frames, clip.sampleRate);
    if (clip.numChannels === 1) {
      buffer.getChannelData(0).set(clip.samples.subarray(0, frames));
      return buffer;
    }
    // De-interleave.
    for (let channel = 0; channel < clip.numChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) {
        data[frame] = clip.samples[frame * clip.numChannels + channel];
      }
    }
    return buffer;
  }

  private connectOutput(clip: Clip): void {
    const ctx = this.context();
    if (!clip.gain) {
      clip.gain = ctx.createGain();
      clip.gain.gain.value = clip.volume;
    }
    clip.gain.disconnect();
    if (!clip.positional) {
      clip.panner?.disconnect();
      clip.gain.connect(ctx.destination);
      return;
    }
    if (!clip.panner) {
      clip.panner = ctx.createPanner();
      // three.js PositionalAudio defaults.
      clip.panner.panningModel = "HRTF";
      clip.panner.distanceModel = "inverse";
      clip.panner.refDistance = 1;
    }
    clip.gain.connect(clip.panner);
    clip.panner.disconnect();
    clip.panner.connect(ctx.destination);
  }

  private playhead(clip: Clip): number {
    if (!clip.playing || !this.ctx) return clip.progress;
    return clip.progress + Math.max(this.ctx.currentTime - clip.startedAt, 0);
  }

  private startSource(clip: Clip, delay = 0.0): void {
    const buffer = clip.buffer;
    if (!buffer) return;
    const ctx = this.context();
    this.connectOutput(clip);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = clip.loop;
    source.connect(clip.gain!);
    source.onended = () => {
      if (clip.source !== source) return;
      // Leave the playhead at the end rather than rewinding: a stream that
      // ran dry resumes there when the next chunk arrives, and play()
      // restarts a finished clip itself.
      source.disconnect();
      clip.source = null;
      clip.playing = false;
      clip.progress = buffer.duration;
    };
    const startAt = ctx.currentTime + delay;
    source.start(startAt, Math.min(clip.progress, buffer.duration));
    clip.source = source;
    clip.startedAt = startAt;
    clip.playing = true;
  }

  private stopSource(clip: Clip): void {
    if (clip.source) {
      clip.source.onended = null;
      clip.source.stop();
      clip.source.disconnect();
      clip.source = null;
    }
    clip.playing = false;
  }

  private startIfRequested(clip: Clip): void {
    if (!clip.playRequested || clip.playing || !clip.buffer) return;
    if (this.context().state !== "running") this.requestUnlock();
    this.startSource(clip);
  }

  // --- Operations ------------------------------------------------------

  private play(clip: Clip, offset: number | null): void {
    clip.playRequested = true;
    const buffer = clip.buffer;
    if (!buffer) return;
    if (offset !== null) {
      this.stopSource(clip);
      clip.progress = Math.min(Math.max(offset, 0.0), buffer.duration);
    } else if (!clip.playing && clip.progress >= buffer.duration) {
      clip.progress = 0.0;
    }
    this.startIfRequested(clip);
  }

  private pause(clip: Clip): void {
    clip.playRequested = false;
    if (!clip.playing) return;
    const position = this.playhead(clip);
    const duration = clip.buffer?.duration ?? 0.0;
    clip.progress = clip.loop && duration > 0 ? position % duration : position;
    this.stopSource(clip);
  }

  private loadSamples(
    clip: Clip,
    samples: Float32Array,
    numChannels: number,
  ): void {
    this.stopSource(clip);
    clip.samples = samples;
    clip.numChannels = numChannels;
    clip.buffer = this.buildBuffer(clip);
    clip.progress = 0.0;
    this.startIfRequested(clip);
  }

  private append(clip: Clip, chunk: Float32Array): void {
    if (chunk.length === 0) return;
    const samples = new Float32Array(clip.samples.length + chunk.length);
    samples.set(clip.samples);
    samples.set(chunk, clip.samples.length);
    clip.samples = samples;
    const buffer = this.buildBuffer(clip);
    if (!buffer) return;

    if (!clip.playing) {
      clip.buffer = buffer;
      this.startIfRequested(clip);
      return;
    }
    // Stop the running source and start one on the longer buffer at the same
    // future context time, with a matching offset, so the crossover is
    // sample-accurate rather than an audible stop-and-restart.
    const previous = clip.source!;
    const position =
      (this.playhead(clip) + APPEND_SWAP_LEAD_SECONDS) % buffer.duration;
    previous.onended = () => previous.disconnect();
    previous.stop(this.context().currentTime + APPEND_SWAP_LEAD_SECONDS);
    clip.source = null;
    clip.playing = false;
    clip.buffer = buffer;
    clip.progress = position;
    this.startSource(clip, APPEND_SWAP_LEAD_SECONDS);
  }

  private removeClip(name: string): void {
    const clip = this.clips.get(name);
    if (!clip) return;
    this.stopSource(clip);
    clip.gain?.disconnect();
    clip.panner?.disconnect();
    this.clips.delete(name);
  }

  // --- Spatialization --------------------------------------------------

  private syncPositionalLoop(): void {
    const wanted = [...this.clips.values()].some((clip) => clip.positional);
    if (wanted && this.frame === null) {
      this.frame = requestAnimationFrame(this.tick);
    } else if (!wanted && this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  private tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);
    this.updateSpatialization();
  };

  private updateSpatialization(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const camera = this.viser.cameraMatrix();
    if (camera) {
      setListenerPose(
        ctx.listener,
        translation(camera),
        // A camera looks down its own -Z.
        normalize([-camera[8], -camera[9], -camera[10]]),
        normalize([camera[4], camera[5], camera[6]]),
      );
    }
    for (const clip of this.clips.values()) {
      if (!clip.positional || !clip.panner) continue;
      // Looked up every frame: the scene node may mount after its clip.
      const matrix = this.viser.nodeMatrix(clip.name);
      if (!matrix) continue;
      setPannerPose(
        clip.panner,
        translation(matrix),
        normalize([matrix[8], matrix[9], matrix[10]]),
      );
    }
  }
}

function translation(matrix: MatrixElements): Vec3 {
  return [matrix[12], matrix[13], matrix[14]];
}
