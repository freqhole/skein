/**
 * test bootstrap for the hub profile panel's e2e tests.
 *
 * loaded by test-harness-hub-profile.html. this panel
 * (`widgets/narthex/social/hub-profile-panel.ts`) isn't wired into the
 * real app's narthex/friend-detail view yet (see
 * docs/hub-and-profile-plan.md section 5's phased order — that wiring is a
 * separate, later step), so it has no production mount point to test
 * through. this bootstrap gives it a minimal, dedicated one: just a pixi
 * `Application` + a real `IrohNetworkAdapter` (via `createSkeinHarness`,
 * skipping the canvas store entirely — this panel talks to a hub over
 * `iroh/skein-hub-admin/1`, not to any automerge canvas doc), mirroring
 * how `p2p-test-bootstrap.ts` gives the full narthex canvas a real iroh
 * transport for its own e2e tests.
 *
 * usage from playwright:
 *   await page.goto("/test-harness-hub-profile.html");
 *   await page.waitForFunction(() => typeof window.__hubProfileTest === "object");
 *   const nodeId = await page.evaluate(() => window.__hubProfileTest.getNodeId());
 *   await page.evaluate(() => window.__hubProfileTest.waitForOnline());
 *   await page.evaluate((hubNodeId) => window.__hubProfileTest.mountPanel(hubNodeId), hubNodeId);
 *   const state = await page.evaluate(() => window.__hubProfileTest.getPanelState());
 */

import { Application } from "pixi.js";
import {
  createHubAdminClient,
  hubAdminTransportFromAdapter,
  type HubAdminClient,
  type HubAdminResponse,
} from "../p2p/hub-admin-client";
import { createSkeinHarness } from "../harness/skein-harness";
import {
  mountHubProfilePanel,
  type HubProfilePanelHandle,
  type HubProfilePanelState,
} from "../../widgets/narthex/social/hub-profile-panel";

export interface HubProfileTestBridge {
  /** this instance's iroh node ID (async — may need to wait for midden to init). */
  getNodeId(): Promise<string>;
  /** resolve once the iroh endpoint reaches "online", or reject after timeoutMs. */
  waitForOnline(timeoutMs?: number): Promise<void>;
  /** mount (or remount, tearing down any previous instance) the panel for the given hub node id. */
  mountPanel(hubNodeId: string): void;
  /** re-fetch friendz + pending knocks from the currently-mounted panel's hub. */
  refreshPanel(): Promise<void>;
  /** current render state of the mounted panel — see `HubProfilePanelState`. */
  getPanelState(): HubProfilePanelState;
  /** tear down the currently-mounted panel, if any. */
  destroyPanel(): void;
  /**
   * the same `HubAdminClient` instance the mounted panel uses internally —
   * exposed directly so tests can drive real hub-admin-client calls (the
   * exact production wire path the panel's "allow"/"remove" actions use)
   * without needing to simulate pixi pointer clicks on canvas coordinates,
   * which this repo has no existing e2e precedent for.
   */
  client: HubAdminClient | null;
}

let app: Application | null = null;
let panelHandle: HubProfilePanelHandle | null = null;
let client: HubAdminClient | null = null;

async function initHubProfileTest(): Promise<{ nodeId: string }> {
  const harness = await createSkeinHarness({
    network: "iroh",
    ephemeralStorage: true,
    skipStore: true,
  });
  const adapter = harness.iroh!;

  app = new Application();
  await app.init({
    resizeTo: document.getElementById("canvas-root")!,
    background: 0x1a1a24,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.getElementById("canvas-root")!.appendChild(app.canvas);

  client = createHubAdminClient(hubAdminTransportFromAdapter(adapter));

  const bridge: HubProfileTestBridge = {
    async getNodeId(): Promise<string> {
      const node = await adapter.getNode();
      return node.node_id();
    },
    async waitForOnline(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (adapter.getEndpointState() !== "online") {
        if (Date.now() > deadline) {
          throw new Error(
            `iroh endpoint did not reach "online" within ${timeoutMs}ms (state: "${adapter.getEndpointState()}")`
          );
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    },
    mountPanel(hubNodeId: string): void {
      if (panelHandle) {
        panelHandle.destroy();
        panelHandle = null;
      }
      panelHandle = mountHubProfilePanel(app!.stage, {
        hubNodeId,
        client: client!,
        canvasElement: app!.canvas as HTMLCanvasElement,
      });
      panelHandle.layout(app!.screen.width, app!.screen.height);
    },
    async refreshPanel(): Promise<void> {
      await panelHandle?.refresh();
    },
    getPanelState(): HubProfilePanelState {
      if (!panelHandle) return { status: "loading" };
      return panelHandle.getState();
    },
    destroyPanel(): void {
      panelHandle?.destroy();
      panelHandle = null;
    },
    client,
  };

  (window as any).__hubProfileTest = bridge;

  const nodeId = await bridge.getNodeId();
  return { nodeId };
}

(window as any).__initHubProfileTest = initHubProfileTest;

// re-exported so playwright test code (running under node, not this page's
// module graph) can still get a type for `client.hubAdminAllow(...)`-style
// calls done via `page.evaluate` without importing this bootstrap file.
export type { HubAdminResponse };
