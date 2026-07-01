import type { SkeinCanvas } from "../canvas/init";
import type { EndpointState, IrohNetworkAdapter } from "../p2p/iroh-network-adapter";

/**
 * p2p test bridge — methods only available when the page was bootstrapped
 * with a real IrohNetworkAdapter (test-harness-p2p.html).
 */
export interface SkeinP2PBridge {
  /** this instance's iroh node ID (async — may need to wait for midden to init) */
  getNodeId(): Promise<string>;
  /** dial a peer by node ID and keep the connection alive */
  addPeer(nodeId: string): Promise<void>;
  /** read the current endpoint lifecycle state synchronously */
  getEndpointState(): EndpointState;
  /**
   * resolve once the endpoint reaches "online", or reject after timeoutMs.
   * default timeout: 30 000 ms.
   */
  waitForOnline(timeoutMs?: number): Promise<void>;
}

/**
 * social test bridge — present on `window.__skeinTest.social` when the full
 * boot router has initialised (i.e. the page loaded index.html, not a test
 * harness page). populated in DEV builds only.
 */
export interface SkeinTestBridgeSocial {
  /** the live standalone social doc (profile, friends, requests, etc.) */
  readonly doc: { current: Record<string, unknown> } | null;
  /** generate or restore a P2P identity. mirrors identity.ts ensureIdentity(). */
  ensureIdentity(): Promise<{ node_id: string }>;
  /** open / close the social overlay panel */
  toggleOverlay(): void;
  /** trigger the avatar file picker (set by profile-tab on mount) */
  pickAvatar?(): Promise<void>;
}

/**
 * the single window-level test bridge placed on `window.__skeinTest`.
 *
 * consolidates all test-time APIs into one typed, documented object — no more
 * scattered `window.__*` hooks spread across source files.
 *
 * populated in dev mode only; never present in production builds.
 */
export interface SkeinTestBridge {
  /** the running skein canvas instance */
  canvas: SkeinCanvas;
  /**
   * social helpers — present when the full boot router is running (index.html).
   * null when using test harness pages (test-harness.html etc.).
   */
  social?: SkeinTestBridgeSocial;
  /**
   * p2p helpers — present only when the page was bootstrapped via
   * test-harness-p2p.html / p2p-test-bootstrap.ts.
   * null for ordinary BroadcastChannel-only test pages.
   */
  p2p: SkeinP2PBridge | null;
}

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

/**
 * build a SkeinP2PBridge from a live IrohNetworkAdapter.
 * call this from test bootstrap code after creating the adapter.
 */
export function buildP2PBridge(adapter: IrohNetworkAdapter): SkeinP2PBridge {
  return {
    async getNodeId(): Promise<string> {
      const node = await adapter.getNode();
      return node.node_id();
    },

    addPeer(nodeId: string): Promise<void> {
      return adapter.addPeer(nodeId);
    },

    getEndpointState(): EndpointState {
      return adapter.getEndpointState();
    },

    async waitForOnline(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (adapter.getEndpointState() !== "online") {
        if (Date.now() > deadline) {
          const state = adapter.getEndpointState();
          throw new Error(
            `iroh endpoint did not reach "online" within ${timeoutMs}ms (state: "${state}")`
          );
        }
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    },
  };
}
