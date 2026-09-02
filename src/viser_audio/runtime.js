"use strict";
(() => {
  // audio.ts
  var APPEND_SWAP_LEAD_SECONDS = 0.05;
  var UNLOCK_NOTIFICATION_UUID = "viser-audio-unlock";
  function normalize(v) {
    const length = Math.hypot(v[0], v[1], v[2]);
    return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, -1];
  }
  function setPannerPose(panner, position, forward) {
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
  function setListenerPose(listener, position, forward, up) {
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
        up[2]
      );
    }
  }
  var AudioEngine = class {
    constructor(viser) {
      this.viser = viser;
      this.ctx = null;
      this.clips = /* @__PURE__ */ new Map();
      this.frame = null;
      this.unlockShown = false;
      this.unlock = () => {
        const ctx = this.ctx;
        if (!ctx || ctx.state === "running") return;
        void ctx.resume().then(() => {
          if (this.unlockShown) {
            this.unlockShown = false;
            this.viser.pushToViser({
              type: "RemoveNotificationMessage",
              uuid: UNLOCK_NOTIFICATION_UUID
            });
          }
        });
      };
      this.tick = () => {
        this.frame = requestAnimationFrame(this.tick);
        this.updateSpatialization();
      };
    }
    handle(message) {
      switch (message.type) {
        case "AudioAddMessage": {
          this.removeClip(message.name);
          const clip = {
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
            progress: 0,
            startedAt: 0
          };
          this.clips.set(clip.name, clip);
          clip.buffer = this.buildBuffer(clip);
          break;
        }
        case "AudioUpdateMessage": {
          const clip = this.clips.get(message.name);
          if (!clip) break;
          const updates = message.updates;
          if (updates.samples !== void 0) {
            this.loadSamples(
              clip,
              updates.samples,
              updates.num_channels ?? clip.numChannels
            );
          }
          if (updates.volume !== void 0) {
            clip.volume = updates.volume;
            if (clip.gain) clip.gain.gain.value = clip.volume;
          }
          if (updates.loop !== void 0) {
            clip.loop = updates.loop;
            if (clip.source) clip.source.loop = clip.loop;
          }
          if (updates.positional !== void 0) {
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
    debug() {
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
          contextState
        };
      });
    }
    dispose() {
      for (const name of [...this.clips.keys()]) this.removeClip(name);
      this.syncPositionalLoop();
      document.removeEventListener("pointerdown", this.unlock);
      document.removeEventListener("keydown", this.unlock);
      void this.ctx?.close();
      this.ctx = null;
    }
    // --- Context ---------------------------------------------------------
    context() {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        document.addEventListener("pointerdown", this.unlock);
        document.addEventListener("keydown", this.unlock);
      }
      return this.ctx;
    }
    requestUnlock() {
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
            color: null
          }
        });
      }
      this.unlock();
    }
    // --- Clip plumbing ---------------------------------------------------
    buildBuffer(clip) {
      const frames = Math.floor(clip.samples.length / clip.numChannels);
      if (frames === 0) return null;
      const ctx = this.context();
      const buffer = ctx.createBuffer(clip.numChannels, frames, clip.sampleRate);
      if (clip.numChannels === 1) {
        buffer.getChannelData(0).set(clip.samples.subarray(0, frames));
        return buffer;
      }
      for (let channel = 0; channel < clip.numChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; frame++) {
          data[frame] = clip.samples[frame * clip.numChannels + channel];
        }
      }
      return buffer;
    }
    connectOutput(clip) {
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
        clip.panner.panningModel = "HRTF";
        clip.panner.distanceModel = "inverse";
        clip.panner.refDistance = 1;
      }
      clip.gain.connect(clip.panner);
      clip.panner.disconnect();
      clip.panner.connect(ctx.destination);
    }
    playhead(clip) {
      if (!clip.playing || !this.ctx) return clip.progress;
      return clip.progress + Math.max(this.ctx.currentTime - clip.startedAt, 0);
    }
    startSource(clip, delay = 0) {
      const buffer = clip.buffer;
      if (!buffer) return;
      const ctx = this.context();
      this.connectOutput(clip);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = clip.loop;
      source.connect(clip.gain);
      source.onended = () => {
        if (clip.source !== source) return;
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
    stopSource(clip) {
      if (clip.source) {
        clip.source.onended = null;
        clip.source.stop();
        clip.source.disconnect();
        clip.source = null;
      }
      clip.playing = false;
    }
    startIfRequested(clip) {
      if (!clip.playRequested || clip.playing || !clip.buffer) return;
      if (this.context().state !== "running") this.requestUnlock();
      this.startSource(clip);
    }
    // --- Operations ------------------------------------------------------
    play(clip, offset) {
      clip.playRequested = true;
      const buffer = clip.buffer;
      if (!buffer) return;
      if (offset !== null) {
        this.stopSource(clip);
        clip.progress = Math.min(Math.max(offset, 0), buffer.duration);
      } else if (!clip.playing && clip.progress >= buffer.duration) {
        clip.progress = 0;
      }
      this.startIfRequested(clip);
    }
    pause(clip) {
      clip.playRequested = false;
      if (!clip.playing) return;
      const position = this.playhead(clip);
      const duration = clip.buffer?.duration ?? 0;
      clip.progress = clip.loop && duration > 0 ? position % duration : position;
      this.stopSource(clip);
    }
    loadSamples(clip, samples, numChannels) {
      this.stopSource(clip);
      clip.samples = samples;
      clip.numChannels = numChannels;
      clip.buffer = this.buildBuffer(clip);
      clip.progress = 0;
      this.startIfRequested(clip);
    }
    append(clip, chunk) {
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
      const previous = clip.source;
      const position = (this.playhead(clip) + APPEND_SWAP_LEAD_SECONDS) % buffer.duration;
      previous.onended = () => previous.disconnect();
      previous.stop(this.context().currentTime + APPEND_SWAP_LEAD_SECONDS);
      clip.source = null;
      clip.playing = false;
      clip.buffer = buffer;
      clip.progress = position;
      this.startSource(clip, APPEND_SWAP_LEAD_SECONDS);
    }
    removeClip(name) {
      const clip = this.clips.get(name);
      if (!clip) return;
      this.stopSource(clip);
      clip.gain?.disconnect();
      clip.panner?.disconnect();
      this.clips.delete(name);
    }
    // --- Spatialization --------------------------------------------------
    syncPositionalLoop() {
      const wanted = [...this.clips.values()].some((clip) => clip.positional);
      if (wanted && this.frame === null) {
        this.frame = requestAnimationFrame(this.tick);
      } else if (!wanted && this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
    }
    updateSpatialization() {
      const ctx = this.ctx;
      if (!ctx) return;
      const camera = this.viser.cameraMatrix();
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
        const matrix = this.viser.nodeMatrix(clip.name);
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

  // protocol.ts
  function isAudioMessage(message) {
    return message.type.startsWith("Audio");
  }

  // viser.ts
  function isRecord(value) {
    return !!value && typeof value === "object";
  }
  function isViewer(value) {
    return isRecord(value) && isRecord(value.mutable) && "useGuiConfig" in value && "guiActions" in value && "useSceneTree" in value;
  }
  function reactRoot() {
    const root = document.getElementById("root");
    if (!isRecord(root)) return null;
    const key = Object.keys(root).find(
      (name) => name.startsWith("__reactContainer$")
    );
    const container = key ? root[key] : null;
    return isRecord(container) ? container : null;
  }
  function findViewer() {
    const start = reactRoot();
    if (!start) return null;
    const seen = /* @__PURE__ */ new Set();
    const stack = [start];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const value = fiber.memoizedProps?.value;
      if (isViewer(value)) return value;
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
  }
  var RETRY_BUDGET_MS = 5e3;
  var Viser = class {
    constructor(onMessage) {
      this.onMessage = onMessage;
      this.viewer = null;
      this.queue = null;
      this.originalPush = null;
      this.wrappedPush = null;
      this.disposed = false;
      this.deadline = 0;
    }
    install() {
      this.deadline = performance.now() + RETRY_BUDGET_MS;
      this.tryInstall();
    }
    dispose() {
      this.disposed = true;
      if (this.queue && this.originalPush && this.queue.push === this.wrappedPush) {
        this.queue.push = this.originalPush;
      }
      this.viewer = null;
      this.queue = null;
      this.originalPush = null;
      this.wrappedPush = null;
    }
    get messageSource() {
      return this.viewer?.messageSource;
    }
    /** Recordings and embeds replay a scene without a server; audio is inert. */
    get isWebsocket() {
      return this.messageSource === "websocket";
    }
    /** Push a message into viser, bypassing our own interception. */
    pushToViser(message) {
      this.originalPush?.(message);
    }
    /** World matrix of a scene node, or null if it hasn't mounted yet. */
    nodeMatrix(name) {
      const node = this.viewer?.mutable.current.nodeRefFromName[name];
      return node ? node.matrixWorld.elements : null;
    }
    /** World matrix of the viewer camera. */
    cameraMatrix() {
      const camera = this.viewer?.mutable.current.camera;
      return camera ? camera.matrixWorld.elements : null;
    }
    tryInstall() {
      if (this.disposed || this.originalPush) return;
      const viewer = findViewer();
      if (viewer) {
        this.viewer = viewer;
        this.wrapQueue(viewer);
        return;
      }
      if (performance.now() >= this.deadline) {
        console.error(
          "[viser-audio] Could not locate the viewer in the React fiber tree after 5s of retries; audio is inactive."
        );
        return;
      }
      requestAnimationFrame(() => this.tryInstall());
    }
    wrapQueue(viewer) {
      const queue = viewer.mutable.current.messageQueue;
      const original = queue.push.bind(queue);
      const wrapped = (...messages) => {
        const forwarded = [];
        for (const message of messages) {
          if (!this.onMessage(message)) forwarded.push(message);
        }
        return forwarded.length ? original(...forwarded) : queue.length;
      };
      queue.push = wrapped;
      this.queue = queue;
      this.originalPush = original;
      this.wrappedPush = wrapped;
      this.recoverCurrentBatch();
    }
    /** viser runs the script that installs us from the middle of a message
     * batch it has already dequeued, so audio messages that arrived in the SAME
     * batch -- the whole scene replay, for a client that connects to a server
     * with existing clips -- are past our seam. viser reports messages it does
     * not recognize through `console.log`; catch ours there for the rest of
     * this batch, then put `console.log` back. */
    recoverCurrentBatch() {
      const original = console.log;
      const wrapped = (...args) => {
        const message = args[1];
        if (isRecord(message) && typeof message.type === "string" && this.onMessage(message)) {
          return;
        }
        original.apply(console, args);
      };
      console.log = wrapped;
      queueMicrotask(() => {
        if (console.log === wrapped) console.log = original;
      });
    }
  };

  // index.ts
  var Runtime = class {
    constructor() {
      this.viser = new Viser((message) => this.route(message));
      this.engine = new AudioEngine(this.viser);
      this.viser.install();
    }
    debug() {
      return this.engine.debug();
    }
    dispose() {
      this.viser.dispose();
      this.engine.dispose();
    }
    route(message) {
      if (!this.viser.isWebsocket || !isAudioMessage(message)) return false;
      this.engine.handle(message);
      return true;
    }
  };
  var win = window;
  win.__VISER_AUDIO__?.dispose();
  win.__VISER_AUDIO__ = new Runtime();
})();
