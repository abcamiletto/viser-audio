// Public recording protocol, mirroring viser_audio.messages.
// Live viser decoding produces Float32Array; recordings may contain byte views.
export type Samples = Float32Array | Uint8Array | ArrayBuffer;

export interface AudioAddMessage {
  type: "AudioAddMessage";
  name: string;
  sample_rate: number;
  num_channels: number;
  samples: Samples;
  volume: number;
  loop: boolean;
  positional: boolean;
  playback_rate: number;
  start_time: number | null;
}

export interface AudioUpdateMessage {
  type: "AudioUpdateMessage";
  name: string;
  updates: {
    volume?: number;
    loop?: boolean;
    positional?: boolean;
    playback_rate?: number;
  };
}

export interface AudioSamplesMessage {
  type: "AudioSamplesMessage";
  name: string;
  samples: Samples;
  num_channels: number;
}

export interface AudioAppendMessage {
  type: "AudioAppendMessage";
  name: string;
  samples: Samples;
}

export interface AudioPlaybackMessage {
  type: "AudioPlaybackMessage";
  name: string;
  playing: boolean;
  offset: number;
}

export interface AudioRemoveMessage {
  type: "AudioRemoveMessage";
  name: string;
}

export type AudioMessage =
  | AudioAddMessage
  | AudioUpdateMessage
  | AudioSamplesMessage
  | AudioAppendMessage
  | AudioPlaybackMessage
  | AudioRemoveMessage;

const MESSAGE_TYPES = new Set([
  "AudioAddMessage",
  "AudioUpdateMessage",
  "AudioSamplesMessage",
  "AudioAppendMessage",
  "AudioPlaybackMessage",
  "AudioRemoveMessage",
]);

export function isAudioMessage(message: { type: string }): message is AudioMessage {
  return MESSAGE_TYPES.has(message.type);
}
