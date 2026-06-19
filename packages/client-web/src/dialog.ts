/**
 * <co-dialog> — a reusable modal dialog as a standards-based Web Component
 * (custom element), wrapping the native <dialog> for free accessibility
 * (focus-trap, Esc, inert background) and fully custom styling/animation
 * (see the `.dialog` rules in styles.css).
 *
 * Deliberately LIGHT DOM (no Shadow DOM): components share Coboard's global
 * design system — the CSS tokens (--accent, --surface, …) AND utility classes
 * (.btn-primary, .swatches, .kbd, …). Shadow DOM would wall those class
 * selectors off and force per-component style duplication (CSS custom
 * properties pierce the boundary, but class selectors do not).
 *
 * Usage (declarative):
 *   <co-dialog title="…"> …body… <button slot="footer" data-dialog-close>Close</button> </co-dialog>
 * Usage (programmatic):  createDialog({ title, body, footer, width, onClose })
 * Any element with [data-dialog-close] closes the dialog.
 */
export class CoDialog extends HTMLElement {
  private dialog?: HTMLDialogElement;

  connectedCallback(): void {
    if (this.dialog) return; // already upgraded

    const footer: Element[] = [];
    const body: Element[] = [];
    for (const child of Array.from(this.children)) {
      if (child.getAttribute("slot") === "footer") {
        child.removeAttribute("slot");
        footer.push(child);
      } else {
        body.push(child);
      }
    }

    const dialog = document.createElement("dialog");
    dialog.className = "dialog";
    dialog.tabIndex = -1; // focus target when no field claims focus (see open())
    const width = this.getAttribute("width");
    if (width) dialog.style.width = `${width}px`;
    dialog.innerHTML =
      '<div class="dialog-head"><span class="dialog-title"></span>' +
      '<button type="button" class="modal-x" data-dialog-close aria-label="Close">✕</button></div>' +
      '<div class="dialog-body"></div>';

    const titleEl = dialog.querySelector<HTMLElement>(".dialog-title");
    if (titleEl) titleEl.textContent = this.getAttribute("title") ?? "";
    const bodyEl = dialog.querySelector<HTMLElement>(".dialog-body");
    body.forEach((el) => bodyEl?.appendChild(el));
    if (footer.length) {
      const foot = document.createElement("div");
      foot.className = "dialog-foot";
      footer.forEach((el) => foot.appendChild(el));
      dialog.appendChild(foot);
    }

    this.appendChild(dialog);
    this.dialog = dialog;

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) this.close(); // backdrop click
    });
    dialog
      .querySelectorAll("[data-dialog-close]")
      .forEach((b) => b.addEventListener("click", () => this.close()));
    dialog.addEventListener("close", () => this.dispatchEvent(new Event("dialogclose")));
  }

  open(): void {
    if (!this.dialog || this.dialog.open) return;
    this.dialog.showModal();
    // showModal() autofocuses the first focusable child (our ✕). Unless the caller
    // marked a field with [autofocus], move focus to the dialog so the close button
    // doesn't open highlighted.
    if (!this.dialog.querySelector("[autofocus]")) this.dialog.focus();
  }
  close(): void {
    if (this.dialog?.open) this.dialog.close();
  }
  toggle(): void {
    if (this.dialog?.open) this.close();
    else this.open();
  }
  get isOpen(): boolean {
    return this.dialog?.open ?? false;
  }
  setTitle(title: string): void {
    const t = this.dialog?.querySelector<HTMLElement>(".dialog-title");
    if (t) t.textContent = title;
  }
}

if (!customElements.get("co-dialog")) customElements.define("co-dialog", CoDialog);

export interface DialogOptions {
  title: string;
  body: string | HTMLElement;
  /** Footer content (e.g. buttons). Each top-level element is placed in the footer row. */
  footer?: string | HTMLElement;
  width?: number;
  onClose?: () => void;
}

/** Build a <co-dialog> programmatically and attach it to the document. */
export function createDialog(opts: DialogOptions): CoDialog {
  const el = document.createElement("co-dialog") as CoDialog;
  el.setAttribute("title", opts.title);
  if (opts.width) el.setAttribute("width", String(opts.width));
  appendContent(el, opts.body, null);
  if (opts.footer !== undefined) appendContent(el, opts.footer, "footer");
  document.body.appendChild(el); // triggers connectedCallback → builds the dialog
  if (opts.onClose) el.addEventListener("dialogclose", opts.onClose);
  return el;
}

function appendContent(
  host: HTMLElement,
  content: string | HTMLElement,
  slot: string | null,
): void {
  const tmp = document.createElement("div");
  if (typeof content === "string") tmp.innerHTML = content;
  else tmp.appendChild(content);
  for (const child of Array.from(tmp.children)) {
    if (slot) child.setAttribute("slot", slot);
    host.appendChild(child);
  }
}
