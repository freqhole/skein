// unit tests for presence-renderer.ts's pure resolveCursorColor() helper.
//
// presence-renderer.ts had zero test coverage anywhere in the repo before
// this file (confirmed via search) — the rest of it is pixi rendering,
// which has no test infrastructure/precedent here (see share-dialog.test.ts's
// module doc comment for the same reasoning). resolveCursorColor() is the
// one piece of pure, testable logic: it decides whether a peer's cursor
// uses their real profile accent color (once resolved via a colorResolver)
// or falls back to the presence manager's palette-assigned color.

import { describe, expect, it } from "vitest";
import { resolveCursorColor } from "./presence-renderer";

describe("resolveCursorColor", () => {
  it("falls back to the palette color when no resolver is set", () => {
    expect(resolveCursorColor("peer-a", 0x22c55e, null)).toBe(0x22c55e);
  });

  it("falls back to the palette color when the resolver doesn't know the peer yet", () => {
    const resolver = () => null;
    expect(resolveCursorColor("peer-a", 0x22c55e, resolver)).toBe(0x22c55e);
  });

  it("uses the resolved profile accent color when available", () => {
    const resolver = (peerId: string) => (peerId === "peer-a" ? 0xff00ff : null);
    expect(resolveCursorColor("peer-a", 0x22c55e, resolver)).toBe(0xff00ff);
  });

  it("only resolves the requested peer, not others", () => {
    const resolver = (peerId: string) => (peerId === "peer-a" ? 0xff00ff : null);
    expect(resolveCursorColor("peer-b", 0x22c55e, resolver)).toBe(0x22c55e);
  });
});
