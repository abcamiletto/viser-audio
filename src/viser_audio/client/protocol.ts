// Wire messages, mirroring src/viser_audio/_messages.py. Numpy float32 arrays
// arrive as Float32Array views (viser's binary message decoder).

export interface AudioAddMessage {
  type: "AudioAddMessage";
  name: string;
  sample_rate: number;
  num_channels: number;
  samples: Float32Array;
  volume: number;
  loop: boolean;
  positional: boolean;
}

export interface AudioUpdateMessage {
  type: "AudioUpdateMessage";
  name: string;
  updates: {
    samples?: Float32Array;
    num_channels?: number;
    volume?: number;
    loop?: boolean;
    positional?: boolean;
  };
}

export interface AudioAppendMessage {
  type: "AudioAppendMessage";
  name: string;
  samples: Float32Array;
}

export interface AudioPlaybackMessage {
  type: "AudioPlaybackMessage";
  name: string;
  playing: boolean;
  offset: number | null;
}

export interface AudioRemoveMessage {
  type: "AudioRemoveMessage";
  name: string;
}

export type AudioMessage =
  | AudioAddMessage
  | AudioUpdateMessage
  | AudioAppendMessage
  | AudioPlaybackMessage
  | AudioRemoveMessage;

export function isAudioMessage(message: {
  type: string;
}): message is AudioMessage {
  return message.type.startsWith("Audio");
}
