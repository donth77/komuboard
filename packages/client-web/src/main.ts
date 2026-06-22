import "./styles.css";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import {
  DEFAULT_STICKY_COLOR,
  PARTY,
  pickUserColor,
  randomGuestName,
  randomId,
  randomRoomId,
  roomIdFromUrl,
  setUserProfile,
  USER_COLORS,
  usersMap,
  type PresenceState,
} from "@komuboard/shared";
import { BoardCanvas, type ToolId } from "./canvas";
import { createAppStore } from "./store";
import { createDialog } from "./dialog";
import { MOD_KEY, SHIFT_KEY } from "./platform";
import { settingsControlsHTML, syncSettingsControls } from "./settings-controls";
import "./avatar-presence-row";
import type { PresencePerson } from "./avatar-presence-row";
import "./tool-dock";
import "./sticky-bar";
import "./shape-menu";
import "./stamp-wheel";
import "./emoji-picker";
import { pushStampRecent } from "./stamp-wheel";
import type { PenChange } from "./draw-bar";
import "./zoombar";
import type { ZoomDetail } from "./zoombar";
import "./topbar";
import "./drawer";
import "./tooltip"; // body-level singleton tooltip for every [data-tip] element (always top-most)
import { icon } from "./icons";
import { createProfileDialog } from "./ui/profile";
import { paintProfile } from "./util";
import { SWATCHES } from "./palette";

declare global {
  interface Window {
    /** Test/debug hook (used by the e2e two-client convergence test). */
    __komuboard?: { doc: Y.Doc; provider: YProvider; awareness: Awareness; canvas?: BoardCanvas };
  }
}

// --------------------------------------------------------------------------
// Theme: default to OS preference, follow it until the user picks, persist.
// --------------------------------------------------------------------------
const THEME_KEY = "komuboard-theme";
type Theme = "light" | "dark";
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
const systemTheme = (): Theme => (darkMedia.matches ? "dark" : "light");
const storedTheme = (): Theme | null => {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : null;
};
const applyTheme = (t: Theme): void => {
  document.documentElement.dataset.theme = t;
};
let theme: Theme = storedTheme() ?? systemTheme();
applyTheme(theme);

// --------------------------------------------------------------------------
// Grid style: dots (FigJam) vs lines (Figma). A per-viewer preference, persisted
// locally and applied as data-grid on the .canvas board element (never synced to
// the doc — two people in a room can view different grids). The LOD/crossfade
// rendering lives in styles.css + ViewportController.syncGrid().
// --------------------------------------------------------------------------
const GRID_KEY = "komuboard-grid";
type GridMode = "dots" | "lines";
const storedGrid = (): GridMode | null => {
  const v = localStorage.getItem(GRID_KEY);
  return v === "dots" || v === "lines" ? v : null;
};
let gridMode: GridMode = storedGrid() ?? "dots";
const applyGrid = (g: GridMode): void => {
  document.getElementById("board")?.setAttribute("data-grid", g);
};

// Icons now live in ./icons; the tool list lives inside <komu-tool-dock>.

// --------------------------------------------------------------------------
// Realtime: one Yjs document per room, synced via Y-PartyServer.
// --------------------------------------------------------------------------
// The room comes from the URL (?room= or first path segment). If there's no
// room, mint a fresh shareable one and write it into the address bar — so
// opening Komuboard with no link drops you into your own room, not a shared lobby.
let room = roomIdFromUrl(new URL(window.location.href), "");
if (!room) {
  room = randomRoomId();
  const u = new URL(window.location.href);
  u.searchParams.set("room", room);
  window.history.replaceState(null, "", u);
}
const store = createAppStore(room);
const host = import.meta.env.VITE_WORKER_HOST ?? "127.0.0.1:8787";

const ydoc = new Y.Doc();
const provider = new YProvider(host, room, ydoc, { party: PARTY });
// Stable per-browser identity: multiple tabs read as the same person; open a
// private/incognito window (separate storage) to appear as a new user.
interface Identity {
  id: string;
  name: string;
  color: string;
  photo?: string;
}
function loadIdentity(): Identity {
  let id = localStorage.getItem("komuboard-uid");
  if (!id) {
    id = randomId("u");
    localStorage.setItem("komuboard-uid", id);
  }
  let name = localStorage.getItem("komuboard-name");
  if (!name) {
    name = randomGuestName();
    localStorage.setItem("komuboard-name", name);
  }
  let color = localStorage.getItem("komuboard-color");
  if (!color) {
    const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
    color = pickUserColor(seed);
    localStorage.setItem("komuboard-color", color);
  }
  return { id, name, color, photo: localStorage.getItem("komuboard-photo") ?? undefined };
}
const identity = loadIdentity();
const user: PresenceState = { name: identity.name, color: identity.color };
window.__komuboard = { doc: ydoc, provider, awareness: provider.awareness };

// pen state — fixed palette (./palette); a trailing rainbow swatch opens the custom picker.
const penColor = "#0e1116";

// --------------------------------------------------------------------------
// Shell.
// --------------------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root missing");

app.innerHTML = `
  <komu-topbar id="topbar" room="${room}"></komu-topbar>

  <main class="canvas" id="board" data-grid="${gridMode}"></main>

  <div class="zoom-pill" id="zoom-pill" aria-hidden="true">100%</div>

  <komu-tool-dock></komu-tool-dock>

  <div class="sheet-wrap">
    <komu-draw-bar></komu-draw-bar>
    <komu-sticky-bar class="hidden"></komu-sticky-bar>
    <komu-shape-menu class="hidden"></komu-shape-menu>
    <komu-stamp-wheel class="hidden"></komu-stamp-wheel>
  </div>

  <komu-emoji-picker class="hidden"></komu-emoji-picker>

  <komu-zoombar></komu-zoombar>

  <button class="help-btn" id="help-btn" type="button" data-tip="Help" aria-label="Help">${icon("help")}</button>

  <komu-drawer room="${room}"></komu-drawer>
`;

// --------------------------------------------------------------------------
// Canvas.
// --------------------------------------------------------------------------
const boardEl = document.getElementById("board");
if (!boardEl) throw new Error("#board missing");
const canvas = new BoardCanvas({
  container: boardEl,
  doc: ydoc,
  awareness: provider.awareness,
  user,
  // Revert to select after a text/sticky box is placed + finished (drives the dock highlight too).
  requestTool: (tool) => selectTool(tool),
  // After drawing / placing a sticky / placing a shape, collapse the mobile mini-sheet to reclaim
  // canvas space (desktop has no collapse — the sheets are floating panels).
  onPlaced: () => {
    if (mobileMql.matches) sheetForTool(currentTool)?.classList.add("collapsed");
  },
  // A placed emoji becomes the most-recent (front of the 5, i.e. top-of-wheel going clockwise).
  onStampPlaced: (src) => {
    if (!src.startsWith("emoji:")) return;
    pushStampRecent(src.slice("emoji:".length));
    wheel?.render();
  },
});
if (window.__komuboard) window.__komuboard.canvas = canvas; // e2e hook: introspect remote presence
canvas.setColor(penColor);
canvas.setWidth(8);
provider.awareness.setLocalStateField("id", identity.id);

// Publish my profile into the shared doc (synced once + persisted, never in
// awareness), and keep the avatar row in sync when anyone's profile changes.
function publishProfile(): void {
  setUserProfile(ydoc, identity.id, {
    name: identity.name,
    color: identity.color,
    photo: identity.photo,
  });
}
publishProfile();
usersMap(ydoc).observe(() => renderPresenceRow());

// --------------------------------------------------------------------------
// Tool dock + draw bar (<komu-tool-dock>, <komu-draw-bar>).
// --------------------------------------------------------------------------
const dock = document.querySelector("komu-tool-dock");
const drawBarEl = document.querySelector("komu-draw-bar");
if (drawBarEl) {
  drawBarEl.swatches = SWATCHES;
  drawBarEl.color = penColor;
}
const stickyBarEl = document.querySelector("komu-sticky-bar");
if (stickyBarEl) {
  stickyBarEl.color = DEFAULT_STICKY_COLOR;
  canvas.setStickyColor(DEFAULT_STICKY_COLOR);
}
const shapeMenuEl = document.querySelector("komu-shape-menu");
const stampWheelEl = document.querySelector("komu-stamp-wheel");
const emojiPickerEl = document.querySelector("komu-emoji-picker");
// The "Shapes and lines" menu has two groups: shape boxes (placed) and connectors (drawn as arrows).
const DRAWABLE_SHAPES = new Set(["rectangle", "ellipse", "rhombus", "triangle"]);
const CONNECTOR_KINDS = new Set(["line", "arrow", "elbow", "block"]);
const mobileMql = window.matchMedia("(max-width: 640px)");
let currentTool: ToolId = "select";
// Each of these tools owns a mobile mini-sheet (draw bar / sticky palette / shape menu).
const sheetForTool = (tool: ToolId): Element | null =>
  tool === "pen"
    ? drawBarEl
    : tool === "sticky"
      ? stickyBarEl
      : tool === "shapes"
        ? shapeMenuEl
        : tool === "stamp"
          ? stampWheelEl
          : null;
const ALL_SHEETS = [drawBarEl, stickyBarEl, shapeMenuEl, stampWheelEl];
// Apply a tool to the canvas + sheet visibility (does NOT touch the dock highlight).
function applyTool(tool: ToolId): void {
  currentTool = tool;
  canvas.setTool(tool);
  const active = sheetForTool(tool);
  for (const el of ALL_SHEETS) {
    el?.classList.toggle("hidden", el !== active);
    if (el !== active) el?.classList.remove("collapsed");
  }
  active?.classList.remove("collapsed"); // newly shown → fully expanded
  // The mini-sheets (draw/sticky/shape) sit flush atop the dock so its top merges with them; the
  // stamp wheel floats free, so it must NOT trigger that merge.
  app?.classList.toggle("sheet-open", !!active && tool !== "stamp");
  if (tool !== "stamp") emojiPickerEl?.classList.add("hidden"); // leaving stamp closes the picker
  // Replay the wheel's entrance (outer ring in first, inner emoji disc just after) each time it opens.
  if (tool === "stamp" && stampWheelEl) {
    const w = stampWheelEl as HTMLElement;
    w.classList.remove("sw-intro");
    void w.offsetWidth; // reflow → restart the animation
    w.classList.add("sw-intro");
    window.setTimeout(() => w.classList.remove("sw-intro"), 900);
  }
}
// Re-clicking the active tool toggles its sheet (the tool stays selected).
function toggleSheet(el: Element | null): void {
  if (!el) return;
  // The stamp wheel isn't a sliding mini-sheet (it's a free-floating panel that closes on pick), so
  // it toggles its visibility outright on every platform — letting a re-tap of the Stamp tool reopen it.
  if (mobileMql.matches && el.classList.contains("mini-sheet")) {
    el.classList.toggle("collapsed"); // mobile: collapse to the pull-tab / re-expand
    return;
  }
  const open = !el.classList.contains("hidden");
  el.classList.toggle("hidden", open);
  if (el.classList.contains("mini-sheet")) app?.classList.toggle("sheet-open", !open);
  // Reopening the wheel replays its entrance animation.
  if (!open && el === stampWheelEl) {
    const w = el as HTMLElement;
    w.classList.remove("sw-intro");
    void w.offsetWidth;
    w.classList.add("sw-intro");
    window.setTimeout(() => w.classList.remove("sw-intro"), 900);
  }
}
// Programmatic selection (keyboard) also drives the dock's own highlight.
function selectTool(tool: ToolId): void {
  if (dock) dock.tool = tool;
  applyTool(tool);
}
dock?.addEventListener("tool-change", (e) => {
  const tool = (e as CustomEvent<{ tool: ToolId }>).detail.tool;
  // Clicking a sheet tool while it's already active toggles its sheet (the tool stays selected).
  if (tool === currentTool && sheetForTool(tool)) toggleSheet(sheetForTool(tool));
  else applyTool(tool);
});
applyTool(currentTool); // sync initial state: select is default → draw bar hidden

// <komu-draw-bar> emits `pen-change` (bubbling) → handle once on #app.
app?.addEventListener("pen-change", (e) => {
  const d = (e as CustomEvent<PenChange>).detail;
  if (d.color !== undefined) canvas.setColor(d.color);
  if (d.width !== undefined) canvas.setWidth(d.width);
  if (d.style !== undefined) canvas.setStyle(d.style);
});

// <komu-sticky-bar> emits `sticky-color` (bubbling) → set the colour for the next/edited sticky note.
app?.addEventListener("sticky-color", (e) => {
  canvas.setStickyColor((e as CustomEvent<{ color: string }>).detail.color);
});

// <komu-shape-menu> emits `shape-change` → either set the shape box drawn next, or switch the tool
// into connector-draw mode (line/arrow/elbow/block draw on drag, snapping to shape sides).
app?.addEventListener("shape-change", (e) => {
  const kind = (e as CustomEvent<{ kind: string }>).detail.kind;
  if (DRAWABLE_SHAPES.has(kind)) canvas.setShape(kind as Parameters<typeof canvas.setShape>[0]);
  else if (CONNECTOR_KINDS.has(kind))
    canvas.setConnector(kind as Parameters<typeof canvas.setConnector>[0]);
});

// --------------------------------------------------------------------------
// Stamp tool (<komu-stamp-wheel> radial picker + <komu-emoji-picker> popover).
// --------------------------------------------------------------------------
const wheel = stampWheelEl as import("./stamp-wheel").CoStampWheel | null;
wheel?.setProfile({ name: identity.name, color: identity.color, photo: identity.photo });
// Picking a mark / recent emoji / avatar from the wheel arms it and closes the wheel — the armed
// stamp now rides the cursor, so the canvas is clear to place on (re-tap the Stamp tool to reopen).
app?.addEventListener("stamp-pick", (e) => {
  canvas.setStamp((e as CustomEvent<{ src: string }>).detail.src);
  stampWheelEl?.classList.add("hidden");
});
// The wheel's "+" opens the full emoji picker.
app?.addEventListener("stamp-picker-open", () => {
  emojiPickerEl?.classList.toggle("hidden");
});
// Picking from the full grid: remember it (front of recents), refresh the wheel, arm + highlight it,
// then close the picker.
app?.addEventListener("emoji-pick", (e) => {
  const cp = (e as CustomEvent<{ cp: string }>).detail.cp;
  pushStampRecent(cp);
  wheel?.render();
  canvas.setStamp(`emoji:${cp}`);
  if (wheel) wheel.active = `emoji:${cp}`;
  emojiPickerEl?.classList.add("hidden");
  stampWheelEl?.classList.add("hidden"); // armed → close the wheel (re-tap Stamp to reopen)
});
// Click anywhere outside the picker (and not on the wheel's "+") dismisses it.
document.addEventListener("pointerdown", (e) => {
  if (emojiPickerEl?.classList.contains("hidden")) return;
  const t = e.target as HTMLElement;
  if (emojiPickerEl?.contains(t) || t.closest("[data-plus]")) return;
  emojiPickerEl?.classList.add("hidden");
});

// Shortcuts overlay (reusable <komu-dialog>).
const shortcutsDialog = createDialog({
  title: "Keyboard shortcuts",
  width: 340,
  body:
    '<div class="kbd-row"><span>Select</span><kbd class="kbd">V</kbd></div>' +
    '<div class="kbd-row"><span>Hand / pan</span><kbd class="kbd">H</kbd></div>' +
    '<div class="kbd-row"><span>Pen</span><kbd class="kbd">P</kbd></div>' +
    '<div class="kbd-row"><span>Eraser</span><kbd class="kbd">E</kbd></div>' +
    '<div class="kbd-row"><span>Sticky note</span><kbd class="kbd">S</kbd></div>' +
    '<div class="kbd-row"><span>Text</span><kbd class="kbd">T</kbd></div>' +
    '<div class="kbd-row"><span>Shapes and lines</span><kbd class="kbd">R</kbd></div>' +
    '<div class="kbd-row"><span>Stamp</span><kbd class="kbd">K</kbd></div>' +
    `<div class="kbd-row"><span>Select all</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">A</kbd></span></div>` +
    `<div class="kbd-row"><span>Copy</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">C</kbd></span></div>` +
    `<div class="kbd-row"><span>Paste</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">V</kbd></span></div>` +
    '<div class="kbd-row"><span>Delete selection</span><span><kbd class="kbd">Del</kbd> / <kbd class="kbd">Backspace</kbd></span></div>' +
    `<div class="kbd-row"><span>Group / ungroup</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">G</kbd> / <kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">${SHIFT_KEY}</kbd> <kbd class="kbd">G</kbd></span></div>` +
    `<div class="kbd-row"><span>Lock / unlock (toggle)</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">L</kbd></span></div>` +
    `<div class="kbd-row"><span>Undo</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">Z</kbd></span></div>` +
    `<div class="kbd-row"><span>Redo</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">${SHIFT_KEY}</kbd> <kbd class="kbd">Z</kbd></span></div>` +
    '<div class="kbd-row"><span>Pan (hold)</span><kbd class="kbd">Space</kbd></div>' +
    `<div class="kbd-row"><span>Zoom in / out</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">+</kbd> / <kbd class="kbd">−</kbd></span></div>` +
    '<div class="kbd-row"><span>Toggle this menu</span><kbd class="kbd">?</kbd></div>',
});

function isTyping(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);
}

// Keyboard: V/H/P tools, hold Space to pan, ? for the shortcuts menu, Esc to close.
const KEY_TOOL: Record<string, ToolId> = {
  v: "select",
  h: "hand",
  p: "pen",
  e: "eraser",
  t: "text",
  s: "sticky",
  r: "shapes",
  k: "stamp",
};
let spacePanning = false;
window.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return; // an open dialog owns the keyboard (Esc closes it)
  // Canvas zoom (⌘/Ctrl + =/+ to zoom in, ⌘/Ctrl + -/_ to zoom out) — handled before the "is
  // typing" guard so it works even with a field focused (e.g. the zoom input); no text-editing
  // conflict, and preventDefault stops the browser's native page zoom regardless of focus.
  if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
    canvas.zoomStep(1);
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "-" || e.key === "_")) {
    canvas.zoomStep(-1);
    e.preventDefault();
    return;
  }
  if (isTyping(e.target)) return;
  if (e.key === "?") {
    shortcutsDialog.open();
    e.preventDefault();
    return;
  }
  if (e.key === " " && !e.repeat) {
    spacePanning = true;
    canvas.setTool("hand");
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    canvas.clearSelection();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    canvas.deleteSelection();
    e.preventDefault();
    return;
  }
  // [ / ] rotate the selection by ±15° about its centre; Shift = ±90°. Uses e.code so Shift+[ (which
  // yields "{") still registers as the left bracket.
  if (e.code === "BracketLeft" || e.code === "BracketRight") {
    if (canvas.hasSelection()) {
      canvas.rotateSelection((e.code === "BracketLeft" ? -1 : 1) * (e.shiftKey ? 90 : 15));
      e.preventDefault();
    }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    if (e.shiftKey) canvas.redo();
    else canvas.undo();
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
    canvas.redo();
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    canvas.selectAll();
    e.preventDefault();
    return;
  }
  // ⌘G group · ⇧⌘G ungroup
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
    if (e.shiftKey) canvas.ungroupSelection();
    else canvas.groupSelection();
    e.preventDefault();
    return;
  }
  // ⌘L toggles lock/unlock (single key — some browser extensions grab ⇧⌘L); ⇧⌘L stays as an
  // explicit unlock for anyone whose ⇧⌘L is free.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
    if (e.shiftKey) canvas.setSelectionLocked(false);
    else canvas.toggleSelectionLock();
    e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
    if (canvas.hasSelection()) {
      canvas.copySelection();
      e.preventDefault(); // copying selected objects, not the page → suppress native copy
    }
    return; // nothing selected → let the browser handle ⌘/Ctrl+C (e.g. copy selected UI text)
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
    canvas.pasteSelection();
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tool = KEY_TOOL[e.key.toLowerCase()];
  if (tool) {
    selectTool(tool);
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === " " && spacePanning) {
    spacePanning = false;
    canvas.setTool(currentTool);
  }
});

// Pen colour / width / style edits are handled inside <komu-draw-bar>,
// surfaced via the "pen-change" listener above.

// --------------------------------------------------------------------------
// Settings: theme + grid style. The same controls render in two places — the
// desktop gear → Settings dialog and the mobile drawer — and, since everything is
// light DOM, one delegated click handler + syncSettings() keep every instance in
// step (see settings-controls.ts). Both prefs are per-viewer, persisted locally.
// --------------------------------------------------------------------------
const topbar = document.querySelector("komu-topbar");
const drawer = document.querySelector("komu-drawer");
if (drawer) drawer.profile = { name: identity.name, color: identity.color, photo: identity.photo };

const syncSettings = (): void => syncSettingsControls(theme, gridMode);

function toggleTheme(): void {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  syncSettings();
}
function setGridMode(g: GridMode): void {
  if (g === gridMode) return;
  gridMode = g;
  localStorage.setItem(GRID_KEY, g);
  applyGrid(g);
  syncSettings();
}

// The settings controls live in both the dialog and the drawer (light DOM), so a
// single delegated handler covers every instance.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement | null;
  const g = t?.closest<HTMLElement>("[data-grid-opt]")?.dataset.gridOpt;
  if (g === "dots" || g === "lines") setGridMode(g);
  else if (t?.closest("[data-theme-toggle]")) toggleTheme();
});
syncSettings();

// Follow the OS theme until the user picks one explicitly (then the stored pref wins).
darkMedia.addEventListener("change", () => {
  if (storedTheme()) return;
  theme = systemTheme();
  applyTheme(theme);
  syncSettings();
});

// App menu: the hamburger opens a dropdown on desktop (branding + grid/theme — this replaces the
// old gear dialog) and the slide-out drawer on mobile (which hosts the same shared controls).
let appMenu: HTMLElement | null = null;
let onMenuPointer: ((e: PointerEvent) => void) | null = null;
function closeAppMenu(): void {
  appMenu?.remove();
  appMenu = null;
  if (onMenuPointer) {
    document.removeEventListener("pointerdown", onMenuPointer, true);
    onMenuPointer = null;
  }
}
function toggleAppMenu(): void {
  if (appMenu) {
    closeAppMenu();
    return;
  }
  const navBtn = topbar?.querySelector<HTMLElement>(".nav-btn");
  if (!navBtn) return;
  const menu = document.createElement("div");
  menu.className = "app-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML =
    '<div class="app-menu-head"><span class="logo">◳</span> <strong>Komuboard</strong></div>' +
    '<div class="app-menu-body">' +
    `<button class="app-menu-item" type="button" data-act="profile"><span>Edit profile</span><span class="profile-id"><span class="profile-name" data-profile-name></span><span class="menu-avatar" data-profile-avatar aria-hidden="true"></span></span></button>` +
    '<div class="app-menu-sep"></div>' +
    settingsControlsHTML() +
    "</div>";
  document.body.appendChild(menu);
  appMenu = menu;
  paintProfile(menu, { name: identity.name, color: identity.color, photo: identity.photo });
  const r = navBtn.getBoundingClientRect();
  menu.style.left = `${r.left}px`;
  menu.style.top = `${r.bottom + 8}px`;
  syncSettings(); // reflect current grid/theme in the freshly-rendered controls
  onMenuPointer = (ev) => {
    const t = ev.target as Node;
    if (menu.contains(t) || navBtn.contains(t)) return;
    closeAppMenu();
  };
  document.addEventListener("pointerdown", onMenuPointer, true);
}
topbar?.addEventListener("nav-toggle", () => {
  if (mobileMql.matches) {
    if (drawer) drawer.open = true;
  } else {
    toggleAppMenu();
  }
});
mobileMql.addEventListener("change", closeAppMenu); // breakpoint flip → drop a stale desktop menu

// Help → keyboard-shortcuts dialog: a floating "?" button on desktop, a drawer item on mobile.
document.getElementById("help-btn")?.addEventListener("click", () => shortcutsDialog.open());
drawer?.addEventListener("help", () => shortcutsDialog.open());

// "Edit profile" (the dropdown + drawer item) → open the profile editor by re-dispatching the
// avatar row's `rename` intent, so it works even when that row is hidden (e.g. when solo).
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement | null)?.closest('[data-act="profile"]')) return;
  document
    .querySelector("komu-avatar-presence-row")
    ?.dispatchEvent(new CustomEvent("rename", { bubbles: true }));
  closeAppMenu();
});

// --------------------------------------------------------------------------
// Status / presence dev readout.
// --------------------------------------------------------------------------
store.subscribe((state) => {
  topbar?.setStatus(state.status);
});

// Presence avatar row — avatars from awareness; click your own to rename.
const presenceRowEl = document.querySelector("komu-avatar-presence-row");
if (presenceRowEl) presenceRowEl.max = 7; // show up to 7 avatars, then a clickable "+N" overflow
let lastPresenceKey = "";
function renderPresenceRow(): void {
  if (!presenceRowEl) return;
  const self = provider.awareness.clientID;
  // Dedup connections by stable identity id (multiple tabs => one person).
  const people = new Map<string, { name: string; color: string; me: boolean }>();
  provider.awareness.getStates().forEach((st, clientId) => {
    const s = st as Record<string, unknown>;
    const id = String(s["id"] ?? `c${clientId}`);
    const entry = people.get(id) ?? {
      name: String(s["user"] ?? "Guest"),
      color: String(s["color"] ?? "#2563eb"),
      me: false,
    };
    if (clientId === self) entry.me = true;
    people.set(id, entry);
  });
  const users = usersMap(ydoc);
  const list: PresencePerson[] = [...people.entries()].map(([id, p]) => {
    const profile = users.get(id);
    return {
      id,
      name: profile?.name ?? p.name,
      color: profile?.color ?? p.color,
      photo: profile?.photo,
      me: p.me,
    };
  }); // natural awareness order — your avatar stacks in line (Edit profile lives in the menu now)
  // awareness "change" fires on every cursor move (≈30Hz × peers); only touch the DOM when the
  // membership-relevant data actually changed — cursor-only ticks produce an identical list.
  const key = list
    .map((p) => `${p.id}|${p.name}|${p.color}|${p.photo ?? ""}|${p.me ? 1 : 0}`)
    .join("/");
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  presenceRowEl.people = list; // the <komu-avatar-presence-row> element renders + animates
}
provider.awareness.on("change", renderPresenceRow);
renderPresenceRow();
// ---- "Your profile" dialog (name + colour + avatar photo) — UI lives in ./ui/profile ----
const profile = createProfileDialog({
  swatches: [...USER_COLORS], // the 12-colour identity palette (matches auto-assigned avatar colours)
  initial: () => ({ name: identity.name, color: identity.color, photo: identity.photo }),
  // Empty name → keep the existing one (we own the identity, so the fallback lives here).
  onSave: (p) => {
    identity.name = (p.name.trim() || identity.name).slice(0, 40);
    identity.color = p.color;
    identity.photo = p.photo;
    user.name = identity.name;
    user.color = identity.color;
    localStorage.setItem("komuboard-name", identity.name);
    localStorage.setItem("komuboard-color", identity.color);
    if (identity.photo) localStorage.setItem("komuboard-photo", identity.photo);
    else localStorage.removeItem("komuboard-photo");
    provider.awareness.setLocalStateField("user", identity.name);
    provider.awareness.setLocalStateField("color", identity.color);
    publishProfile();
    renderPresenceRow();
    if (drawer)
      drawer.profile = { name: identity.name, color: identity.color, photo: identity.photo };
    wheel?.setProfile({ name: identity.name, color: identity.color, photo: identity.photo });
  },
});
// Clicking your own avatar (the row's `rename` intent) opens the profile editor.
presenceRowEl?.addEventListener("rename", () => profile.open());
// The provider only drops our presence on the legacy "unload" event, which modern
// browsers routinely skip on tab close (bfcache). Announce departure on pagehide so
// remaining peers remove our avatar immediately instead of waiting for a timeout.
window.addEventListener("pagehide", () => provider.awareness.setLocalState(null));

// Zoom + fullscreen widget (<komu-zoombar>).
const zoombar = document.querySelector("komu-zoombar");
const zoomPill = document.getElementById("zoom-pill");
let zoomPillTimer = 0;
canvas.setZoomListener((pct) => {
  if (zoombar) zoombar.percent = pct;
  // Transient zoom readout — the main indicator on mobile, where the zoombar is hidden.
  if (zoomPill) {
    zoomPill.textContent = `${pct}%`;
    zoomPill.classList.add("show");
    clearTimeout(zoomPillTimer);
    zoomPillTimer = window.setTimeout(() => zoomPill.classList.remove("show"), 900);
  }
});
zoombar?.addEventListener("zoom", (e) => {
  const d = (e as CustomEvent<ZoomDetail>).detail;
  if (d.action === "in") canvas.zoomStep(1);
  else if (d.action === "out") canvas.zoomStep(-1);
  else if (d.action === "reset") canvas.resetZoom();
  else if (d.action === "fullscreen") {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  } else if (d.action === "set" && d.value) canvas.zoomTo(d.value / 100);
});

// Read the real connection state directly (robust to provider event quirks),
// refreshed on events + a 1 s poll so the readout never sticks.
let lastConnStatus = "";
let lastSyncText = "";
function updateConn(): void {
  const connected = provider.wsconnected;
  const status = connected
    ? "connected"
    : provider.wsUnsuccessfulReconnects > 1
      ? "disconnected"
      : "connecting";
  const synced = provider.synced ? "synced" : connected ? "syncing…" : "—";
  if (status === lastConnStatus && synced === lastSyncText) return; // skip no-op store/DOM writes
  lastConnStatus = status;
  lastSyncText = synced;
  store.getState().setStatus(status);
  topbar?.setSynced(synced);
}
provider.on("status", updateConn);
provider.on("sync", updateConn);
let lastConnCount = -1;
provider.awareness.on("change", () => {
  // Connection state doesn't change at cursor frequency; only react when the peer count
  // actually changes (status/sync are covered by the provider events + the 1 s poll below).
  const n = provider.awareness.getStates().size;
  if (n === lastConnCount) return;
  lastConnCount = n;
  store.getState().setConnections(n);
});
window.setInterval(updateConn, 1000);
updateConn();

// Connection + presence readouts now live inside <komu-topbar> (setStatus / setSynced).
