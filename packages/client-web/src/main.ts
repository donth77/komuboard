import "./styles.css";
import { PartySocket } from "partysocket";
import { PARTY, roomIdFromUrl, type ServerMessage } from "@coboard/shared";
import { createAppStore } from "./store";

const room = roomIdFromUrl(new URL(window.location.href));
const store = createAppStore(room);

// Worker host: dev defaults to local `wrangler dev`; override with VITE_WORKER_HOST in prod.
const host = import.meta.env.VITE_WORKER_HOST ?? "127.0.0.1:8787";

const TOOLS: ReadonlyArray<[key: string, label: string]> = [
  ["v", "Select"],
  ["h", "Hand"],
  ["p", "Pen"],
  ["s", "Sticky"],
  ["t", "Text"],
  ["r", "Rectangle"],
  ["o", "Ellipse"],
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app root missing");

app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="logo">◳</span> Coboard</div>
    <div class="room" data-testid="room"><span class="dot" data-testid="dot"></span> room <strong>${room}</strong></div>
    <div class="status">
      WS <b data-testid="status">connecting…</b>
      · RTT <b data-testid="rtt">—</b>
      · peers <b data-testid="peers">0</b>
    </div>
  </header>
  <aside class="dock" aria-label="Tools (placeholder)">
    ${TOOLS.map(([k, label], i) => `<button class="tool${i === 0 ? " active" : ""}" title="${label} (${k.toUpperCase()})">${k.toUpperCase()}</button>`).join("")}
  </aside>
  <main class="canvas">
    <p class="hint">M0 foundations — the realtime canvas core lands in M1.<br />
    Open this link in a second tab to watch <b>peers</b> rise and the WS echo round-trip.</p>
  </main>
`;

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
// Keep the round-trip warm so the RTT readout stays live.
window.setInterval(ping, 3000);

function byTestId(id: string): HTMLElement {
  const el = app!.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!el) throw new Error(`missing [data-testid="${id}"]`);
  return el;
}
