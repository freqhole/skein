/**
 * module-level singleton that bridges the iroh adapter to any UI component
 * that needs to read or toggle the P2P endpoint state without holding a
 * direct reference to the adapter.
 *
 * boot.ts calls registerEndpointAdapter() once at startup.
 * settings-tab.ts (and any other UI) imports the helpers to read / toggle.
 */
import type { EndpointState, IrohNetworkAdapter } from "./iroh-network-adapter";

export type { EndpointState };

let _adapter: IrohNetworkAdapter | null = null;

/** register the adapter — called once by boot.ts after adapter creation */
export function registerEndpointAdapter(adapter: IrohNetworkAdapter): void {
  _adapter = adapter;
}

/** stop the iroh P2P endpoint; can be resumed with restartEndpoint() */
export function stopEndpoint(): void {
  _adapter?.stop();
}

/** restart the iroh P2P endpoint after it was stopped */
export function restartEndpoint(): Promise<void> {
  return _adapter?.restart() ?? Promise.resolve();
}

/** get the current endpoint state synchronously */
export function getEndpointState(): EndpointState {
  return _adapter?.getEndpointState() ?? "off";
}

/** subscribe to endpoint state changes; returns an unsubscribe function */
export function onEndpointStateChange(handler: (state: EndpointState) => void): () => void {
  return _adapter?.onEndpointStateChange(handler) ?? (() => {});
}
