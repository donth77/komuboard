/**
 * Singleton hover/focus tooltip.
 *
 * Rendered as ONE element appended to <body> at the very top of the stacking order, so the
 * pill is always painted above every chrome layer no matter which stacking context the
 * hovered element belongs to. The previous approach (a ::after pseudo on each [data-tip])
 * was trapped inside its host's stacking context — e.g. a top-bar pill could be painted
 * behind a side panel. A body-level element at max z-index sidesteps that entirely (the same
 * reason the colour-picker popover, appended to <body>, always wins). See styles.css `.komu-tip`.
 *
 * Any element carrying [data-tip] opts in. The pill prefers to sit above the element and
 * auto-flips below when the element hugs the top edge; it's clamped to the viewport so it
 * never clips off an edge (this subsumes the avatar row's old below/right-anchor CSS). A small
 * tail tracks the element's centre. Suppressed inside modal dialogs and for [data-tip].tip-off
 * elements — the aria-label stays, so screen readers are unaffected (data-tip is visual only).
 */

const GAP = 8; // px between the element and the pill
const PAD = 6; // px min gap from the viewport edges when clamping
const TAIL = 8; // px the tail stays in from the pill's corners

let tip: HTMLDivElement | null = null;
let anchor: HTMLElement | null = null;

function pill(): HTMLDivElement {
  if (tip) return tip;
  tip = document.createElement("div");
  tip.className = "komu-tip";
  tip.setAttribute("role", "tooltip");
  // A manual popover renders in the browser TOP LAYER — above a modal <dialog> (showModal), which a
  // huge z-index can't beat. So tooltips inside the profile dialog (etc.) are actually visible.
  tip.setAttribute("popover", "manual");
  document.body.appendChild(tip);
  return tip;
}

function suppressed(el: HTMLElement): boolean {
  if (el.classList.contains("tip-off")) return true; // explicit opt-out
  // A focused editing surface (modal dialog) keeps the pill hidden — EXCEPT where a region opts back
  // in via [data-tip-in-dialog] (e.g. the profile colour swatches, where the name is the point).
  return !!el.closest(".dialog") && !el.closest("[data-tip-in-dialog]");
}

function place(): void {
  if (!tip || !anchor) return;
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Beside the element (data-tip-pos="right") — for a vertical toolbar, where above/below would
  // overlap neighbours. Sits to the right, flips left if it'd clip the edge; centred vertically.
  if (anchor.getAttribute("data-tip-pos") === "right") {
    let left = a.right + GAP;
    let sideLeft = false;
    if (left + t.width > vw - PAD) {
      left = a.left - t.width - GAP;
      sideLeft = true;
    }
    const centerY = a.top + a.height / 2;
    const top = Math.max(PAD, Math.min(centerY - t.height / 2, vh - t.height - PAD));
    const tailY = Math.max(TAIL, Math.min(centerY - top, t.height - TAIL));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.setProperty("--tail-y", `${Math.round(tailY)}px`);
    tip.classList.add("side");
    tip.classList.toggle("side-left", sideLeft);
    tip.classList.remove("below");
    return;
  }
  // Default: above the element, flipping below near the top edge; centred + clamped horizontally.
  let top = a.top - t.height - GAP;
  let below = false;
  if (top < PAD) {
    top = a.bottom + GAP; // …flip below when it would clip the top edge
    below = true;
  }
  const centerX = a.left + a.width / 2;
  const left = Math.max(PAD, Math.min(centerX - t.width / 2, vw - t.width - PAD));
  // Tail points at the element's centre, kept on the pill after the edge-clamp above.
  const tailX = Math.max(TAIL, Math.min(centerX - left, t.width - TAIL));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.style.setProperty("--tail-x", `${Math.round(tailX)}px`);
  tip.classList.toggle("below", below);
  tip.classList.remove("side", "side-left");
}

function show(el: HTMLElement): void {
  const text = el.getAttribute("data-tip");
  if (!text || suppressed(el)) {
    hide();
    return;
  }
  anchor = el;
  const p = pill();
  p.textContent = text;
  // Optional keyboard-shortcut hint → one <kbd> chip per whitespace-separated token (e.g. "⌘ +").
  const keys = el.getAttribute("data-tip-key");
  if (keys) {
    for (const k of keys.split(/\s+/)) {
      if (!k) continue;
      const kbd = document.createElement("kbd");
      kbd.className = "kbd";
      kbd.textContent = k;
      p.append(" ", kbd);
    }
  }
  p.classList.add("show"); // display it (also the fallback path on browsers without the Popover API)
  // …then promote to the top layer so it paints above a modal <dialog> (showModal), which no
  // z-index can beat. Done after display so it's rendered when it enters the top layer.
  if (typeof p.showPopover === "function" && !p.matches(":popover-open")) {
    try {
      p.showPopover();
    } catch {
      /* already open / unsupported → the z-index path above still covers non-dialog tooltips */
    }
  }
  place(); // measure + position last (the pill is displayed + in the top layer by now)
}

function hide(): void {
  anchor = null;
  if (!tip) return;
  tip.classList.remove("show");
  if (typeof tip.hidePopover === "function" && tip.matches(":popover-open")) {
    try {
      tip.hidePopover();
    } catch {
      /* not open → ignore */
    }
  }
}

function tipTarget(e: Event): HTMLElement | null {
  return (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-tip]") ?? null;
}

// Pointer: show on entering a [data-tip] element, hide when leaving it for a non-tip target.
document.addEventListener("pointerover", (e) => {
  const el = tipTarget(e);
  if (el) {
    if (el !== anchor) show(el);
  } else if (anchor) {
    hide();
  }
});
// Keyboard parity — only on a real focus ring (:focus-visible), so a mouse click doesn't
// leave a pill stuck after the element takes focus.
document.addEventListener("focusin", (e) => {
  const el = tipTarget(e);
  if (el && el.matches(":focus-visible")) show(el);
});
document.addEventListener("focusout", () => hide());
// Anything that shifts layout under a shown pill would strand it — dismiss on these.
window.addEventListener("pointerdown", () => hide(), true);
window.addEventListener("scroll", () => hide(), true);
window.addEventListener("resize", () => hide());

export {}; // side-effecting module (imported once for its listeners)
