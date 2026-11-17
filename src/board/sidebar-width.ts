// The left sidebar's width, owned by this plugin so it can grow past bb's
// 460 px cap: wider than that, the sidebar shows the board.
//
// bb sizes the sidebar with an inline `--sidebar-width` on two elements and
// clamps its own drag handle to 240–460 px. Since 0.49 it also writes that
// width as a literal px value (`width: calc(320px - <rail>)`) on the wrappers
// inside each `collapsible-body`, so the variable alone no longer widens the
// content. While the thread list is mounted, this module takes that handle's
// drag (capture-phase listener, so bb's never starts) and overrides the
// variable and those wrapper widths with !important rules, scoped to bb's
// `md` breakpoint so the phone drawer keeps bb's own width. Unmounting removes
// the rules and bb's own width applies again. If bb renames the handle or the
// elements, nothing here matches and bb's behaviour is untouched.
import { useEffect, useSyncExternalStore } from "react";
import { STORAGE_KEYS } from "../lib/storage-keys";
import { readStorageRaw } from "../lib/storage-codec";
import { safeSetItem } from "../lib/safe-storage";

const MIN_WIDTH = 240;
/** bb's own cap; anything wider is board mode. */
const LIST_MAX_WIDTH = 460;
const DEFAULT_LIST_WIDTH = 320;
/** Room always left for the chat beside the sidebar. */
const MAIN_MIN_WIDTH = 280;
/** Below bb's `md` breakpoint the sidebar is a drawer with its own width. */
const DESKTOP_MIN_VIEWPORT = 768;

/** bb's own saved width, read once to seed ours. */
const CORE_STORAGE_KEY = "bb.sidebar.width";
const HANDLE_SELECTOR = '[data-testid="app-sidebar-resize-handle"]';
const STYLE_ID = "bb-sidebar-width-override";
const WIDTH_VARIABLE = "--bbs-sidebar-width";

interface SidebarWidthState {
  width: number;
  /** Width to return to when leaving the board. */
  listWidth: number;
  /** Width to return to when reopening the board; null until first opened. */
  boardWidth: number | null;
}

export function clampWidth(width: number, viewportWidth: number): number {
  const max = Math.max(MIN_WIDTH, viewportWidth - MAIN_MIN_WIDTH);
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

function parseWidth(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= MIN_WIDTH ? value : null;
}

/** Starting state: our own saved state, else bb's saved width, else bb's default. */
export function seedState(saved: string | null, coreWidth: string | null): SidebarWidthState {
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (parsed && typeof parsed === "object" && "width" in parsed && "listWidth" in parsed) {
        const width = parseWidth(String(parsed.width));
        const listWidth = parseWidth(String(parsed.listWidth));
        const boardWidth = "boardWidth" in parsed ? parseWidth(String(parsed.boardWidth)) : null;
        if (width !== null && listWidth !== null && listWidth <= LIST_MAX_WIDTH) {
          return { width, listWidth, boardWidth };
        }
      }
    } catch {
      // Unreadable state falls through to bb's width.
    }
  }
  const core = parseWidth(coreWidth);
  const listWidth = core !== null && core <= LIST_MAX_WIDTH ? core : DEFAULT_LIST_WIDTH;
  return { width: listWidth, listWidth, boardWidth: null };
}

/** A new width, remembering it as the list or board width it belongs to. */
export function withWidth(state: SidebarWidthState, width: number): SidebarWidthState {
  return width > LIST_MAX_WIDTH ? { ...state, width, boardWidth: width } : { ...state, width, listWidth: width };
}

/** Double-click on the handle: board ↔ list, opening the board at its last width or 3× the list. */
export function toggledWidth(state: SidebarWidthState, viewportWidth: number): number {
  if (state.width > LIST_MAX_WIDTH) return state.listWidth;
  return clampWidth(state.boardWidth ?? state.listWidth * 3, viewportWidth);
}

let state: SidebarWidthState = typeof window === "undefined" ? seedState(null, null) : readState();
/** What the store hands React: the chosen state plus the width that fits this window. */
let view: SidebarWidthState & { applied: number } = { ...state, applied: state.width };
const listeners = new Set<() => void>();
let installs = 0;
let uninstall: (() => void) | null = null;

function readState(): SidebarWidthState {
  return seedState(readStorageRaw(STORAGE_KEYS.sidebarWidth.key), readStorageRaw(CORE_STORAGE_KEY));
}

/**
 * Apply `next`. The chosen width survives a window too narrow for it: only
 * the applied width is clamped, so widening the window brings the board back.
 */
function setState(next: SidebarWidthState, persist: boolean) {
  state = next;
  const applied = clampWidth(next.width, window.innerWidth);
  view = { ...next, applied };
  document.documentElement.style.setProperty(WIDTH_VARIABLE, `${applied}px`);
  if (persist) {
    // A failed write still applies the width for this session.
    const { width, listWidth, boardWidth } = next;
    safeSetItem(STORAGE_KEYS.sidebarWidth.key, JSON.stringify({ width, listWidth, boardWidth }));
  }
  for (const listener of listeners) listener();
}

/** Desktop only: in the phone drawer bb sizes the content from `--sidebar-width-mobile`. */
function overrideRules(dragging: boolean): string {
  const width =
    `[data-sidebar="gap"],[data-sidebar="panel"]{--sidebar-width:var(${WIDTH_VARIABLE})!important}` +
    `[data-sidebar="collapsible-body"]>[style*="width"]{width:calc(var(${WIDTH_VARIABLE}) - var(--sidebar-rail-width))!important}`;
  const rules = dragging ? `${width}[data-sidebar="gap"],[data-sidebar="panel"]{transition:none!important}` : width;
  return `@media (min-width:${DESKTOP_MIN_VIEWPORT}px){${rules}}`;
}

function installOverride(): () => void {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = overrideRules(false);
  document.head.appendChild(style);
  setState(state, false);

  const isHandle = (target: EventTarget | null) =>
    target instanceof Element && target.closest(HANDLE_SELECTOR) !== null;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !isHandle(event.target) || window.innerWidth < DESKTOP_MIN_VIEWPORT) return;
    // bb's handler sits below us; it must never see this drag.
    event.preventDefault();
    event.stopPropagation();
    // The panel's left edge is 0 unless the window scrolled; measure anyway.
    const panel = document.querySelector('[data-sidebar="panel"]');
    const left = panel?.getBoundingClientRect().left ?? 0;
    style.textContent = overrideRules(true);
    const move = (moveEvent: PointerEvent) => {
      setState(withWidth({ ...state }, clampWidth(moveEvent.clientX - left, window.innerWidth)), false);
    };
    const end = () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      style.textContent = overrideRules(false);
      setState(state, true);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  };
  const onDoubleClick = (event: MouseEvent) => {
    if (!isHandle(event.target) || window.innerWidth < DESKTOP_MIN_VIEWPORT) return;
    event.preventDefault();
    event.stopPropagation();
    setState(withWidth(state, toggledWidth(state, window.innerWidth)), true);
  };
  const onResize = () => {
    if (clampWidth(state.width, window.innerWidth) !== view.applied) setState(state, false);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("dblclick", onDoubleClick, true);
  window.addEventListener("resize", onResize);
  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("dblclick", onDoubleClick, true);
    window.removeEventListener("resize", onResize);
    style.remove();
    document.documentElement.style.removeProperty(WIDTH_VARIABLE);
  };
}

/** Call from the thread list's mount effect; returns its cleanup. */
function installSidebarWidth(): () => void {
  installs += 1;
  if (installs === 1) uninstall = installOverride();
  return () => {
    installs -= 1;
    if (installs === 0) {
      uninstall?.();
      uninstall = null;
    }
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useSidebarWidth(): SidebarWidthState & { applied: number; boardMode: boolean } {
  const current = useSyncExternalStore(
    subscribe,
    () => view,
    () => view,
  );
  return { ...current, boardMode: installs > 0 && current.applied > LIST_MAX_WIDTH };
}

/** Owns the sidebar width while mounted; wider than bb's own cap is the board, never in the phone drawer. */
export function useBoardMode(isCompactViewport: boolean): boolean {
  useEffect(() => installSidebarWidth(), []);
  return useSidebarWidth().boardMode && !isCompactViewport;
}
