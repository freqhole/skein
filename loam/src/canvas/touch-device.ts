/**
 * returns true if the primary input is a touch/stylus with no fine pointer.
 *
 * uses CSS media queries rather than UA sniffing or maxTouchPoints:
 *   (hover: none)     — device cannot hover (no mouse)
 *   (pointer: coarse) — primary pointer is coarse (finger / stylus)
 *
 * this correctly handles hybrid devices:
 *   - iPhone/iPad/Android → true
 *   - MacBook trackpad    → false  (hover: hover, pointer: fine)
 *   - Surface tablet mode → true
 *   - Surface with keyboard+trackpad → false
 */
export function isTouchDevice(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
