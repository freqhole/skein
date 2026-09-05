/**
 * a small, generic DOM right-click context menu — fixed-position, themed,
 * dismissed on an outside click, Escape, or after an item is chosen. only
 * one menu is ever open at a time (a new call replaces any existing one).
 */

import type { SkeinTheme } from "../theme/skein-theme";

/** above share-dialog.ts's DOM_Z ("10003") so a context menu always wins. */
const CONTEXT_MENU_Z = "10010";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

let active: { el: HTMLElement; cleanup: () => void } | null = null;

/** close the currently open context menu, if any. safe to call when none is open. */
export function dismissContextMenu(): void {
  if (!active) return;
  active.cleanup();
  active.el.remove();
  active = null;
}

/** open a context menu at the given screen (`clientX`/`clientY`) position.
 *  a no-op if `items` is empty. */
export function showContextMenu(clientX: number, clientY: number, items: ContextMenuItem[], theme: SkeinTheme): void {
  dismissContextMenu();
  if (items.length === 0) return;

  const menu = document.createElement("div");
  const s = menu.style;
  s.position = "fixed";
  s.left = `${clientX}px`;
  s.top = `${clientY}px`;
  s.minWidth = "140px";
  s.background = hex(theme.frameHeaderBg);
  s.border = `1px solid ${hex(theme.frameBorder)}`;
  s.borderRadius = `${theme.frameCornerRadius}px`;
  s.padding = "4px";
  s.fontFamily = theme.fontFamily;
  s.fontSize = `${theme.fontSizeSmall}px`;
  s.boxShadow = "0 4px 16px rgba(0, 0, 0, 0.5)";
  s.zIndex = CONTEXT_MENU_Z;

  for (const item of items) {
    const row = document.createElement("div");
    row.textContent = item.label;
    const rs = row.style;
    rs.padding = "6px 10px";
    rs.borderRadius = `${Math.max(2, theme.frameCornerRadius - 2)}px`;
    rs.color = hex(theme.frameHeaderText);
    rs.cursor = "default";
    rs.userSelect = "none";
    row.addEventListener("mouseenter", () => {
      rs.background = `${hex(theme.accent)}33`;
    });
    row.addEventListener("mouseleave", () => {
      rs.background = "transparent";
    });
    row.addEventListener("mousedown", (e) => e.stopPropagation());
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      dismissContextMenu();
      item.onSelect();
    });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // keep the menu on-screen if it would otherwise overflow the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) s.left = `${Math.max(0, window.innerWidth - rect.width)}px`;
  if (rect.bottom > window.innerHeight) s.top = `${Math.max(0, window.innerHeight - rect.height)}px`;

  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) dismissContextMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") dismissContextMenu();
  };
  // deferred so the same right-click that opened the menu doesn't also
  // immediately close it via this listener.
  queueMicrotask(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });

  active = {
    el: menu,
    cleanup: () => {
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    },
  };
}
