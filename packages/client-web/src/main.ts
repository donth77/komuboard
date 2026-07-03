import "./styles.css";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import {
  CLOSE_RATE_LIMIT,
  CLOSE_ROOM_FULL,
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
import { MOD_KEY, SHIFT_KEY, TOUCH_MEDIA } from "./platform";
import { settingsControlsHTML, syncSettingsControls } from "./settings-controls";
import "./avatar-presence-row";
import type { PresencePerson } from "./avatar-presence-row";
import "./tool-dock";
import "./sticky-bar";
import "./shape-menu";
import "./stamp-wheel";
import "./emoji-picker";
import { pushStampRecent } from "./stamp-wheel";
import { uploadImage, UploadError } from "./uploads";
import type { PenChange } from "./draw-bar";
import "./zoombar";
import type { ZoomDetail } from "./zoombar";
import "./topbar";
import "./drawer";
import "./tooltip"; // body-level singleton tooltip for every [data-tip] element (always top-most)
import { icon } from "./icons";
import { createProfileDialog } from "./ui/profile";
import { maybeShowIdentityNudge } from "./ui/identity-nudge";
import { createConnectionBanner } from "./ui/connection-banner";
import { createRefusedDialog } from "./ui/refused-dialog";
import { createJoinToasts } from "./ui/join-toast";
import { createSelectionBar } from "./ui/selection-bar";
import { createInsertSheet } from "./ui/insert-sheet";
import { createExportDialog, type ExportBackground, type ExportFormat } from "./ui/export-dialog";
import { createContextMenu } from "./ui/context-menu";
import { createShareDialog } from "./ui/share";
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
  /** True when the name was auto-generated this visit (never customized) — drives the first-run nudge. */
  fresh: boolean;
}
function loadIdentity(): Identity {
  let id = localStorage.getItem("komuboard-uid");
  if (!id) {
    id = randomId("u");
    localStorage.setItem("komuboard-uid", id);
  }
  let name = localStorage.getItem("komuboard-name");
  let fresh = false;
  if (!name) {
    name = randomGuestName();
    localStorage.setItem("komuboard-name", name);
    fresh = true;
  }
  let color = localStorage.getItem("komuboard-color");
  if (!color) {
    const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
    color = pickUserColor(seed);
    localStorage.setItem("komuboard-color", color);
  }
  return { id, name, color, photo: localStorage.getItem("komuboard-photo") ?? undefined, fresh };
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
  // Persist + restore this room's camera (pan/zoom) across reloads (see the auto-fit block below).
  viewKey: `komuboard-view-${room}`,
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

// Export dialog (PNG/PDF + background). Opened from the drawer/app-menu item and ⇧⌘E; its Export
// button runs the capture (runExport, defined below — hoisted).
const exportDialog = createExportDialog(
  ({ format, background }) => void runExport(format, background),
);

// Right-click context menus — object (acts on the selection) + canvas (paste / select all / zoom).
// The board suppresses the native menu (except inside a text editor, where paste etc. is wanted).
const contextMenu = createContextMenu({
  cut: () => {
    canvas.copySelection();
    canvas.deleteSelection();
  },
  copy: () => canvas.copySelection(),
  paste: () => canvas.pasteSelection(),
  duplicate: () => {
    canvas.copySelection();
    canvas.pasteSelection();
  },
  remove: () => canvas.deleteSelection(),
  bringToFront: () => canvas.bringSelectionToFront(),
  sendToBack: () => canvas.sendSelectionToBack(),
  group: () => canvas.groupSelection(),
  ungroup: () => canvas.ungroupSelection(),
  toggleLock: () => canvas.toggleSelectionLock(),
  selectAll: () => canvas.selectAll(),
  zoomToFit: () => canvas.zoomToFit(),
  canPaste: () => canvas.hasClipboard(),
});
boardEl.addEventListener("contextmenu", (e) => {
  if ((e.target as HTMLElement).closest?.(".komu-text-editor")) return; // native edit menu applies there
  e.preventDefault();
  const kind = canvas.contextTargetAt(e.clientX, e.clientY);
  contextMenu.openAt(e.clientX, e.clientY, kind, canvas.selectionMeta());
});

// Enter VR (drawer item) — lazy-load the A-Frame scene; the same doc renders on the panel. Enters an
// immersive session where supported, else a mouse-look 3D preview (the magic-window fallback).
let vrActive = false;
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement | null)?.closest('[data-act="vr"]')) return;
  closeAppMenu(); // the desktop app-menu variant closes itself like Export does
  if (vrActive) return;
  vrActive = true;
  const scrim = document.createElement("div");
  scrim.className = "export-scrim";
  scrim.textContent = "Preparing VR…";
  document.body.appendChild(scrim);
  void (async () => {
    try {
      const { enterVR } = await import("./vr/vr-mode");
      await enterVR({
        doc: ydoc,
        awareness: provider.awareness,
        viewport: canvas.worldViewport(),
        onExit: () => {
          vrActive = false;
        },
      });
    } catch (err) {
      console.error("[vr] failed to start:", err);
      showToast("Couldn't start VR on this device.");
      vrActive = false;
    } finally {
      scrim.remove();
    }
  })();
});
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
const mobileMql = window.matchMedia(TOUCH_MEDIA);
let currentTool: ToolId = "select";

// Mobile "Insert" (+) launcher. On phones the five insert tools collapse behind the dock's + button
// (CSS hides them); tapping + opens this sheet to pick one. On tablet/desktop the + is hidden and the
// five tools show inline, so this sheet never appears there.
const dockInsertBtn = dock?.querySelector<HTMLElement>('[data-tool="insert"]') ?? null;
const isInsertTool = (t: ToolId): boolean =>
  t === "sticky" || t === "text" || t === "shapes" || t === "stamp" || t === "image";
const insertSheet = createInsertSheet((kind) => {
  if (kind === "image") {
    openImagePicker();
    insertSheet.close();
    app?.classList.remove("sheet-open");
  } else {
    selectTool(kind); // applyTool activates the tool, opens its option sheet, and hides this launcher
  }
  refreshInsertActive();
});
const INSERT_LABELS: Record<string, string> = {
  sticky: "Sticky note",
  text: "Text",
  shapes: "Shapes and lines",
  stamp: "Stamp",
  image: "Image",
};
function refreshInsertActive(): void {
  if (!dockInsertBtn) return;
  // "armed" = an insert tool is active AND a tap would actually place its node (so the Stamp tool with
  // nothing picked, or a cancelled pick, reads as not-armed → the + reverts rather than showing a stamp).
  const armed = isInsertTool(currentTool) && canvas.insertArmed();
  // The + reads as active while its launcher is open OR an armed insert tool stands behind it…
  dockInsertBtn.classList.toggle("active", insertSheet.isOpen || armed);
  // …and it morphs into that tool's glyph so you can see WHICH insert tool is selected once its sheet
  // collapses (the tool's own dock button is hidden on phones). Falls back to the + otherwise.
  dockInsertBtn.innerHTML = icon(armed ? currentTool : "plus");
  dockInsertBtn.dataset.tip = armed ? (INSERT_LABELS[currentTool] ?? "Insert") : "Insert";
}

// Mobile selection action bar — fills the bottom tool-sheet slot when an object is selected on the
// touch layout (desktop hides it via CSS, having the keyboard + transform chrome). Gated on select
// mode so it never collides with a drawing tool's option sheet. Group/Ungroup show by context.
const selectionBar = createSelectionBar({
  onDuplicate: () => {
    canvas.copySelection();
    canvas.pasteSelection(); // clones with a cascade offset and selects the copies
  },
  onRotate: () => canvas.rotateSelection(15),
  onBringFront: () => canvas.bringSelectionToFront(),
  onSendBack: () => canvas.sendSelectionToBack(),
  onGroup: () => canvas.groupSelection(),
  onUngroup: () => canvas.ungroupSelection(),
  onLock: () => canvas.toggleSelectionLock(),
  onDelete: () => canvas.deleteSelection(),
});
let lastSelCount = 0;
function updateSelectionBar(): void {
  const visible = lastSelCount > 0 && currentTool === "select";
  const meta = visible ? canvas.selectionMeta() : null;
  selectionBar.update({
    visible,
    locked: meta?.locked ?? false,
    canGroup: !!meta && meta.count >= 2 && !meta.grouped,
    canUngroup: meta?.grouped ?? false,
    canReorder: meta?.overlapping ?? false,
  });
}
canvas.setSelectionListener((count) => {
  lastSelCount = count;
  updateSelectionBar();
});
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
const ALL_SHEETS = [drawBarEl, stickyBarEl, shapeMenuEl, stampWheelEl, insertSheet.el];
// Apply a tool to the canvas + sheet visibility (does NOT touch the dock highlight).
function applyTool(tool: ToolId): void {
  currentTool = tool;
  canvas.setTool(tool);
  updateSelectionBar(); // a non-select tool hides the action bar; returning to select may show it
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
  refreshInsertActive(); // applying any tool may close the insert launcher / light the + for inserts
}
// Dismiss the mobile Insert launcher and hand the bottom sheet back to the active tool — so backing
// out of "+" (tap it again / Esc) returns you to what you were doing (e.g. drawing, with the pen
// options showing) instead of leaving the tool active with no sheet. Picking an insert tool goes
// through applyTool instead, which shows that tool's own sheet.
function closeInsertSheet(): void {
  if (!insertSheet.isOpen) return;
  insertSheet.close();
  const active = sheetForTool(currentTool);
  for (const el of ALL_SHEETS) el?.classList.toggle("hidden", el !== active);
  active?.classList.remove("collapsed");
  app?.classList.toggle("sheet-open", !!active && currentTool !== "stamp");
  refreshInsertActive();
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
// --------------------------------------------------------------------------
// Image insert: a place-once dock tool (photo icon → file picker), plus drag-drop and paste. The
// bytes upload to R2 via the worker; the doc only stores the returned key (see uploads.ts).
// --------------------------------------------------------------------------
const imageInput = document.createElement("input");
imageInput.type = "file";
imageInput.accept = "image/png,image/jpeg,image/webp,image/gif";
imageInput.multiple = true;
imageInput.style.display = "none";
document.body.appendChild(imageInput);

function openImagePicker(): void {
  imageInput.value = ""; // reset so re-picking the same file still fires "change"
  imageInput.click();
}
imageInput.addEventListener("change", () => {
  const files = imageInput.files ? [...imageInput.files] : [];
  if (files.length) void placeImageFiles(files);
});

/** Upload + place one or more image files. `atClient` is a drop point (viewport coords); without it
 *  they land at the viewport centre. Multiple files cascade so they don't stack exactly. */
async function placeImageFiles(
  files: File[],
  atClient?: { clientX: number; clientY: number },
): Promise<void> {
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  selectTool("select"); // images live in select mode (transform chrome) — switch before placing
  const rect = boardEl?.getBoundingClientRect();
  const base =
    atClient ??
    (rect
      ? { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }
      : undefined);
  let placed = 0;
  for (const file of images) {
    try {
      const upload = await uploadImage(file);
      const at = base
        ? { clientX: base.clientX + placed * 28, clientY: base.clientY + placed * 28 }
        : undefined;
      canvas.placeImage(upload, at);
      placed++;
    } catch (err) {
      showToast(err instanceof UploadError ? err.message : "Couldn't add that image.");
    }
  }
}

/** A small, transient bottom toast — used for image-upload errors (bad type / too large / failed). */
function showToast(message: string): void {
  let host = document.querySelector<HTMLDivElement>(".komu-toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "komu-toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = "komu-toast";
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  window.setTimeout(() => {
    el.classList.remove("show");
    window.setTimeout(() => el.remove(), 300);
  }, 4200);
}

// Drag an image file onto the board → upload + place where it dropped.
boardEl?.addEventListener("dragover", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return; // ignore internal drags
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  app?.classList.add("drag-target");
});
boardEl?.addEventListener("dragleave", (e) => {
  if (e.target === boardEl) app?.classList.remove("drag-target");
});
boardEl?.addEventListener("drop", (e) => {
  app?.classList.remove("drag-target");
  const files = e.dataTransfer?.files ? [...e.dataTransfer.files] : [];
  if (!files.some((f) => f.type.startsWith("image/"))) return;
  e.preventDefault();
  void placeImageFiles(files, { clientX: e.clientX, clientY: e.clientY });
});

// Paste an image from the system clipboard → place at the viewport centre.
window.addEventListener("paste", (e) => {
  if (isTyping(e.target)) return; // a focused field / text editor owns the paste
  const items = e.clipboardData?.items ? [...e.clipboardData.items] : [];
  const files = items
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
  if (!files.length) return;
  e.preventDefault();
  void placeImageFiles(files);
});

dock?.addEventListener("tool-change", (e) => {
  const tool = (e as CustomEvent<{ tool: ToolId }>).detail.tool;
  // The photo tool is a momentary action: open the picker, then restore the previous tool's highlight
  // (the canvas never enters an "image" mode).
  if (tool === "image") {
    openImagePicker();
    if (dock) dock.tool = currentTool;
    return;
  }
  // The mobile + launcher toggles the Insert sheet (a launcher, not a tool — keep the active tool).
  if (tool === "insert") {
    if (insertSheet.isOpen) {
      closeInsertSheet();
    } else {
      for (const el of ALL_SHEETS) el?.classList.add("hidden"); // mutually exclusive with tool sheets
      emojiPickerEl?.classList.add("hidden");
      insertSheet.open();
      app?.classList.add("sheet-open");
    }
    if (dock) dock.tool = currentTool; // a launcher, not a tool — keep the active tool's dock highlight
    refreshInsertActive(); // …then re-assert the + state (the dock's #sync above clears it)
    return;
  }
  // Tapping a tool while the + launcher is open closes it and (re)activates that tool's sheet — so
  // tapping the tool you were on (e.g. Draw) brings its options back rather than toggling a hidden sheet.
  if (insertSheet.isOpen) {
    insertSheet.close();
    applyTool(tool);
    return;
  }
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
  refreshInsertActive(); // a stamp is now armed → the mobile + morphs to the stamp glyph
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
  refreshInsertActive(); // a stamp is now armed → the mobile + morphs to the stamp glyph
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
    '<div class="kbd-row"><span>Image</span><kbd class="kbd">I</kbd></div>' +
    `<div class="kbd-row"><span>Select all</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">A</kbd></span></div>` +
    `<div class="kbd-row"><span>Copy</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">C</kbd></span></div>` +
    `<div class="kbd-row"><span>Cut</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">X</kbd></span></div>` +
    `<div class="kbd-row"><span>Paste</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">V</kbd></span></div>` +
    '<div class="kbd-row"><span>Delete selection</span><span><kbd class="kbd">Del</kbd> / <kbd class="kbd">Backspace</kbd></span></div>' +
    `<div class="kbd-row"><span>Group / ungroup</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">G</kbd> / <kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">${SHIFT_KEY}</kbd> <kbd class="kbd">G</kbd></span></div>` +
    `<div class="kbd-row"><span>Lock / unlock (toggle)</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">L</kbd></span></div>` +
    '<div class="kbd-row"><span>Rotate (±15° / ±90° with Shift)</span><span><kbd class="kbd">[</kbd> / <kbd class="kbd">]</kbd></span></div>' +
    '<div class="kbd-row"><span>Nudge selection (1px / 10px with Shift)</span><span><kbd class="kbd">←</kbd> <kbd class="kbd">↑</kbd> <kbd class="kbd">↓</kbd> <kbd class="kbd">→</kbd></span></div>' +
    `<div class="kbd-row"><span>Bring to front / send to back</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">]</kbd> / <kbd class="kbd">[</kbd></span></div>` +
    `<div class="kbd-row"><span>Undo</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">Z</kbd></span></div>` +
    `<div class="kbd-row"><span>Redo</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">${SHIFT_KEY}</kbd> <kbd class="kbd">Z</kbd></span></div>` +
    '<div class="kbd-row"><span>Pan (hold)</span><kbd class="kbd">Space</kbd></div>' +
    `<div class="kbd-row"><span>Zoom in / out</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">+</kbd> / <kbd class="kbd">−</kbd></span></div>` +
    `<div class="kbd-row"><span>Export (PNG / PDF)</span><span><kbd class="kbd">${MOD_KEY}</kbd> <kbd class="kbd">${SHIFT_KEY}</kbd> <kbd class="kbd">E</kbd></span></div>` +
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
    // An open modal <dialog> handles its own Esc (don't also touch the canvas); an open popover
    // consumes the press. Otherwise ONE Esc does the rest together: cancel the active tool (revert
    // to Select, hiding its sheet) AND clear the selection.
    if (document.querySelector("dialog[open]")) return;
    if (appMenu) {
      closeAppMenu();
      return;
    }
    if (insertSheet.isOpen) {
      closeInsertSheet();
      return;
    }
    if (emojiPickerEl && !emojiPickerEl.classList.contains("hidden")) {
      emojiPickerEl.classList.add("hidden");
      return;
    }
    if (currentTool !== "select") selectTool("select");
    canvas.clearSelection();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    canvas.deleteSelection();
    e.preventDefault();
    return;
  }
  // ⌘] bring to front · ⌘[ send to back (z-order). NOT the ⇧ variant — macOS Chrome/Safari grab
  // ⌘⇧[ / ⌘⇧] for tab switching before the page sees them (un-preventable). ⌘[ / ⌘] map to history
  // back/forward, which IS preventable; we only override it when there's a selection. Checked before
  // the plain-bracket rotate below.
  if ((e.metaKey || e.ctrlKey) && (e.code === "BracketLeft" || e.code === "BracketRight")) {
    if (canvas.hasSelection()) {
      if (e.code === "BracketRight") canvas.bringSelectionToFront();
      else canvas.sendSelectionToBack();
      e.preventDefault();
    }
    return; // no selection → fall through to the browser's native history nav
  }
  // [ / ] rotate the selection by ±15° about its centre; Shift = ±90°. Uses e.code so Shift+[ (which
  // yields "{") still registers as the left bracket. No modifier → distinct from the ⌘⇧ z-order above.
  if ((e.code === "BracketLeft" || e.code === "BracketRight") && !e.metaKey && !e.ctrlKey) {
    if (canvas.hasSelection()) {
      canvas.rotateSelection((e.code === "BracketLeft" ? -1 : 1) * (e.shiftKey ? 90 : 15));
      e.preventDefault();
    }
    return;
  }
  // Arrow keys nudge the selection 1 world px (⇧ 10). Only with a selection — otherwise the arrows
  // stay free for future canvas panning / a11y focus traversal.
  if (
    (e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown") &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.altKey
  ) {
    if (canvas.hasSelection()) {
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      canvas.nudgeSelection(dx, dy);
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
  // ⇧⌘E opens the Export dialog (file type + background).
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
    exportDialog.open();
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
  // ⌘X cut = copy + delete (also in the right-click menu).
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "x") {
    if (canvas.hasSelection()) {
      canvas.copySelection();
      canvas.deleteSelection();
      e.preventDefault();
    }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
    canvas.pasteSelection();
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === "i") {
    openImagePicker(); // photo tool is a momentary action, not a sustained mode
    e.preventDefault();
    return;
  }
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
    '<div class="app-menu-head"><img class="brand-logo" src="/logo.webp" alt="" width="40" height="40" /> <strong>Komuboard</strong></div>' +
    '<div class="app-menu-body">' +
    `<button class="app-menu-item" type="button" data-act="profile"><span>Edit profile</span><span class="profile-id"><span class="profile-name" data-profile-name></span><span class="menu-avatar" data-profile-avatar aria-hidden="true"></span></span></button>` +
    '<div class="app-menu-sep"></div>' +
    settingsControlsHTML() +
    '<div class="app-menu-sep"></div>' +
    `<button class="app-menu-item" type="button" data-act="vr"><span>Enter VR</span><span class="drawer-item-ic">${icon("headset")}</span></button>` +
    '<div class="app-menu-sep"></div>' +
    `<button class="app-menu-item" type="button" data-act="export"><span>Export…</span><span class="drawer-item-ic">${icon("download")}</span></button>` +
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

// Export → the whole board as PNG or PDF with the chosen background. An opaque overlay masks the brief
// camera fit/restore the capture needs. Called by the export dialog's Export button.
let exporting = false;
function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function runExport(format: ExportFormat, background: ExportBackground): Promise<void> {
  if (exporting) return; // ignore re-entrancy while a capture is in flight
  exporting = true;
  const scrim = document.createElement("div");
  scrim.className = "export-scrim";
  scrim.textContent = "Exporting…";
  document.body.appendChild(scrim);
  try {
    const cv = await canvas.exportCanvas({ background });
    if (!cv) {
      showToast("Nothing to export yet — add something to the board first.");
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "pdf") {
      const { jsPDF } = await import("jspdf"); // lazy — keep the PDF lib out of the main bundle
      const w = cv.width;
      const h = cv.height;
      const pdf = new jsPDF({
        orientation: w >= h ? "landscape" : "portrait",
        unit: "px",
        format: [w, h],
      });
      pdf.addImage(cv.toDataURL("image/png"), "PNG", 0, 0, w, h);
      pdf.save(`komuboard-${stamp}.pdf`);
    } else {
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
      if (!blob) {
        showToast("Export failed — please try again.");
        return;
      }
      downloadBlob(blob, `komuboard-${stamp}.png`);
    }
  } catch {
    showToast("Export failed — please try again.");
  } finally {
    scrim.remove();
    exporting = false;
  }
}
// The export item lives in both the drawer (mobile) and the app menu (desktop) as [data-act="export"];
// one delegated handler opens the dialog from either (each menu closes itself).
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement | null)?.closest('[data-act="export"]')) return;
  closeAppMenu();
  exportDialog.open();
});

// Share → "Share this board" dialog (room link + QR + Copy). Built lazily on first open; the room is
// fixed per page load, so the dialog is reused thereafter.
let shareDialog: ReturnType<typeof createShareDialog> | null = null;
function openShare(): void {
  if (!shareDialog) {
    const u = new URL(window.location.href);
    u.searchParams.set("room", room);
    shareDialog = createShareDialog(u.toString());
  }
  shareDialog.open();
}
topbar?.addEventListener("share-board", openShare);
drawer?.addEventListener("share", openShare); // mobile overflow drawer item (if present)

// On-screen undo/redo (touch layout) — the same actions as ⌘Z / ⌘⇧Z, for devices with no keyboard.
topbar?.addEventListener("undo", () => canvas.undo());
topbar?.addEventListener("redo", () => canvas.redo());

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
// A dropped-then-restored connection surfaces a top-center "Reconnecting…" → "Back online" pill
// (offline edits are buffered in the Yjs doc and resync automatically). Silent on first connect.
const connBanner = createConnectionBanner();
store.subscribe((state) => {
  topbar?.setStatus(state.status);
  if (!connectionRefused) connBanner.update(state.status); // a deliberate refusal owns the UI instead
});

// When the room DO *deliberately* refuses us (full room / rate-limited flood) it closes with a 4xxx
// code. Without this we'd reconnect forever showing "Reconnecting…"; instead stop retrying and explain
// why, with a way to try again or start fresh.
let connectionRefused = false;
const refusedDialog = createRefusedDialog({
  onRetry: () => {
    connectionRefused = false;
    provider.connect(); // re-attempt; if the room is still full, connection-close fires again
  },
  onNewBoard: () => {
    const u = new URL(window.location.href);
    u.searchParams.set("room", randomRoomId());
    window.location.href = u.toString(); // a fresh, empty room
  },
});
provider.on("connection-close", (event: { code?: number }) => {
  if (event?.code !== CLOSE_ROOM_FULL && event?.code !== CLOSE_RATE_LIMIT) return;
  connectionRefused = true;
  provider.disconnect(); // halt the auto-reconnect loop (shouldConnect = false)
  connBanner.update("connected"); // dismiss any "Reconnecting…" pill — the dialog owns this state
  refusedDialog.show(event.code);
});

// Presence avatar row — avatars from awareness; click your own to rename.
const presenceRowEl = document.querySelector("komu-avatar-presence-row");
if (presenceRowEl) presenceRowEl.max = 7; // show up to 7 avatars, then a clickable "+N" overflow

// Join toasts: announce peers who arrive *after* the room's initial roster settles, so the people
// already present when you connect don't all toast at once. Keyed by stable identity id (not
// clientId) so one toast per person, not per tab.
const joinToasts = createJoinToasts();
const knownPeerIds = new Set<string>();
let joinReady = false;
let joinSettleStarted = false;
provider.on("sync", () => {
  if (joinSettleStarted) return;
  joinSettleStarted = true;
  window.setTimeout(() => {
    joinReady = true;
  }, 800);
});
function detectJoins(list: PresencePerson[]): void {
  const present = new Set<string>();
  for (const p of list) {
    if (p.me) continue;
    present.add(p.id);
    if (knownPeerIds.has(p.id)) continue;
    knownPeerIds.add(p.id);
    if (joinReady) joinToasts.show(p.name, p.color);
  }
  for (const id of [...knownPeerIds]) if (!present.has(id)) knownPeerIds.delete(id); // a rejoin re-toasts
}

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
  detectJoins(list); // membership changed → check for newcomers to toast
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

// First-run only: gently point a brand-new (auto-named) visitor at the profile editor, since the
// presence row that normally hosts your clickable avatar is hidden while you're alone. Non-blocking.
maybeShowIdentityNudge({
  name: identity.name,
  color: identity.color,
  fresh: identity.fresh,
  onEdit: () => profile.open(),
});
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

// Land a link/QR joiner on the board's content: zoom-to-fit once, on the first sync, when the board
// already has content and they haven't started interacting. Only on the *initial* sync — never on
// later edits, which would yank the viewport mid-work. Suppressed in e2e (geometry tests assume 100%).
const autoFitEnabled =
  (window as Window & { __komuboardAutoFit?: boolean }).__komuboardAutoFit !== false;
// Restore this room's persisted camera if there is one — and count that as "already framed" so the
// auto-fit doesn't override it. A genuine first-time visitor has no saved view, so they still get
// the auto-fit (now capped at 100%, so a sparse board no longer slams to 500%).
const restoredView = canvas.restoreSavedView();
let didInitialFit = restoredView;
let userMovedViewport = false;
const markViewportMoved = (): void => {
  userMovedViewport = true;
};
boardEl.addEventListener("pointerdown", markViewportMoved, { capture: true, once: true });
boardEl.addEventListener("wheel", markViewportMoved, { capture: true, once: true, passive: true });
provider.on("sync", () => {
  if (!autoFitEnabled || didInitialFit || userMovedViewport) return;
  if (ydoc.getMap("objects").size === 0) return; // empty board → nothing to frame
  didInitialFit = true;
  requestAnimationFrame(() => {
    if (!userMovedViewport) canvas.zoomToFit();
  });
});

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
