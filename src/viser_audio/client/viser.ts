// The only module that touches the viser frontend. The React fiber walk, the
// message-queue seam and the scene/camera lookups live here, and this is the
// only place `any` is permitted (the viewer is untyped from out here).

/* eslint-disable @typescript-eslint/no-explicit-any */

export type QueueMessage = { type: string; [key: string]: unknown };

/** Returns true if the runtime consumed the message (viser must not see it). */
export type InboundHandler = (message: QueueMessage) => boolean;

/** A THREE.Matrix4, reduced to what we read from it. */
export type MatrixElements = ArrayLike<number>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isViewer(value: unknown): value is Record<string, any> {
  return (
    isRecord(value) &&
    isRecord(value.mutable) &&
    "useGuiConfig" in value &&
    "guiActions" in value &&
    "useSceneTree" in value
  );
}

function reactRoot(): Record<string, any> | null {
  const root = document.getElementById("root") as unknown;
  if (!isRecord(root)) return null;
  const key = Object.keys(root).find((name) =>
    name.startsWith("__reactContainer$"),
  );
  const container = key ? root[key] : null;
  return isRecord(container) ? (container as Record<string, any>) : null;
}

function findViewer(): Record<string, any> | null {
  const start = reactRoot();
  if (!start) return null;
  const seen = new Set<unknown>();
  const stack: Record<string, any>[] = [start];
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

const RETRY_BUDGET_MS = 5000;

export class Viser {
  private viewer: Record<string, any> | null = null;
  private queue: QueueMessage[] | null = null;
  private originalPush: ((...messages: QueueMessage[]) => number) | null = null;
  private wrappedPush: ((...messages: QueueMessage[]) => number) | null = null;
  private disposed = false;
  private deadline = 0;

  constructor(private readonly onMessage: InboundHandler) {}

  install(): void {
    this.deadline = performance.now() + RETRY_BUDGET_MS;
    this.tryInstall();
  }

  dispose(): void {
    this.disposed = true;
    if (this.queue && this.originalPush && this.queue.push === this.wrappedPush) {
      this.queue.push = this.originalPush;
    }
    this.viewer = null;
    this.queue = null;
    this.originalPush = null;
    this.wrappedPush = null;
  }

  get messageSource(): string | undefined {
    return this.viewer?.messageSource;
  }

  /** Recordings and embeds replay a scene without a server; audio is inert. */
  get isWebsocket(): boolean {
    return this.messageSource === "websocket";
  }

  /** Push a message into viser, bypassing our own interception. */
  pushToViser(message: QueueMessage): void {
    this.originalPush?.(message);
  }

  /** World matrix of a scene node, or null if it hasn't mounted yet. */
  nodeMatrix(name: string): MatrixElements | null {
    const node = this.viewer?.mutable.current.nodeRefFromName[name];
    return node ? node.matrixWorld.elements : null;
  }

  /** World matrix of the viewer camera. */
  cameraMatrix(): MatrixElements | null {
    const camera = this.viewer?.mutable.current.camera;
    return camera ? camera.matrixWorld.elements : null;
  }

  private tryInstall(): void {
    if (this.disposed || this.originalPush) return;
    const viewer = findViewer();
    if (viewer) {
      this.viewer = viewer;
      this.wrapQueue(viewer);
      return;
    }
    if (performance.now() >= this.deadline) {
      console.error(
        "[viser-audio] Could not locate the viewer in the React fiber tree " +
          "after 5s of retries; audio is inactive.",
      );
      return;
    }
    requestAnimationFrame(() => this.tryInstall());
  }

  private wrapQueue(viewer: Record<string, any>): void {
    const queue = viewer.mutable.current.messageQueue as QueueMessage[];
    const original = queue.push.bind(queue) as (
      ...m: QueueMessage[]
    ) => number;
    const wrapped = (...messages: QueueMessage[]): number => {
      const forwarded: QueueMessage[] = [];
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
  private recoverCurrentBatch(): void {
    const original = console.log;
    const wrapped = (...args: unknown[]) => {
      const message = args[1];
      if (
        isRecord(message) &&
        typeof message.type === "string" &&
        this.onMessage(message as QueueMessage)
      ) {
        return;
      }
      original.apply(console, args);
    };
    console.log = wrapped;
    // Runs once the synchronous batch loop is done.
    queueMicrotask(() => {
      if (console.log === wrapped) console.log = original;
    });
  }
}
