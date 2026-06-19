import "./styles.css";
import { PartySocket } from "partysocket";
import { PARTY, roomIdFromUrl, type ServerMessage } from "@coboard/shared";
import { createAppStore } from "./store";

// ---------------------------------------------------------------------------
// Theme: default to the OS preference, follow it until the user picks one,
// then persist that choice to localStorage.
// ---------------------------------------------------------------------------
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
applyTheme(theme); // set before first paint to avoid a flash

// ---------------------------------------------------------------------------
// Lucide-style inline icons (the real toolbar + icons are built out in M1).
// ---------------------------------------------------------------------------
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

const TOOLS: ReadonlyArray<readonly [icon: string, key: string, label: string]> = [
  ["select", "v", "Select"],
  ["hand", "h", "Hand"],
  ["pen", "p", "Pen"],
  ["sticky", "s", "Sticky note"],
  ["text", "t", "Text"],
  ["rect", "r", "Rectangle"],
  ["ellipse", "o", "Ellipse"],
];

// ---------------------------------------------------------------------------
// Render the M0 shell.
// ---------------------------------------------------------------------------
const room = roomIdFromUrl(new URL(window.location.href));
const store = createAppStore(room);
const host = import.meta.env.VITE_WORKER_HOST ?? "127.0.0.1:8787";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root missing");

app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="logo">◳</span> Coboard</div>
    <div class="room" data-testid="room"><span class="dot" data-testid="dot"></span> room <strong>${room}</strong></div>
    <div class="spacer"></div>
    <div class="devstatus" title="M0 dev readout — replaced by real presence UI in M1">
      WS <b data-testid="status">connecting…</b> · RTT <b data-testid="rtt">—</b> · peers <b data-testid="peers">0</b>
    </div>
    <button class="iconbtn" id="theme-toggle" type="button" aria-label="Toggle light / dark theme"></button>
  </header>
  <aside class="dock" aria-label="Tools (placeholder — M1)">
    ${TOOLS.map(
      ([name, key, label], i) =>
        `<button class="tool${i === 0 ? " active" : ""}" type="button" title="${label} (${key.toUpperCase()})" aria-label="${label}">${icon(name)}</button>`,
    ).join("")}
  </aside>
  <main class="canvas">
    <p class="hint">M0 foundations — the realtime canvas core lands in M1.<br />
    Open this link in a second tab to watch <b>peers</b> rise and the WS echo round-trip.</p>
  </main>
`;

// ---------------------------------------------------------------------------
// Theme toggle wiring.
// ---------------------------------------------------------------------------
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
// Follow the OS theme until the user has explicitly chosen one.
darkMedia.addEventListener("change", () => {
  if (storedTheme()) return;
  theme = systemTheme();
  applyTheme(theme);
  syncThemeBtn();
});

// ---------------------------------------------------------------------------
// Realtime: connect to the room's Durable Object and round-trip a ping/echo.
// (M0 dev readout; M1 replaces this with presence + the Yjs canvas.)
// ---------------------------------------------------------------------------
const statusEl = byTestId("status");
const rttEl = byTestId("rtt");
const peersEl = byTestId("peers");
const dotEl = byTestId("dot");

store.subscribe((state) => {
  statusEl.textContent = state.status;
  dotEl.dataset.state = state.status;
  rttEl.textContent = state.rttMs === null ? "—" : `${state.rttMs} ms`;
  peersEl.textContent = String(state.connections);
});

const socket = new PartySocket({ host, party: PARTY, room });

socket.addEventListener("open", () => {
  store.getState().setStatus("connected");
  ping();
});
socket.addEventListener("close", () => store.getState().setStatus("disconnected"));
socket.addEventListener("error", () => store.getState().setStatus("disconnected"));
socket.addEventListener("message", (event: MessageEvent) => {
  let msg: ServerMessage;
  try {
    msg = JSON.parse(String(event.data)) as ServerMessage;
  } catch {
    return;
  }
  if (msg.type === "welcome") store.getState().setConnections(msg.connections);
  if (msg.type === "echo") store.getState().setRtt(Date.now() - msg.t);
});

function ping(): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ type: "ping", t: Date.now() }));
  }
}
window.setInterval(ping, 3000);

function byTestId(id: string): HTMLElement {
  const el = app!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing [data-testid="${id}"]`);
  return el;
}
