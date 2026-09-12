// The live viser adapter and standalone engine share the same public protocol.
import { AudioEngine } from "./audio";
import { isAudioMessage } from "./protocol";
import { Viser } from "./viser";

class Runtime {
  readonly AudioEngine = AudioEngine;
  readonly engine: AudioEngine;
  private readonly viser: Viser;

  constructor() {
    this.viser = new Viser();
    this.engine = new AudioEngine(this.viser);
  }

  receive(payload: string): void {
    const message = JSON.parse(payload, (_key, value) => {
      if (value && typeof value === "object" && "__audio_samples" in value) {
        const binary = atob(value.__audio_samples);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new Float32Array(bytes.buffer);
      }
      return value;
    });
    if (!isAudioMessage(message)) throw new Error(`Unknown audio message: ${message.type}`);
    this.engine.handle(message);
  }

  debug() {
    return this.engine.debug();
  }

  dispose(): void {
    this.engine.dispose();
  }
}

const win = window as Window & { __VISER_AUDIO__?: Runtime };
win.__VISER_AUDIO__?.dispose();
win.__VISER_AUDIO__ = new Runtime();
