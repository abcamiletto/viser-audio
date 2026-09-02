import { notifications } from "@mantine/notifications";
import { useFrame, useThree } from "@react-three/fiber";
import React from "react";
import * as THREE from "three";

import { AudioMessage } from "./WebsocketMessages";
import { ViewerContext, variantKey } from "./ViewerContext";

/** three.js `Audio` playhead bookkeeping that its typings omit or mark
 * readonly. We drive it by hand for gapless appends. */
type AudioInternals = {
  _progress: number;
  _startedAt: number;
  isPlaying: boolean;
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
};

/** Lead time for swapping in a longer buffer mid-playback: long enough to
 * survive a slow frame, short enough to be imperceptible. */
const APPEND_SWAP_LEAD_SECONDS = 0.05;
const UNLOCK_NOTIFICATION_ID = "viser-audio-unlock";

// One listener per page, created by the first audio node: constructing it
// opens an AudioContext, which we don't want for scenes without audio.
let listener: THREE.AudioListener | null = null;
let playerPaused = false;

function getListener(): THREE.AudioListener {
  if (listener === null) {
    listener = new THREE.AudioListener();
    if (playerPaused) listener.context.suspend();
    // Browsers keep the context suspended until the page sees a user gesture.
    document.addEventListener("pointerdown", resumeContext);
    document.addEventListener("keydown", resumeContext);
  }
  return listener;
}

function resumeContext() {
  if (listener === null || playerPaused) return;
  if (listener.context.state === "running") return;
  listener.context
    .resume()
    .then(() => notifications.hide(UNLOCK_NOTIFICATION_ID));
}

/** Pause/resume all audio with the recording playback bar by freezing the
 * Web Audio clock. Backward seeks reset and replay the scene, so audio then
 * restarts from the start of its clip rather than from the recorded offset. */
export function setAudioPlayerPaused(paused: boolean) {
  playerPaused = paused;
  if (paused) listener?.context.suspend();
  else resumeContext();
}

export const SceneAudio = React.forwardRef<
  THREE.Group,
  AudioMessage & { children?: React.ReactNode }
>(function SceneAudio({ children, ...message }, ref) {
  const viewer = React.useContext(ViewerContext)!;
  const camera = useThree((state) => state.camera);
  const props = message.props;
  const commandKey = variantKey(message.owner, message.name);

  // A hidden node -- or one with a hidden ancestor -- is muted.
  const displayed =
    viewer.useSceneTree(
      message.name,
      (node) => node?.effectiveVisibility ?? true,
    ) ?? true;

  const audio = React.useMemo(() => {
    const audio = props.positional
      ? new THREE.PositionalAudio(getListener())
      : new THREE.Audio(getListener());
    // three rewinds the playhead when a source ends on its own. Leave it at
    // the end instead: a stream that ran dry then resumes where it stopped
    // when the next chunk arrives, and play() restarts finished clips itself.
    audio.onEnded = () => {
      internals.isPlaying = false;
      internals._progress = audio.buffer!.duration;
    };
    return audio;
  }, [props.positional]);
  const internals = audio as unknown as AudioInternals;

  // The clip lives here rather than in props, since streamed chunks never
  // come back as prop updates. `playRequested` is what the server last asked
  // for; it stays true when a source ends on its own.
  const clip = React.useRef({
    samples: props._samples,
    loaded: { samples: props._samples, numChannels: 0, sampleRate: 0 },
    playRequested: false,
    resumePosition: 0.0,
  }).current;

  function makeBuffer(): AudioBuffer | null {
    const numChannels = props._num_channels;
    const numFrames = Math.floor(clip.samples.length / numChannels);
    // A streaming node can start empty, waiting for its first chunk.
    if (numFrames === 0) return null;
    const buffer = audio.context.createBuffer(
      numChannels,
      numFrames,
      props.sample_rate,
    );
    for (let c = 0; c < numChannels; c++) {
      const channel = buffer.getChannelData(c);
      for (let i = 0; i < numFrames; i++) {
        channel[i] = clip.samples[i * numChannels + c];
      }
    }
    return buffer;
  }

  /** Seconds into the clip, following three's own `pause()` arithmetic. */
  function playhead(): number {
    if (!audio.isPlaying) return internals._progress;
    const elapsed = audio.context.currentTime - internals._startedAt;
    return internals._progress + Math.max(elapsed, 0);
  }

  function startIfRequested() {
    if (!clip.playRequested || audio.isPlaying || audio.buffer === null) return;
    if (audio.context.state !== "running" && !playerPaused) {
      notifications.show({
        id: UNLOCK_NOTIFICATION_ID,
        title: "Audio is waiting",
        message: "Click anywhere in the page to start audio playback.",
        autoClose: false,
      });
      resumeContext();
    }
    audio.play();
  }

  /** Load `clip.samples` into the audio object, playhead at `position`. */
  function loadClip(position: number) {
    if (audio.isPlaying) audio.stop();
    const buffer = makeBuffer();
    internals.buffer = buffer;
    if (buffer === null) return;
    internals._progress = Math.min(position, buffer.duration);
    startIfRequested();
  }

  function play(offset: number | null) {
    clip.playRequested = true;
    const buffer = audio.buffer;
    if (buffer === null) return;
    if (offset !== null) {
      if (audio.isPlaying) audio.pause();
      internals._progress = Math.min(Math.max(offset, 0.0), buffer.duration);
    } else if (!audio.isPlaying && internals._progress >= buffer.duration) {
      internals._progress = 0.0;
    }
    startIfRequested();
  }

  function pause() {
    clip.playRequested = false;
    if (audio.isPlaying) audio.pause();
  }

  function append(chunk: Float32Array) {
    if (chunk.length === 0) return;
    const samples = new Float32Array(clip.samples.length + chunk.length);
    samples.set(clip.samples);
    samples.set(chunk, clip.samples.length);
    clip.samples = samples;
    const buffer = makeBuffer()!;

    if (!audio.isPlaying) {
      audio.setBuffer(buffer);
      startIfRequested();
      return;
    }
    // Stop the running source and start one for the longer buffer at the
    // same future context time, with a matching offset, so the crossover is
    // sample-accurate rather than an audible stop-and-restart.
    const swapTime = audio.context.currentTime + APPEND_SWAP_LEAD_SECONDS;
    const position = (playhead() + APPEND_SWAP_LEAD_SECONDS) % buffer.duration;
    internals.source!.onended = null;
    internals.source!.stop(swapTime);
    // three's play() refuses to run while `isPlaying`; the old source is
    // already scheduled to stop.
    internals.isPlaying = false;
    audio.setBuffer(buffer);
    internals._progress = position;
    audio.play(APPEND_SWAP_LEAD_SECONDS);
  }

  React.useEffect(() => {
    camera.add(getListener());
  }, [camera]);

  // Replacing the samples (or their layout) restarts the clip from the start.
  // A swapped-in audio object (`positional` toggled) resumes where the
  // previous one left off.
  React.useEffect(() => {
    const loaded = clip.loaded;
    if (
      loaded.samples !== props._samples ||
      loaded.numChannels !== props._num_channels ||
      loaded.sampleRate !== props.sample_rate
    ) {
      clip.loaded = {
        samples: props._samples,
        numChannels: props._num_channels,
        sampleRate: props.sample_rate,
      };
      clip.samples = props._samples;
      clip.resumePosition = 0.0;
    }
    loadClip(clip.resumePosition);
  }, [audio, props._samples, props._num_channels, props.sample_rate]);

  React.useEffect(() => {
    audio.setVolume(displayed ? props.volume : 0.0);
  }, [audio, props.volume, displayed]);

  React.useEffect(() => {
    audio.setLoop(props.loop);
  }, [audio, props.loop]);

  React.useEffect(() => {
    return () => {
      clip.resumePosition = playhead();
      if (audio.isPlaying) audio.stop();
      audio.disconnect();
    };
  }, [audio]);

  React.useEffect(() => {
    return () => {
      delete viewer.mutable.current.audioCommands[commandKey];
    };
  }, [viewer, commandKey]);

  // Commands are parked by the message handler because this component does
  // not exist yet when they arrive in the same batch as the create message.
  useFrame(() => {
    const commands = viewer.mutable.current.audioCommands[commandKey];
    if (commands === undefined) return;
    for (const command of commands.splice(0)) {
      if (command.type === "append") append(command.samples);
      else if (command.type === "play") play(command.offset);
      else pause();
    }
  });

  return (
    <group ref={ref}>
      <primitive object={audio} />
      {children}
    </group>
  );
});
