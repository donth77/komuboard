import "./styles.css";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import {
  PARTY,
  USER_COLORS,
  pickUserColor,
  randomGuestName,
  randomId,
  randomRoomId,
  roomIdFromUrl,
  setUserProfile,
  usersMap,
  type PresenceState,
  type StrokeStyle,
} from "@coboard/shared";
import { BoardCanvas, type ToolId } from "./canvas";
import { createAppStore } from "./store";

declare global {
  interface Window {
    /** Test/debug hook (used by the e2e two-client convergence test). */
    __coboard?: { doc: Y.Doc; provider: YProvider; awareness: Awareness };
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

// --------------------------------------------------------------------------
// Lucide-style inline icons.
// --------------------------------------------------------------------------
const ICONS: Record<string, string> = {
  select: '<path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8a8 8 0 0 0 8 8a8 8 0 0 0 8-8v-3a2 2 0 0 0-4 0"/>',
  pen: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  sticky: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10l6-6V5a2 2 0 0 0-2-2z"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  rect: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  ellipse: '<circle cx="12" cy="12" r="9"/>',
  fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
};
const icon = (name: string, cls = "ico"): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;

// icon, key, label, tool (null = not yet wired — lands in the next M1 increment)
const TOOLS: ReadonlyArray<readonly [string, string, string, ToolId | null]> = [
  ["select", "v", "Select", "select"],
  ["hand", "h", "Hand / pan", "hand"],
  ["pen", "p", "Pen", "pen"],
  ["sticky", "s", "Sticky note", null],
  ["text", "t", "Text", null],
  ["rect", "r", "Rectangle", null],
  ["ellipse", "o", "Ellipse", null],
];

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

// pen state (defaults: draw in your presence color)
const SWATCHES = Array.from(
  new Set([user.color, "#0e1116", "#dc2626", "#f59e0b", "#16a34a", "#2563eb", "#7c3aed"]),
);
let penColor = user.color;

// --------------------------------------------------------------------------
// Shell.
// --------------------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root missing");

app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="logo">◳</span> Coboard</div>
    <div class="room-pill" data-testid="room"><span class="dot" data-testid="dot"></span> <strong>${room}</strong> · <span id="online">1</span> online</div>
    <button class="iconbtn" id="theme-toggle" type="button" aria-label="Toggle light / dark theme"></button>
    <div class="spacer"></div>
    <div class="devstatus" title="connection status">WS <b data-testid="status">connecting…</b> · <b data-testid="synced">syncing…</b></div>
    <div class="facepile" id="facepile" data-testid="facepile" title="People here — click your avatar to rename"></div>
  </header>

  <main class="canvas" id="board"></main>

  <aside class="dock" aria-label="Tools">
    ${TOOLS.map(
      ([name, key, label, tool]) =>
        `<button class="tool${tool === "pen" ? " active" : ""}${tool ? "" : " disabled"}" type="button" data-tool="${tool ?? ""}" title="${label} (${key.toUpperCase()})${tool ? "" : " — coming soon"}" aria-label="${label}">${icon(name)}</button>`,
    ).join("")}
  </aside>

  <section class="panel pen-panel" id="pen-panel" aria-label="Pen properties">
    <div class="panel-head">Pen</div>
    <div class="panel-sec">
      <div class="panel-label">Color</div>
      <div class="swatches" id="pen-swatches">
        ${SWATCHES.map(
          (c) =>
            `<button class="sw${c === penColor ? " on" : ""}" type="button" data-color="${c}" style="--sw:${c}" aria-label="${c}"></button>`,
        ).join("")}
      </div>
    </div>
    <div class="panel-sec">
      <div class="panel-label">Stroke width · <b id="pen-w-val">24</b> px</div>
      <input type="range" id="pen-width" min="1" max="96" value="24" />
    </div>
    <div class="panel-sec">
      <div class="panel-label">Style</div>
      <div class="seg" id="pen-style">
        <button class="seg-opt on" type="button" data-style="solid">Solid</button>
        <button class="seg-opt" type="button" data-style="dashed">Dashed</button>
        <button class="seg-opt" type="button" data-style="highlight">Highlight</button>
      </div>
    </div>
    <div class="panel-sec">
      <div class="panel-label">Opacity · <b id="pen-o-val">100</b>%</div>
      <input type="range" id="pen-opacity" min="10" max="100" value="100" />
    </div>
  </section>

  <div class="zoombar">
    <button class="zb" id="zoom-out" type="button" aria-label="Zoom out">−</button>
    <span class="zb pct"><input id="zoom-pct" type="text" inputmode="numeric" value="100" aria-label="Zoom percent" title="Type a zoom % and press Enter" />%</span>
    <button class="zb" id="zoom-in" type="button" aria-label="Zoom in">+</button>
    <span class="zb-sep"></span>
    <button class="zb" id="zoom-fit" type="button" aria-label="Zoom to fit">${icon("fit", "ico-sm")}</button>
    <button class="zb" id="fullscreen" type="button" aria-label="Toggle fullscreen">${icon("expand", "ico-sm")}</button>
  </div>
  <div class="hint-chip">Press <kbd class="kbd">?</kbd> for shortcuts · <kbd class="kbd">⌘</kbd>+scroll to zoom · <kbd class="kbd">space</kbd> to pan</div>

  <div class="modal-backdrop hidden" id="shortcuts">
    <div class="modal" role="dialog" aria-label="Keyboard shortcuts" aria-modal="true">
      <div class="modal-head"><span>Keyboard shortcuts</span><button class="modal-x" id="shortcuts-x" type="button" aria-label="Close">✕</button></div>
      <div class="modal-body">
        <div class="kbd-row"><span>Select</span><kbd class="kbd">V</kbd></div>
        <div class="kbd-row"><span>Hand / pan</span><kbd class="kbd">H</kbd></div>
        <div class="kbd-row"><span>Pen</span><kbd class="kbd">P</kbd></div>
        <div class="kbd-row"><span>Pan (hold)</span><kbd class="kbd">Space</kbd></div>
        <div class="kbd-row"><span>Zoom in / out</span><span><kbd class="kbd">⌘</kbd> + scroll</span></div>
        <div class="kbd-row"><span>Toggle this menu</span><kbd class="kbd">?</kbd></div>
      </div>
    </div>
  </div>

  <dialog class="dialog" id="profile">
    <div class="dialog-head"><span>Your profile</span><button type="button" class="modal-x" id="profile-x" aria-label="Close">✕</button></div>
    <div class="dialog-body">
      <div class="avatar-edit">
        <div class="avatar-preview" id="profile-avatar"></div>
        <div class="avatar-edit-actions">
          <button type="button" class="btn-soft" id="profile-photo-btn">Upload photo</button>
          <button type="button" class="btn-link" id="profile-photo-clear">Remove</button>
          <input type="file" id="profile-photo-input" accept="image/*" hidden />
        </div>
      </div>
      <label class="field"><span>Display name</span><input type="text" id="profile-name" maxlength="40" placeholder="Your name" /></label>
      <div class="field"><span>Color</span><div class="swatches" id="profile-swatches"></div></div>
    </div>
    <div class="dialog-foot">
      <button type="button" class="btn-ghost" id="profile-cancel">Cancel</button>
      <button type="button" class="btn-primary" id="profile-save">Save</button>
    </div>
  </dialog>
`;

// --------------------------------------------------------------------------
// Canvas.
// --------------------------------------------------------------------------
const boardEl = document.getElementById("board");
if (!boardEl) throw new Error("#board missing");
const canvas = new BoardCanvas({ container: boardEl, doc: ydoc, awareness: provider.awareness, user });
canvas.setColor(penColor);
canvas.setWidth(24);
provider.awareness.setLocalStateField("id", identity.id);

// Publish my profile into the shared doc (synced once + persisted, never in
// awareness), and keep the facepile in sync when anyone's profile changes.
function publishProfile(): void {
  setUserProfile(ydoc, identity.id, {
    name: identity.name,
    color: identity.color,
    photo: identity.photo,
  });
}
publishProfile();
usersMap(ydoc).observe(() => renderFacepile());

// --------------------------------------------------------------------------
// Tools + pen properties panel.
// --------------------------------------------------------------------------
const penPanel = document.getElementById("pen-panel");
const toolButtons = Array.from(app.querySelectorAll<HTMLButtonElement>(".tool[data-tool]"));
let currentTool: ToolId = "pen";
function activateTool(tool: ToolId): void {
  currentTool = tool;
  canvas.setTool(tool);
  for (const b of toolButtons) b.classList.toggle("active", b.getAttribute("data-tool") === tool);
  penPanel?.classList.toggle("hidden", tool !== "pen");
}
for (const btn of toolButtons) {
  const tool = btn.getAttribute("data-tool") as ToolId | "";
  if (tool) btn.addEventListener("click", () => activateTool(tool));
}

// Shortcuts overlay.
const shortcutsEl = document.getElementById("shortcuts");
function toggleShortcuts(show?: boolean): void {
  if (!shortcutsEl) return;
  const next = show ?? shortcutsEl.classList.contains("hidden");
  shortcutsEl.classList.toggle("hidden", !next);
}
document.getElementById("shortcuts-x")?.addEventListener("click", () => toggleShortcuts(false));
shortcutsEl?.addEventListener("click", (e) => {
  if (e.target === shortcutsEl) toggleShortcuts(false);
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
  if (e.key === "?") {
    toggleShortcuts();
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") {
    toggleShortcuts(false);
    return;
  }
  if (e.key === " " && !e.repeat) {
    spacePanning = true;
    canvas.setTool("hand");
    e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tool = KEY_TOOL[e.key.toLowerCase()];
  if (tool) {
    activateTool(tool);
    e.preventDefault();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === " " && spacePanning) {
    spacePanning = false;
    canvas.setTool(currentTool);
  }
});

const swatchWrap = document.getElementById("pen-swatches");
swatchWrap?.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>(".sw");
  if (!target) return;
  penColor = target.getAttribute("data-color") ?? penColor;
  canvas.setColor(penColor);
  swatchWrap.querySelectorAll(".sw").forEach((s) => s.classList.toggle("on", s === target));
});

const widthInput = document.getElementById("pen-width") as HTMLInputElement | null;
const widthVal = document.getElementById("pen-w-val");
widthInput?.addEventListener("input", () => {
  const w = Number(widthInput.value);
  canvas.setWidth(w);
  if (widthVal) widthVal.textContent = String(w);
});

const styleSeg = document.getElementById("pen-style");
styleSeg?.addEventListener("click", (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>(".seg-opt");
  if (!target) return;
  canvas.setStyle((target.getAttribute("data-style") as StrokeStyle) ?? "solid");
  styleSeg.querySelectorAll(".seg-opt").forEach((s) => s.classList.toggle("on", s === target));
});

const opacityInput = document.getElementById("pen-opacity") as HTMLInputElement | null;
const opacityVal = document.getElementById("pen-o-val");
opacityInput?.addEventListener("input", () => {
  const pct = Number(opacityInput.value);
  canvas.setOpacity(pct / 100);
  if (opacityVal) opacityVal.textContent = String(pct);
});

// --------------------------------------------------------------------------
// Theme toggle.
// --------------------------------------------------------------------------
const themeBtn = document.getElementById("theme-toggle");
if (!themeBtn) throw new Error("#theme-toggle missing");
const syncThemeBtn = (): void => {
  themeBtn.innerHTML = icon(theme === "dark" ? "sun" : "moon");
};
syncThemeBtn();
themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  syncThemeBtn();
});
darkMedia.addEventListener("change", () => {
  if (storedTheme()) return;
  theme = systemTheme();
  applyTheme(theme);
  syncThemeBtn();
});

// --------------------------------------------------------------------------
// Status / presence dev readout.
// --------------------------------------------------------------------------
const statusEl = byTestId("status");
const syncedEl = byTestId("synced");
const dotEl = byTestId("dot");

store.subscribe((state) => {
  statusEl.textContent = state.status;
  dotEl.dataset.state = state.status;
});

// Presence facepile — avatars from awareness; click your own to rename.
const facepileEl = document.getElementById("facepile");
const onlineEl = document.getElementById("online");
const MAX_FACES = 5;
const avatarEls = new Map<string, HTMLElement>();
function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return (((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?").slice(0, 2);
}
function renderFacepile(): void {
  if (!facepileEl) return;
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
  const list = [...people.entries()].sort((a, b) => (a[1].me ? -1 : b[1].me ? 1 : 0));
  if (onlineEl) onlineEl.textContent = String(list.length);
  const shown = list.slice(0, MAX_FACES);
  const shownIds = new Set(shown.map(([id]) => id));
  for (const [id, p] of shown) {
    const profile = usersMap(ydoc).get(id);
    const name = profile?.name ?? p.name;
    const color = profile?.color ?? p.color;
    const photo = profile?.photo;
    let el = avatarEls.get(id);
    if (!el) {
      el = document.createElement("span");
      el.className = "avatar enter";
      avatarEls.set(id, el);
      const created = el;
      requestAnimationFrame(() => created.classList.remove("enter"));
    }
    el.style.setProperty("--av", color);
    el.classList.toggle("self", p.me);
    el.title = p.me ? `${name} (you)` : name;
    if (photo) {
      el.style.backgroundImage = `url("${photo}")`;
      el.classList.add("has-photo");
      el.textContent = "";
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("has-photo");
      el.textContent = initials(name);
    }
    facepileEl.appendChild(el); // (re)order to match the sorted list
  }
  for (const [id, el] of avatarEls) {
    if (!shownIds.has(id)) {
      avatarEls.delete(id);
      el.classList.add("leave");
      window.setTimeout(() => el.remove(), 220);
    }
  }
  const extra = list.length - shown.length;
  let more = facepileEl.querySelector<HTMLElement>(".avatar.more");
  if (extra > 0) {
    if (!more) {
      more = document.createElement("span");
      more.className = "avatar more";
    }
    more.textContent = `+${extra}`;
    facepileEl.appendChild(more);
  } else if (more) {
    more.remove();
  }
}
provider.awareness.on("change", renderFacepile);
renderFacepile();
facepileEl?.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".avatar.self")) openProfile();
});

// ---- profile dialog (native <dialog>, fully custom-styled + animated) ----
const dialog = document.getElementById("profile") as HTMLDialogElement | null;
const dName = document.getElementById("profile-name") as HTMLInputElement | null;
const dAvatar = document.getElementById("profile-avatar");
const dSwatches = document.getElementById("profile-swatches");
const dPhotoInput = document.getElementById("profile-photo-input") as HTMLInputElement | null;
const PROFILE_SWATCHES = USER_COLORS.slice(0, 8);
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
}
function renderProfileSwatches(): void {
  if (!dSwatches) return;
  dSwatches.innerHTML = PROFILE_SWATCHES.map(
    (c) =>
      `<button type="button" class="sw${c === draft.color ? " on" : ""}" data-color="${c}" style="--sw:${c}" aria-label="${c}"></button>`,
  ).join("");
}
function openProfile(): void {
  draft = { name: identity.name, color: identity.color, photo: identity.photo };
  if (dName) dName.value = draft.name;
  renderProfileSwatches();
  renderDraftAvatar();
  dialog?.showModal();
  dName?.focus();
  dName?.select();
}
function closeProfile(): void {
  dialog?.close();
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
document.getElementById("profile-cancel")?.addEventListener("click", closeProfile);
document.getElementById("profile-x")?.addEventListener("click", closeProfile);
dialog?.addEventListener("click", (e) => {
  if (e.target === dialog) closeProfile(); // click on the backdrop
});
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
  renderFacepile();
  closeProfile();
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

// Zoom + fullscreen widget.
const zoomInput = document.getElementById("zoom-pct") as HTMLInputElement | null;
canvas.setZoomListener((pct) => {
  // don't clobber what the user is typing
  if (zoomInput && document.activeElement !== zoomInput) zoomInput.value = String(pct);
});
function applyZoomInput(): void {
  if (!zoomInput) return;
  const pct = parseInt(zoomInput.value.replace(/[^0-9]/g, ""), 10);
  if (Number.isFinite(pct) && pct > 0) canvas.zoomTo(pct / 100);
  else zoomInput.value = String(canvas.getZoomPercent());
}
zoomInput?.addEventListener("focus", () => zoomInput.select());
zoomInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    applyZoomInput();
    zoomInput.blur();
  } else if (e.key === "Escape") {
    zoomInput.value = String(canvas.getZoomPercent());
    zoomInput.blur();
  }
});
zoomInput?.addEventListener("blur", applyZoomInput);
document.getElementById("zoom-in")?.addEventListener("click", () => canvas.zoomBy(1.25));
document.getElementById("zoom-out")?.addEventListener("click", () => canvas.zoomBy(1 / 1.25));
document.getElementById("zoom-fit")?.addEventListener("click", () => canvas.zoomToFit());
document.getElementById("fullscreen")?.addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
});

// Read the real connection state directly (robust to provider event quirks),
// refreshed on events + a 1 s poll so the readout never sticks.
function updateConn(): void {
  const connected = provider.wsconnected;
  store
    .getState()
    .setStatus(
      connected ? "connected" : provider.wsUnsuccessfulReconnects > 1 ? "disconnected" : "connecting",
    );
  syncedEl.textContent = provider.synced ? "synced" : connected ? "syncing…" : "—";
}
provider.on("status", updateConn);
provider.on("sync", updateConn);
provider.awareness.on("change", () => {
  store.getState().setConnections(provider.awareness.getStates().size);
  updateConn();
});
window.setInterval(updateConn, 1000);
updateConn();

function byTestId(id: string): HTMLElement {
  const el = app!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing [data-testid="${id}"]`);
  return el;
}
