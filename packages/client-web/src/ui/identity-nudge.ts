// First-run identity nudge — a small, dismissible card inviting a brand-new (auto-named) visitor to
// set their display name + color. Deliberately NOT a pre-join modal: docs/06 commits to "land
// anonymous users directly in a room — no modal/signup", so the board is never gated. This just
// makes the existing profile editor discoverable, which matters because the presence row (your
// clickable avatar) is hidden when you're alone — so a first-time solo visitor would otherwise have
// to dig into the menu to find it. Shows at most once per browser and auto-dismisses.

const SEEN_KEY = "komuboard-identity-nudged";
const AUTO_DISMISS_MS = 9000;

export interface IdentityNudgeOpts {
  /** The current (auto-assigned) display name to show. */
  name: string;
  /** The identity color, shown as a dot. */
  color: string;
  /** True only when the identity was auto-generated this visit (never customized). */
  fresh: boolean;
  /** Open the profile editor (wired to the existing dialog in main.ts). */
  onEdit: () => void;
}

/** Show the nudge once, for a fresh identity that hasn't seen it yet. No-op otherwise. */
export function maybeShowIdentityNudge(opts: IdentityNudgeOpts): void {
  if (!opts.fresh || hasSeen()) return;
  markSeen(); // set up front so a reload before dismissal won't replay it

  const card = document.createElement("div");
  card.className = "identity-nudge";
  card.setAttribute("role", "status");
  card.setAttribute("aria-live", "polite");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "identity-nudge-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";

  const dot = document.createElement("span");
  dot.className = "identity-nudge-dot";
  dot.style.background = opts.color;

  const line = document.createElement("p");
  line.className = "identity-nudge-line";
  const who = document.createElement("b");
  who.textContent = opts.name;
  line.append("You're ", who);

  const hint = document.createElement("p");
  hint.className = "identity-nudge-hint";
  hint.textContent = "Set a name and color others will see.";

  const text = document.createElement("div");
  text.className = "identity-nudge-text";
  text.append(line, hint);

  const row = document.createElement("div");
  row.className = "identity-nudge-row";
  row.append(dot, text);

  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "identity-nudge-edit";
  edit.textContent = "Update profile";

  const actions = document.createElement("div");
  actions.className = "identity-nudge-actions";
  actions.append(edit);

  card.append(close, row, actions);
  document.body.appendChild(card);

  let timer = 0;
  const dismiss = (): void => {
    window.clearTimeout(timer);
    card.classList.add("leaving");
    const remove = (): void => card.remove();
    card.addEventListener("transitionend", remove, { once: true });
    window.setTimeout(remove, 320); // fallback if no transitionend fires (reduced motion)
  };

  edit.addEventListener("click", () => {
    dismiss();
    opts.onEdit();
  });
  close.addEventListener("click", dismiss);
  timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);

  requestAnimationFrame(() => card.classList.add("in")); // run the enter transition
}

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false; // storage blocked — fall through and show once this session
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage blocked — nothing to persist */
  }
}
