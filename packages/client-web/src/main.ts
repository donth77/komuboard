import "./styles.css";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { Awareness } from "y-protocols/awareness";
import { PARTY, pickUserColor, roomIdFromUrl, type PresenceState } from "@coboard/shared";
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
const room = roomIdFromUrl(new URL(window.location.href));
const store = createAppStore(room);
const host = import.meta.env.VITE_WORKER_HOST ?? "127.0.0.1:8787";

const ydoc = new Y.Doc();
const provider = new YProvider(host, room, ydoc, { party: PARTY });
const user: PresenceState = {
  name: `Guest ${provider.awareness.clientID % 1000}`,
  color: pickUserColor(provider.awareness.clientID),
};
window.__coboard = { doc: ydoc, provider, awareness: provider.awareness };

// --------------------------------------------------------------------------
// Shell.
// --------------------------------------------------------------------------
const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root missing");

app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="logo">◳</span> Coboard</div>
    <div class="room" data-testid="room"><span class="dot" data-testid="dot"></span> room <strong>${room}</strong></div>
    <div class="spacer"></div>
    <div class="devstatus" title="M1 dev readout — replaced by the presence facepile next">
      WS <b data-testid="status">connecting…</b> · <b data-testid="synced">syncing…</b> · peers <b data-testid="peers">1</b>
    </div>
    <button class="iconbtn" id="theme-toggle" type="button" aria-label="Toggle light / dark theme"></button>
  </header>
  <aside class="dock" aria-label="Tools">
    ${TOOLS.map(
      ([name, key, label, tool]) =>
        `<button class="tool${tool === "pen" ? " active" : ""}${tool ? "" : " disabled"}" type="button" data-tool="${tool ?? ""}" title="${label} (${key.toUpperCase()})${tool ? "" : " — coming soon"}" aria-label="${label}">${icon(name)}</button>`,
    ).join("")}
  </aside>
  <main class="canvas" id="board"></main>
  <div class="hint-chip">Draw with the <b>Pen</b> · scroll to zoom · <b>Hand</b> to pan · open in a 2nd tab to collaborate</div>
`;

// --------------------------------------------------------------------------
// Canvas + tools.
// --------------------------------------------------------------------------
const boardEl = document.getElementById("board");
if (!boardEl) throw new Error("#board missing");
const canvas = new BoardCanvas({ container: boardEl, doc: ydoc, awareness: provider.awareness, user });
canvas.setColor(user.color); // draw in your presence color (a real color picker is next)

const toolButtons = Array.from(app.querySelectorAll<HTMLButtonElement>(".tool[data-tool]"));
for (const btn of toolButtons) {
  const tool = btn.getAttribute("data-tool") as ToolId | "";
  if (!tool) continue;
  btn.addEventListener("click", () => {
    canvas.setTool(tool);
    for (const b of toolButtons) b.classList.toggle("active", b === btn);
  });
}

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
const peersEl = byTestId("peers");
const dotEl = byTestId("dot");

store.subscribe((state) => {
  statusEl.textContent = state.status;
  dotEl.dataset.state = state.status;
  peersEl.textContent = String(Math.max(1, state.connections));
});

provider.on("status", (e: { status: string }) => {
  store.getState().setStatus(e.status === "connected" ? "connected" : e.status === "connecting" ? "connecting" : "disconnected");
});
provider.on("sync", (isSynced: boolean) => {
  syncedEl.textContent = isSynced ? "synced" : "syncing…";
});
provider.awareness.on("change", () => {
  store.getState().setConnections(provider.awareness.getStates().size);
});

function byTestId(id: string): HTMLElement {
  const el = app!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing [data-testid="${id}"]`);
  return el;
}
