import type { Page } from "@playwright/test";

/**
 * establish a non-viewer local role on the currently-open canvas — canvases
 * with no `.acl` entry for the local peer default to `"viewer"` (read-only,
 * see canvas-store.ts's `getRole()` doc comment), so tests exercising
 * editing UI need to grant themselves a role explicitly before driving it.
 */
export async function setLocalRole(page: Page, role: "member" | "viewer"): Promise<void> {
  await page.evaluate((r) => {
    const store = (window as any).__skein.store;
    const nodeId = "test-local-peer";
    store.setRole(nodeId, r);
    store.setLocalNodeId(nodeId);
  }, role);
  // give the toolbar's store.onChange()-driven applyRoleGating() a tick to run
  await page.waitForTimeout(100);
}
