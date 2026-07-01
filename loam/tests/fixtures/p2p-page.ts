import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

interface P2PTestHandle {
  page: Page;
  context: BrowserContext;
  canvasDocId: string;
  /** this peer's iroh node ID — ready immediately after factory resolves */
  nodeId: string;
  close: () => Promise<void>;
}

type P2PPageFactory = (options?: {
  canvasDocId?: string;
  /** share an existing context (e.g. to keep BroadcastChannel working
   *  between browser tabs alongside real iroh) */
  context?: BrowserContext;
}) => Promise<P2PTestHandle>;

/**
 * playwright fixture that creates browser pages with real iroh P2P networking.
 *
 * loads test-harness-p2p.html which bootstraps IrohNetworkAdapter and waits
 * for the endpoint to reach "online" before returning the handle.
 *
 * usage:
 *   const peerA = await p2pPage();
 *   const peerB = await p2pPage();
 *   await addPeer(peerA.page, peerB.nodeId); // dial B from A
 *   await addPeer(peerB.page, peerA.nodeId); // dial A from B (bidirectional)
 *
 * for tests that open the same canvas on both peers:
 *   const peerB = await p2pPage({ canvasDocId: peerA.canvasDocId });
 */
export const test = base.extend<{
  p2pPage: P2PPageFactory;
}>({
  p2pPage: async ({ browser }, use) => {
    const handles: P2PTestHandle[] = [];
    const ownedContexts = new Set<BrowserContext>();

    const factory: P2PPageFactory = async (options) => {
      const isSharedContext = !!options?.context;
      const context = options?.context ?? (await browser.newContext());
      if (!isSharedContext) {
        ownedContexts.add(context);
      }

      const page = await context.newPage();
      await page.goto("/test-harness-p2p.html");

      // wait for the p2p bootstrap module to load and expose the init function
      await page.waitForFunction(
        () => typeof (window as any).__initSkeinP2PForTest === "function",
        { timeout: 15_000 }
      );

      // initialize — this calls ensureIdentity(), creates the Repo + IrohAdapter,
      // and waits up to 15s for the iroh endpoint to come online.
      const initOpts = { canvasDocId: options?.canvasDocId ?? null };
      const result = await page.evaluate(async (opts) => {
        return (window as any).__initSkeinP2PForTest({
          canvasDocId: opts?.canvasDocId ?? null,
        });
      }, initOpts);

      const handle: P2PTestHandle = {
        page,
        context,
        canvasDocId: result.canvasDocId,
        nodeId: result.nodeId,
        close: async () => {
          await page.close().catch(() => {});
        },
      };

      handles.push(handle);
      return handle;
    };

    await use(factory);

    for (const handle of handles) {
      await handle.close().catch(() => {});
    }
    for (const ctx of ownedContexts) {
      await ctx.close().catch(() => {});
    }
  },
});

export { expect };
