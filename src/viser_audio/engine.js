// audio.ts
var DRIFT_SECONDS = 0.08;
var AudioEngine = class {
  constructor(host) {
    this.host = host;
    this.ctx = null;
    this.clips = /* @__PURE__ */ new Map();
    this.transport = null;
    this.frame = null;
    this.unlockButton = null;
    this.resumePending = false;
    this.disposed = false;
    this.unlock = () => {
      const ctx = this.ctx;
      if (!ctx || ctx.state === "running" || this.resumePending) return;
      this.resumePending = true;
      void ctx.resume().then(() => {
        if (this.disposed) return;
        this.hideUnlock();
        this.syncTimeline();
      }).catch((error) => {
        if (!this.disposed) console.error("[viser-audio] Audio context could not resume", error);
      }).finally(() => {
        this.resumePending = false;
      });
    };
    this.tick = () => {
      this.frame = null;
      this.sync(false);
    };
  }
  handle(message) {
    this.checkAlive();
    if (message.type === "AudioAddMessage") {
      this.add(message);
    } else if (message.type === "AudioRemoveMessage") {
      this.remove(message.name);
    } else {
      const clip = this.clips.get(message.name);
      if (!clip) throw new Error(`Unknown audio clip: ${message.name}`);
      switch (message.type) {
        case "AudioSamplesMessage": {
          const buffer = this.buildBuffer(message.samples, message.num_channels, clip.sampleRate);
          this.stop(clip);
          clip.numChannels = message.num_channels;
          clip.buffer = buffer;
          clip.progress = 0;
          this.startLive(clip);
          break;
        }
        case "AudioAppendMessage": {
          this.append(clip, message.samples);
          break;
        }
        case "AudioUpdateMessage": {
          const u = message.updates;
          if (u.volume !== void 0) {
            clip.volume = u.volume;
            clip.gain.gain.value = u.volume;
          }
          if (u.loop !== void 0) {
            clip.progress = this.playhead(clip);
            clip.startedAt = this.context().currentTime;
            clip.loop = u.loop;
            if (clip.source) clip.source.loop = u.loop;
          }
          if (u.positional !== void 0) {
            clip.positional = u.positional;
            this.connectOutput(clip);
          }
          if (u.playback_rate !== void 0) {
            positiveRate(u.playback_rate);
            clip.progress = this.playhead(clip);
            this.stop(clip);
            clip.playbackRate = u.playback_rate;
            this.startLive(clip);
          }
          break;
        }
        case "AudioPlaybackMessage": {
          if (clip.startTime !== null)
            throw new Error("Use the transport to play timeline tracks.");
          this.stop(clip);
          clip.progress = message.offset;
          clip.playRequested = message.playing;
          this.startLive(clip);
          break;
        }
      }
    }
    this.syncTimeline();
    this.scheduleFrame();
  }
  /** Bind a client-local clock. Call sync() after seeks for immediate response. */
  setTransport(transport) {
    this.checkAlive();
    this.transport = transport;
    for (const clip of this.clips.values()) {
      if (clip.startTime !== null) this.stop(clip);
    }
    this.sync();
  }
  /** Restore the tracks folded at a recording checkpoint, then apply its events. */
  loadCheckpoint(tracks) {
    this.reset();
    for (const track of tracks) this.add(track);
    this.sync();
  }
  sync(force = true) {
    this.checkAlive();
    this.syncTimeline(force);
    this.updateSpatialization();
    this.scheduleFrame();
  }
  reset() {
    this.checkAlive();
    for (const name of this.clips.keys()) this.remove(name);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
  debug() {
    return [...this.clips.values()].map((clip) => ({
      name: clip.name,
      numChannels: clip.numChannels,
      sampleRate: clip.sampleRate,
      numFrames: clip.buffer?.length ?? 0,
      duration: clip.buffer?.duration ?? 0,
      playing: clip.source !== null,
      position: Math.max(0, this.playhead(clip)),
      volume: clip.volume,
      loop: clip.loop,
      positional: clip.positional,
      playbackRate: clip.playbackRate,
      startTime: clip.startTime,
      contextState: this.ctx?.state ?? "none"
    }));
  }
  dispose() {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    document.removeEventListener("pointerdown", this.unlock);
    document.removeEventListener("keydown", this.unlock);
    this.hideUnlock();
    void this.ctx?.close();
    this.ctx = null;
  }
  add(message) {
    positiveRate(message.playback_rate);
    const buffer = this.buildBuffer(message.samples, message.num_channels, message.sample_rate);
    this.remove(message.name);
    const clip = {
      name: message.name,
      sampleRate: message.sample_rate,
      numChannels: message.num_channels,
      volume: message.volume,
      loop: message.loop,
      positional: message.positional,
      playbackRate: message.playback_rate,
      startTime: message.start_time,
      buffer,
      source: null,
      gain: this.context().createGain(),
      panner: null,
      playRequested: false,
      progress: 0,
      startedAt: 0,
      sourceRate: message.playback_rate
    };
    clip.gain.gain.value = clip.volume;
    this.clips.set(clip.name, clip);
    this.connectOutput(clip);
  }
  context() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      document.addEventListener("pointerdown", this.unlock);
      document.addEventListener("keydown", this.unlock);
    }
    return this.ctx;
  }
  requestUnlock() {
    if (!this.unlockButton) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Enable audio";
      button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:10000;padding:8px 16px;cursor:pointer";
      button.addEventListener("click", this.unlock);
      document.body.append(button);
      this.unlockButton = button;
    }
    this.unlock();
  }
  hideUnlock() {
    this.unlockButton?.remove();
    this.unlockButton = null;
  }
  buildBuffer(samples, channels, rate) {
    const flat = sampleFloats(samples);
    if (!Number.isInteger(channels) || channels < 1 || channels > 32 || flat.length % channels) {
      throw new Error("Invalid interleaved audio channel count or sample length.");
    }
    const frames = flat.length / channels;
    if (!frames) return null;
    const buffer = this.context().createBuffer(channels, frames, rate);
    for (let channel = 0; channel < channels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) data[frame] = flat[frame * channels + channel];
    }
    return buffer;
  }
  connectOutput(clip) {
    const ctx = this.context();
    clip.gain.disconnect();
    clip.panner?.disconnect();
    if (clip.positional) {
      if (!this.host) throw new Error("Positional audio requires an AudioHost.");
      clip.panner ?? (clip.panner = new PannerNode(ctx, { panningModel: "HRTF", distanceModel: "inverse" }));
      clip.gain.connect(clip.panner);
      clip.panner.connect(ctx.destination);
    } else {
      clip.gain.connect(ctx.destination);
    }
  }
  playhead(clip) {
    if (!clip.source) return clip.progress;
    let position = clip.progress;
    position += (this.context().currentTime - clip.startedAt) * clip.sourceRate;
    const duration = clip.buffer?.duration ?? 0;
    if (clip.loop && duration && position >= 0) return position % duration;
    return Math.min(position, duration);
  }
  start(clip, position, rate) {
    const buffer = clip.buffer;
    if (!buffer || !clip.loop && position >= buffer.duration) return;
    const ctx = this.context();
    if (ctx.state !== "running") this.requestUnlock();
    const offset = clip.loop && position >= 0 ? position % buffer.duration : Math.max(0, position);
    const when = ctx.currentTime + Math.max(0, -position / rate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = clip.loop;
    source.playbackRate.value = rate;
    source.connect(clip.gain);
    source.onended = () => {
      source.disconnect();
      if (clip.source !== source) return;
      clip.source = null;
      clip.progress = buffer.duration;
    };
    source.start(when, offset);
    clip.source = source;
    clip.progress = offset;
    clip.startedAt = when;
    clip.sourceRate = rate;
  }
  stop(clip) {
    if (!clip.source) return;
    clip.source.onended = null;
    clip.source.stop();
    clip.source.disconnect();
    clip.source = null;
  }
  startLive(clip) {
    if (clip.startTime === null && clip.playRequested) {
      this.start(clip, clip.progress, clip.playbackRate);
    }
  }
  append(clip, samples) {
    const chunk = this.buildBuffer(samples, clip.numChannels, clip.sampleRate);
    if (!chunk) return;
    const old = clip.buffer;
    const oldLength = old?.length ?? 0;
    const buffer = this.context().createBuffer(
      clip.numChannels,
      oldLength + chunk.length,
      clip.sampleRate
    );
    for (let channel = 0; channel < clip.numChannels; channel++) {
      const data = buffer.getChannelData(channel);
      if (old) data.set(old.getChannelData(channel));
      data.set(chunk.getChannelData(channel), oldLength);
    }
    clip.progress = this.playhead(clip);
    this.stop(clip);
    clip.buffer = buffer;
    this.startLive(clip);
  }
  remove(name) {
    const clip = this.clips.get(name);
    if (!clip) return;
    this.stop(clip);
    clip.gain.disconnect();
    clip.panner?.disconnect();
    this.clips.delete(name);
  }
  syncTimeline(force = false) {
    if (!this.transport) return;
    const state = this.transport();
    positiveRate(state.rate);
    if (!Number.isFinite(state.position)) throw new Error("Timeline position must be finite.");
    for (const clip of this.clips.values()) {
      if (clip.startTime === null) continue;
      const duration = clip.buffer?.duration ?? 0;
      const position = (state.position - clip.startTime) * clip.playbackRate;
      const rate = state.rate * clip.playbackRate;
      if (!state.playing || !duration || !clip.loop && position >= duration) {
        this.stop(clip);
        clip.progress = Math.max(0, Math.min(position, duration));
        continue;
      }
      if (this.context().state !== "running") {
        this.requestUnlock();
        continue;
      }
      const desired = clip.loop && position >= 0 ? position % duration : position;
      const drift = Math.abs(this.playhead(clip) - desired);
      if (!force && clip.source && clip.sourceRate === rate && drift < DRIFT_SECONDS) continue;
      this.stop(clip);
      this.start(clip, position, rate);
    }
  }
  scheduleFrame() {
    const wanted = [...this.clips.values()].some(
      (clip) => clip.positional || clip.startTime !== null && this.transport
    );
    if (wanted && this.frame === null) this.frame = requestAnimationFrame(this.tick);
    if (!wanted && this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }
  checkAlive() {
    if (this.disposed) throw new Error("AudioEngine has been disposed.");
  }
  updateSpatialization() {
    const ctx = this.ctx;
    if (!ctx || ![...this.clips.values()].some((clip) => clip.positional)) return;
    const camera = this.host?.cameraMatrix();
    if (camera) {
      setListenerPose(
        ctx.listener,
        translation(camera),
        // A camera looks down its own -Z.
        normalize([-camera[8], -camera[9], -camera[10]]),
        normalize([camera[4], camera[5], camera[6]])
      );
    }
    for (const clip of this.clips.values()) {
      if (!clip.positional || !clip.panner) continue;
      const matrix = this.host?.nodeMatrix(clip.name);
      if (!matrix) continue;
      setPannerPose(
        clip.panner,
        translation(matrix),
        normalize([matrix[8], matrix[9], matrix[10]])
      );
    }
  }
};
function translation(matrix) {
  return [matrix[12], matrix[13], matrix[14]];
}
function sampleFloats(samples) {
  if (samples instanceof Float32Array) return samples;
  const bytes = samples instanceof ArrayBuffer ? new Uint8Array(samples) : samples;
  if (bytes.byteLength % 4) throw new Error("Audio samples must contain complete float32 values.");
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}
function positiveRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0)
    throw new Error("Playback rate must be finite and positive.");
}
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, -1];
}
function setPannerPose(panner, position, forward) {
  panner.positionX.value = position[0];
  panner.positionY.value = position[1];
  panner.positionZ.value = position[2];
  panner.orientationX.value = forward[0];
  panner.orientationY.value = forward[1];
  panner.orientationZ.value = forward[2];
}
function setListenerPose(listener, position, forward, up) {
  listener.positionX.value = position[0];
  listener.positionY.value = position[1];
  listener.positionZ.value = position[2];
  listener.forwardX.value = forward[0];
  listener.forwardY.value = forward[1];
  listener.forwardZ.value = forward[2];
  listener.upX.value = up[0];
  listener.upY.value = up[1];
  listener.upZ.value = up[2];
}
export {
  AudioEngine
};
