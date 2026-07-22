import { z } from "zod";
import { createTestRegistry } from "../../widgets/index";
import type { SkeinCanvas } from "../canvas/init";
import type { SkeinTestBridge } from "./test-bridge";
import { initCanvas } from "../canvas/init";
import { createSkeinHarness } from "../harness/skein-harness";
import { PresenceManager } from "../canvas/presence-manager";
import { Viewport } from "../canvas/viewport";
import { createWidgetDoc } from "../widgets/widget-doc";
import { getBlobWorker, processBlobBytes, streamFileToOpfs } from "@freqhole/reliquary/worker";

/**
 * a simple zod schema used by playwright tests to exercise createWidgetDoc.
 * not tied to any real widget — just needs defaults so .parse({}) works.
 */
const testWidgetSchema = z.object({
  count: z.number().default(0),
  step: z.number().default(1),
  label: z.string().default("test"),
});

interface TestInitOptions {
  canvasDocId?: string | null;
}

interface TestInitResult {
  canvasDocId: string;
}

/**
 * initialize a skein canvas for playwright tests.
 * this module is loaded by test-harness.html via a <script type="module"> tag,
 * so vite resolves all bare package specifiers properly.
 *
 * exposes window.__initSkeinForTest(options) for the playwright fixture to call
 * via page.evaluate(), and window.__skein for test assertions.
 */
async function initSkeinForTest(options: TestInitOptions = {}): Promise<TestInitResult> {
  // build the repo + canvas doc via the harness instead of hand-rolling a
  // BroadcastChannelNetworkAdapter + Repo here.
  const isNewCanvas = !options.canvasDocId;
  const harness = await createSkeinHarness({ canvasDocId: options.canvasDocId ?? null });

  const canvas: SkeinCanvas = await initCanvas({
    mountElement: document.getElementById("canvas-root")!,
    canvasDocId: harness.store.handle.documentId,
    registry: createTestRegistry(),
    repo: harness.repo,
  });

  // stamp the local peer's node id (and, for a freshly created canvas, admin
  // role) the same way boot.ts does after initCanvas() — the toolbar/widget
  // manager gate widget mutation on `store.isLocalViewer()`, which defaults
  // to true until a node id is set, so skipping this leaves every test
  // using this bootstrap permanently in read-only/viewer mode.
  canvas.store.setLocalNodeId(harness.repo.peerId);
  if (isNewCanvas) {
    canvas.store.stampAdmin(harness.repo.peerId);
  }
  canvas.toolbar.refreshRoleGating();

  (window as any).__skein = canvas;
  (window as any).__skeinTest = { canvas, p2p: null } satisfies SkeinTestBridge;

  return {
    canvasDocId: canvas.store.handle.documentId,
  };
}

// expose on window for playwright's page.evaluate() to call
(window as any).__initSkeinForTest = initSkeinForTest;

// expose internals for detailed playwright tests
(window as any).__skeinHelpers = {
  createWidgetDoc,
  testWidgetSchema,
  Viewport,
  PresenceManager,
  // blob worker — exposed so tests can exercise the real worker path
  // (blake3 hash + OPFS write) directly, without going through a widget's
  // file-picker UI.
  getBlobWorker,
  processBlobBytes,
  streamFileToOpfs,
};
