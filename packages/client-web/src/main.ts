import "./styles.css";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import {
  PARTY,
  pickUserColor,
  randomGuestName,
  randomId,
  randomRoomId,
  roomIdFromUrl,
  setUserProfile,
  usersMap,
  type PresenceState,
} from "@coboard/shared";
import { BoardCanvas, type ToolId } from "./canvas";
import { createAppStore } from "./store";
import { createDialog } from "./dialog";
import "./avatar-presence-row";
import type { PresencePerson } from "./avatar-presence-row";
import "./tool-dock";
import "./pen-panel";
import type { PenChange } from "./pen-panel";
import { COLOR_NAMES } from "./pen-panel";
import "./zoombar";
import type { ZoomDetail } from "./zoombar";
import "./topbar";
import "./drawer";

declare global {
  interface Window {
    /** Test/debug hook (used by the e2e two-client convergence test). */
    __coboard?: { doc: Y.Doc; provider: YProvider; awareness: Awareness; canvas?: BoardCanvas };
  }
}

// --------------------------------------------------------------------------
// Theme: default to OS preference, follow it until the user picks, persist.
// --------------------------------------------------------------------------
const THEME_KEY = "coboard-theme";
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

// Icons now live in ./icons; the tool list lives inside <co-tool-dock>.

// --------------------------------------------------------------------------
// Realtime: one Yjs document per room, synced via Y-PartyServer.
// --------------------------------------------------------------------------
// The room comes from the URL (?room= or first path segment). If there's no
// room, mint a fresh shareable one and write it into the address bar — so
// opening Coboard with no link drops you into your own room, not a shared lobby.
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
  let id = localStorage.getItem("coboard-uid");
  if (!id) {
    id = randomId("u");
    localStorage.setItem("coboard-uid", id);
  }
  let name = localStorage.getItem("coboard-name");
  if (!name) {
    name = randomGuestName();
    localStorage.setItem("coboard-name", name);
  }
  let color = localStorage.getItem("coboard-color");
  if (!color) {
    const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0);
    color = pickUserColor(seed);
    localStorage.setItem("coboard-color", color);
  }
  return { id, name, color, photo: localStorage.getItem("coboard-photo") ?? undefined };
}
const identity = loadIdentity();
const user: PresenceState = { name: identity.name, color: identity.color };
window.__coboard = { doc: ydoc, provider, awareness: provider.awareness };

// pen state — FigJam-style fixed palette; a trailing rainbow swatch opens the custom picker.
const SWATCHES = [
  "#0e1116",
  "#dc2626",
  "#f59e0b",
  "#facc15",
  "#16a34a",
  "#2563eb",
  "#7c3aed",
  "#ec4899",
  "#ffffff",
];
const penColor = "#0e1116";

// --------------------------------------------------------------------------
// Shell.
// --------------------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root missing");

app.innerHTML = `
  <co-topbar id="topbar" room="${room}"></co-topbar>

  <main class="canvas" id="board"></main>

  <div class="zoom-pill" id="zoom-pill" aria-hidden="true">100%</div>

  <co-tool-dock></co-tool-dock>

  <div class="sheet-wrap"><co-pen-panel></co-pen-panel></div>

  <co-zoombar></co-zoombar>

  <co-drawer room="${room}"></co-drawer>
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
});
if (window.__coboard) window.__coboard.canvas = canvas; // e2e hook: introspect remote presence
canvas.setColor(penColor);
canvas.setWidth(24);
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
// Tool dock + pen properties panel (<co-tool-dock>, <co-pen-panel>).
// --------------------------------------------------------------------------
const dock = document.querySelector("co-tool-dock");
const penPanelEl = document.querySelector("co-pen-panel");
if (penPanelEl) {
  penPanelEl.swatches = SWATCHES;
  penPanelEl.color = penColor;
}
let currentTool: ToolId = "select";
// Apply a tool to the canvas + panel visibility (does NOT touch the dock highlight).
function applyTool(tool: ToolId): void {
  currentTool = tool;
  canvas.setTool(tool);
  const isPen = tool === "pen";
  penPanelEl?.classList.toggle("hidden", !isPen);
  penPanelEl?.classList.remove("collapsed"); // pen → fully expand; non-pen → no tab (hidden wins)
  app?.classList.toggle("pen-open", isPen); // dock top merges with the sheet/tab while pen is active
}
// Programmatic selection (keyboard) also drives the dock's own highlight.
function selectTool(tool: ToolId): void {
  if (dock) dock.tool = tool;
  applyTool(tool);
}
dock?.addEventListener("tool-change", (e) =>
  applyTool((e as CustomEvent<{ tool: ToolId }>).detail.tool),
);
applyTool(currentTool); // sync initial state: select is default → pen panel hidden

// Mobile: tapping the canvas dismisses the pen sheet (slides it out of the way; the pen
// tool stays selected — tap Pen again to bring it back).
const mobileMql = window.matchMedia("(max-width: 640px)");
boardEl.addEventListener(
  "pointerdown",
  () => {
    if (mobileMql.matches && penPanelEl && !penPanelEl.classList.contains("hidden")) {
      penPanelEl.classList.add("collapsed");
    }
  },
  true,
);
penPanelEl?.addEventListener("pen-change", (e) => {
  const d = (e as CustomEvent<PenChange>).detail;
  if (d.color !== undefined) canvas.setColor(d.color);
  if (d.width !== undefined) canvas.setWidth(d.width);
  if (d.style !== undefined) canvas.setStyle(d.style);
  if (d.opacity !== undefined) canvas.setOpacity(d.opacity);
});

// Shortcuts overlay (reusable <co-dialog>).
const shortcutsDialog = createDialog({
  title: "Keyboard shortcuts",
  width: 340,
  body:
    '<div class="kbd-row"><span>Select</span><kbd class="kbd">V</kbd></div>' +
    '<div class="kbd-row"><span>Hand / pan</span><kbd class="kbd">H</kbd></div>' +
    '<div class="kbd-row"><span>Pen</span><kbd class="kbd">P</kbd></div>' +
    '<div class="kbd-row"><span>Select all</span><span><kbd class="kbd">⌘</kbd> <kbd class="kbd">A</kbd></span></div>' +
    '<div class="kbd-row"><span>Delete selection</span><span><kbd class="kbd">Del</kbd> / <kbd class="kbd">⌫</kbd></span></div>' +
    '<div class="kbd-row"><span>Undo</span><span><kbd class="kbd">⌘</kbd> <kbd class="kbd">Z</kbd></span></div>' +
    '<div class="kbd-row"><span>Redo</span><span><kbd class="kbd">⌘</kbd> <kbd class="kbd">⇧</kbd> <kbd class="kbd">Z</kbd></span></div>' +
    '<div class="kbd-row"><span>Pan (hold)</span><kbd class="kbd">Space</kbd></div>' +
    '<div class="kbd-row"><span>Zoom in / out</span><span><kbd class="kbd">⌘</kbd> + scroll</span></div>' +
    '<div class="kbd-row"><span>Toggle this menu</span><kbd class="kbd">?</kbd></div>',
});

function isTyping(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  return !!n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA" || n.isContentEditable);
}

// Keyboard: V/H/P tools, hold Space to pan, ? for the shortcuts menu, Esc to close.
const KEY_TOOL: Record<string, ToolId> = { v: "select", h: "hand", p: "pen" };
let spacePanning = false;
window.addEventListener("keydown", (e) => {
  if (isTyping(e.target)) return;
  if (document.querySelector("dialog[open]")) return; // an open dialog owns the keyboard (Esc closes it)
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

// Pen color / width / style / opacity edits are handled inside <co-pen-panel>,
// surfaced via the "pen-change" listener above.

// --------------------------------------------------------------------------
// Theme toggle.
// --------------------------------------------------------------------------
const topbar = document.querySelector("co-topbar");
const drawer = document.querySelector("co-drawer");
const syncThemeBtn = (): void => {
  if (topbar) topbar.theme = theme; // top-bar button glyph
  if (drawer) drawer.theme = theme; // drawer item glyph
};
syncThemeBtn();
function toggleTheme(): void {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  syncThemeBtn();
}
topbar?.addEventListener("theme-toggle", toggleTheme);
drawer?.addEventListener("theme-toggle", toggleTheme);
darkMedia.addEventListener("change", () => {
  if (storedTheme()) return;
  theme = systemTheme();
  applyTheme(theme);
  syncThemeBtn();
});

// Mobile slide-out drawer (<co-drawer>): the hamburger opens it; it closes itself
// on scrim click. Its Theme item surfaces as a "theme-toggle" event (wired above).
topbar?.addEventListener("nav-toggle", () => {
  if (drawer) drawer.open = true;
});

// --------------------------------------------------------------------------
// Status / presence dev readout.
// --------------------------------------------------------------------------
store.subscribe((state) => {
  topbar?.setStatus(state.status);
});

// Presence avatar row — avatars from awareness; click your own to rename.
const presenceRowEl = document.querySelector("co-avatar-presence-row");
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?").slice(0, 2);
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
  const list: PresencePerson[] = [...people.entries()]
    .map(([id, p]) => {
      const profile = users.get(id);
      return {
        id,
        name: profile?.name ?? p.name,
        color: profile?.color ?? p.color,
        photo: profile?.photo,
        me: p.me,
      };
    })
    .sort((a, b) => (a.me ? -1 : b.me ? 1 : 0));
  // awareness "change" fires on every cursor move (≈30Hz × peers); only touch the DOM when the
  // membership-relevant data actually changed — cursor-only ticks produce an identical list.
  const key = list
    .map((p) => `${p.id}|${p.name}|${p.color}|${p.photo ?? ""}|${p.me ? 1 : 0}`)
    .join("/");
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  presenceRowEl.people = list; // the <co-avatar-presence-row> element renders + animates
}
provider.awareness.on("change", renderPresenceRow);
renderPresenceRow();
presenceRowEl?.addEventListener("rename", () => openProfile());
// The provider only drops our presence on the legacy "unload" event, which modern
// browsers routinely skip on tab close (bfcache). Announce departure on pagehide so
// remaining peers remove our avatar immediately instead of waiting for a timeout.
window.addEventListener("pagehide", () => provider.awareness.setLocalState(null));

// ---- profile dialog (native <dialog>, fully custom-styled + animated) ----
const profileDialog = createDialog({
  title: "Your profile",
  width: 360,
  body:
    '<div class="avatar-edit"><div class="avatar-preview" id="profile-avatar"></div>' +
    '<div class="avatar-edit-actions">' +
    '<button type="button" class="btn-soft" id="profile-photo-btn">Upload photo</button>' +
    '<button type="button" class="btn-link" id="profile-photo-clear">Remove</button>' +
    '<input type="file" id="profile-photo-input" accept="image/*" hidden /></div></div>' +
    '<label class="field"><span>Display name</span><input type="text" id="profile-name" maxlength="40" placeholder="Your name" /></label>' +
    '<div class="field" id="profile-color-field"><span>Color</span><div class="swatches" id="profile-swatches"></div></div>',
  footer:
    '<button type="button" class="btn-ghost" data-dialog-close>Cancel</button>' +
    '<button type="button" class="btn-primary" id="profile-save">Save</button>',
});
const dName = document.getElementById("profile-name") as HTMLInputElement | null;
const dAvatar = document.getElementById("profile-avatar");
const dSwatches = document.getElementById("profile-swatches");
const dPhotoInput = document.getElementById("profile-photo-input") as HTMLInputElement | null;
const dPhotoClear = document.getElementById("profile-photo-clear");
// Avatar colours mirror the pen palette, minus white (a white avatar would be invisible).
const PROFILE_SWATCHES = SWATCHES.filter((c) => c.toLowerCase() !== "#ffffff");
let draft: { name: string; color: string; photo?: string } = {
  name: identity.name,
  color: identity.color,
  photo: identity.photo,
};

function renderDraftAvatar(): void {
  if (!dAvatar) return;
  dAvatar.style.setProperty("--av", draft.color);
  if (draft.photo) {
    dAvatar.style.backgroundImage = `url("${draft.photo}")`;
    dAvatar.classList.add("has-photo");
    dAvatar.textContent = "";
  } else {
    dAvatar.style.backgroundImage = "";
    dAvatar.classList.remove("has-photo");
    dAvatar.textContent = initials(draft.name || "Guest");
  }
  // "Remove" only applies to an uploaded photo — the default initials avatar can't be removed.
  if (dPhotoClear) dPhotoClear.style.display = draft.photo ? "" : "none";
}
function renderProfileSwatches(): void {
  if (!dSwatches) return;
  dSwatches.innerHTML = PROFILE_SWATCHES.map((c) => {
    const name = COLOR_NAMES[c.toUpperCase()] ?? c;
    return `<button type="button" class="sw${c === draft.color ? " on" : ""}" data-color="${c}" data-tip="${name}" style="--sw:${c}" aria-label="${name}"></button>`;
  }).join("");
}
function openProfile(): void {
  draft = { name: identity.name, color: identity.color, photo: identity.photo };
  if (dName) dName.value = draft.name;
  renderProfileSwatches();
  renderDraftAvatar();
  profileDialog.open();
  dName?.focus();
  dName?.select();
}

dName?.addEventListener("input", () => {
  draft.name = dName.value;
  renderDraftAvatar();
});
dSwatches?.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>(".sw");
  if (!t) return;
  draft.color = t.getAttribute("data-color") ?? draft.color;
  renderProfileSwatches();
  renderDraftAvatar();
});
document.getElementById("profile-photo-btn")?.addEventListener("click", () => dPhotoInput?.click());
document.getElementById("profile-photo-clear")?.addEventListener("click", () => {
  draft.photo = undefined;
  renderDraftAvatar();
});
dPhotoInput?.addEventListener("change", () => {
  const file = dPhotoInput.files?.[0];
  if (!file) return;
  void fileToAvatarDataUrl(file).then((url) => {
    draft.photo = url;
    renderDraftAvatar();
  });
  dPhotoInput.value = "";
});
// close is handled by <co-dialog>: header ✕, the Cancel [data-dialog-close], and backdrop click
document.getElementById("profile-save")?.addEventListener("click", () => {
  identity.name = (draft.name.trim() || identity.name).slice(0, 40);
  identity.color = draft.color;
  identity.photo = draft.photo;
  user.name = identity.name;
  user.color = identity.color;
  localStorage.setItem("coboard-name", identity.name);
  localStorage.setItem("coboard-color", identity.color);
  if (identity.photo) localStorage.setItem("coboard-photo", identity.photo);
  else localStorage.removeItem("coboard-photo");
  provider.awareness.setLocalStateField("user", identity.name);
  provider.awareness.setLocalStateField("color", identity.color);
  publishProfile();
  renderPresenceRow();
  profileDialog.close();
});

/** Resize a chosen image to a small square JPEG data URL (avatar thumbnail). */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = 96;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return c.toDataURL("image/jpeg", 0.82);
}

// Zoom + fullscreen widget (<co-zoombar>).
const zoombar = document.querySelector("co-zoombar");
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
  if (d.action === "in") canvas.zoomBy(1.25);
  else if (d.action === "out") canvas.zoomBy(1 / 1.25);
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

// Connection + presence readouts now live inside <co-topbar> (setStatus / setSynced).
