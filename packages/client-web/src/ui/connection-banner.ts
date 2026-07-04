// Reconnection banner — a small top-center pill that appears when an *established* connection drops
// ("Reconnecting…") and confirms briefly when it returns ("Back online"). Yjs buffers local edits in
// the doc while offline and resyncs them on reconnect, so this is the visible reassurance that work
// isn't lost, not the mechanism.
//
// It deliberately stays silent during the very first connect (a long initial connect / unreachable
// server is the separate "loading + error room states" slice): the banner only speaks up once we've
// been connected at least once. A short show-delay avoids flashing on sub-second blips.
import type { ConnectionStatus } from "../store";

export interface ConnectionBanner {
  /** Feed the live connection status; the banner manages its own visibility. */
  update(status: ConnectionStatus): void;
}

const SHOW_DELAY_MS = 500; // don't flash the banner on momentary blips
const BACK_ONLINE_MS = 1800; // how long "Back online" lingers before fading

export function createConnectionBanner(): ConnectionBanner {
  let el: HTMLDivElement | null = null;
  let hasConnected = false;
  let showing = false; // a "Reconnecting…" banner is currently up
  let showTimer = 0;
  let hideTimer = 0;

  function ensureEl(): HTMLDivElement {
    if (el) return el;
    const node = document.createElement("div");
    node.className = "conn-banner";
    node.setAttribute("role", "status");
    node.setAttribute("aria-live", "polite");
    document.body.appendChild(node);
    el = node;
    return node;
  }

  function render(mode: "reconnecting" | "online"): void {
    const node = ensureEl();
    node.dataset.mode = mode;
    node.innerHTML =
      mode === "reconnecting"
        ? '<span class="conn-spinner" aria-hidden="true"></span><span>Reconnecting…</span>'
        : '<span class="conn-check" aria-hidden="true">✓</span><span>Back online</span>';
    // Trigger the enter transition SYNCHRONOUSLY (forced reflow), not via requestAnimationFrame:
    // rAF callbacks are paused in a backgrounded tab, so a reconnect while the tab is hidden would
    // defer adding `in` until the tab is refocused — by which point the auto-hide timeout has
    // already fired and removed nothing, leaving the "Back online" pill stuck visible forever.
    void node.offsetWidth; // reflow from the hidden state so opacity/transform animate in
    node.classList.add("in");
  }

  function hide(): void {
    el?.classList.remove("in"); // CSS fades it out + flips visibility:hidden (Playwright sees hidden)
  }

  return {
    update(status: ConnectionStatus): void {
      if (status === "connected") {
        hasConnected = true;
        window.clearTimeout(showTimer);
        showTimer = 0;
        if (showing) {
          showing = false;
          render("online"); // brief reassurance, then auto-hide
          window.clearTimeout(hideTimer);
          hideTimer = window.setTimeout(hide, BACK_ONLINE_MS);
        }
        return;
      }
      // Not connected: stay silent until we've had a connection, and debounce momentary blips.
      if (!hasConnected || showing || showTimer) return;
      showTimer = window.setTimeout(() => {
        showTimer = 0;
        showing = true;
        window.clearTimeout(hideTimer);
        render("reconnecting");
      }, SHOW_DELAY_MS);
    },
  };
}
