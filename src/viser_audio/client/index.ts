// Bootstrap: dispose any prior instance, install the runtime, and expose a
// small handle on window.__VISER_AUDIO__. A page can outlive a websocket
// session, and every (re)connect replays the injected bundle, so each run
// installs a fresh runtime tied to the current connection.

import { AudioEngine } from "./audio";
import type { ClipDebugState } from "./audio";
import { isAudioMessage } from "./protocol";
import { Viser } from "./viser";
import type { QueueMessage } from "./viser";

class Runtime {
  private readonly viser: Viser;
  private readonly engine: AudioEngine;

  constructor() {
    this.viser = new Viser((message) => this.route(message));
    this.engine = new AudioEngine(this.viser);
    this.viser.install();
  }

  debug(): ClipDebugState[] {
    return this.engine.debug();
  }

  dispose(): void {
    this.viser.dispose();
    this.engine.dispose();
  }

  private route(message: QueueMessage): boolean {
    // Recordings and embedded scenes replay messages without a server; there
    // is nothing for us to drive there, so let viser see everything.
    if (!this.viser.isWebsocket || !isAudioMessage(message)) return false;
    this.engine.handle(message);
    return true;
  }
}

type RuntimeHandle = { dispose(): void; debug(): ClipDebugState[] };
const win = window as Window & { __VISER_AUDIO__?: RuntimeHandle };
win.__VISER_AUDIO__?.dispose();
win.__VISER_AUDIO__ = new Runtime();
