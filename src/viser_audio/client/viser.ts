// Viser has no public camera/node lookup. Keep React discovery confined here;
// audio delivery uses RunJavascriptMessage without patching the message queue.
import type { AudioHost, MatrixElements } from "./audio";

type SceneObject = { matrixWorld: { elements: MatrixElements } };
type Viewer = {
  mutable: {
    current: {
      nodeRefFromName: Record<string, SceneObject | undefined>;
      camera: SceneObject | null;
    };
  };
};
type Fiber = {
  memoizedProps?: { value?: unknown };
  child?: Fiber;
  sibling?: Fiber;
};

export class Viser implements AudioHost {
  private viewer: Viewer | null = null;

  nodeMatrix(name: string): MatrixElements | null {
    const node = this.getViewer().mutable.current.nodeRefFromName[name];
    return node ? node.matrixWorld.elements : null;
  }

  cameraMatrix(): MatrixElements | null {
    const camera = this.getViewer().mutable.current.camera;
    return camera ? camera.matrixWorld.elements : null;
  }

  private getViewer(): Viewer {
    this.viewer ??= findViewer();
    if (!this.viewer) throw new Error("[viser-audio] Could not locate the viser viewer.");
    return this.viewer;
  }
}

function findViewer(): Viewer | null {
  const root: unknown = document.getElementById("root");
  if (!isRecord(root)) return null;
  const key = Object.keys(root).find((name) => name.startsWith("__reactContainer$"));
  const container = key ? root[key] : null;
  if (!isRecord(container)) return null;
  const seen = new Set<Fiber>();
  const stack: Fiber[] = [container];
  while (stack.length) {
    const fiber = stack.pop()!;
    if (seen.has(fiber)) continue;
    seen.add(fiber);
    const value = fiber.memoizedProps?.value;
    if (isViewer(value)) return value;
    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }
  return null;
}

function isViewer(value: unknown): value is Viewer {
  if (!isRecord(value) || !isRecord(value.mutable)) return false;
  const current = value.mutable.current;
  return isRecord(current) && "nodeRefFromName" in current && "camera" in current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
