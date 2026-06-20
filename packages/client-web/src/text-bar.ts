// src/text-bar.ts — the floating rich-text toolbar shown above the active text editor (FigJam-style).
//
// TextLayer owns its lifecycle: show(editor, state) when an editor opens, positionOver() as the
// camera/box moves, reflect(state) on selection change, hide() on commit. The bar lives in
// document.body (position: fixed) so its popovers aren't clipped by the board's overflow.
//
// Marks (bold/italic/underline/strike/colour/highlight/link) are applied with document.execCommand
// on the focused editor — mousedown is preventDefault'd on every control so pressing one never blurs
// the editor (which would commit it). Block props (font family, size, alignment) are per-box, so
// they're routed back through the host; TextLayer updates the box + re-broadcasts the live edit.

import "./color-picker";
import type { CoColorPicker } from "./color-picker";
import { COLOR_NAMES } from "./draw-bar";
import { SWATCHES } from "./palette";
import type { ShapeKind, TextAlign } from "@coboard/shared";

export interface TextBarHost {
  setFontFamily(css: string): void;
  setFontSize(size: number): void;
  toggleBullets(): void;
  /** A mark changed via execCommand → TextLayer re-measures/broadcasts + re-reflects. */
  onFormat(): void;
  /** Shape-mode controls (only used when the box being edited is a shape). */
  setShapeKind(kind: ShapeKind): void;
  setFill(color: string): void;
  setAlign(align: TextAlign): void;
}

export interface TextBarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  bullet: boolean;
  fontFamily: string;
  fontSize: number;
  color: string;
  /** When set, the bar enters shape mode (adds shape-select / fill / align controls). */
  shape?: ShapeKind;
  /** Current shape fill + text alignment (shape mode). */
  fill?: string;
  align?: TextAlign;
}

/** Which colour a colour popover/picker drives: text fore-colour, highlight, or a shape's fill. */
type ColorKind = "fore" | "hilite" | "fill";

interface FontOption {
  label: string;
  css: string;
}
export const TEXT_FONTS: FontOption[] = [
  { label: "Sans", css: "Inter, system-ui, -apple-system, sans-serif" },
  { label: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { label: "Mono", css: "'SF Mono', ui-monospace, Menlo, monospace" },
  { label: "Handwriting", css: "'Caveat', 'Comic Sans MS', cursive" },
];
// Named size presets (FigJam-style) + a numeric input for an exact value.
const SIZE_PRESETS: { label: string; size: number }[] = [
  { label: "Small", size: 16 },
  { label: "Medium", size: 24 },
  { label: "Large", size: 40 },
  { label: "Extra large", size: 64 },
  { label: "Huge", size: 96 },
];
// Highlight palette: "none" + pastels (a custom swatch opens the picker). Text color reuses the
// shared SWATCHES — the same options the draw tool offers.
// "" = none, then a warm→cool pastel spectrum (8 colours → two full rows of 5 with none + custom).
const HIGHLIGHTS = [
  "",
  "#ffec99",
  "#ffd8a8",
  "#ffc9c9",
  "#fcc2d7",
  "#eebefa",
  "#a5d8ff",
  "#99e9f2",
  "#b2f2bb",
];
const HIGHLIGHT_NAMES: Record<string, string> = {
  "#FFEC99": "Yellow",
  "#FFD8A8": "Orange",
  "#FFC9C9": "Red",
  "#FCC2D7": "Pink",
  "#EEBEFA": "Purple",
  "#A5D8FF": "Blue",
  "#99E9F2": "Cyan",
  "#B2F2BB": "Green",
};

const SVG = {
  link: '<path d="M9 11a3.5 3.5 0 0 0 5 .4l2-2a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11 9a3.5 3.5 0 0 0-5-.4l-2 2a3.5 3.5 0 0 0 5 5l1-1"/>',
  list: '<path d="M7.5 5.5h9M7.5 10h9M7.5 14.5h9"/><circle cx="3.6" cy="5.5" r="1.1"/><circle cx="3.6" cy="10" r="1.1"/><circle cx="3.6" cy="14.5" r="1.1"/>',
  // "type"/text-style glyph for the mobile marks group toggle (a serif capital T).
  type: '<path d="M4.5 5.5h11"/><path d="M10 5.5v9.5"/><path d="M8 15h4"/>',
};
// Shape glyphs for the shape-select control + its popover (drawable shapes only).
const SHAPE_SVG: Record<ShapeKind, string> = {
  rectangle: '<rect x="3.5" y="5" width="13" height="10" rx="1.2"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="7" ry="5.5"/>',
  rhombus: '<path d="M10 3 17 10 10 17 3 10z"/>',
  triangle: '<path d="M10 4 17 16H3z"/>',
  divider: '<path d="M3 10h14"/>',
};
const SHAPE_NAMES: Record<ShapeKind, string> = {
  rectangle: "Rectangle",
  ellipse: "Oval",
  rhombus: "Rhombus",
  triangle: "Triangle",
  divider: "Divider",
};
const SHAPE_ORDER: ShapeKind[] = ["rectangle", "ellipse", "rhombus", "triangle", "divider"];
// Text-alignment glyphs (left / center / right).
const ALIGN_SVG: Record<TextAlign, string> = {
  left: '<path d="M4 5.5h12M4 10h8M4 14.5h11"/>',
  center: '<path d="M4 5.5h12M6 10h8M5 14.5h10"/>',
  right: '<path d="M4 5.5h12M8 10h8M5 14.5h11"/>',
};
function ico(path: string): string {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
// Remove-link (broken-chain) icon for the link editor — Lucide "unlink", a 24×24 viewBox.
const UNLINK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/></svg>';
function fontLabelFor(css: string): string {
  return TEXT_FONTS.find((f) => f.css === css)?.label ?? "Font";
}
/** A named preset's label when the size matches one (Small/Medium/…), else the raw number. */
function sizeLabelFor(size: number): string {
  return SIZE_PRESETS.find((p) => p.size === Math.round(size))?.label ?? String(Math.round(size));
}

export class TextBar {
  readonly root: HTMLDivElement;
  private editor: HTMLElement | null = null;
  private pop: HTMLDivElement | null = null;
  private readonly fontLabel: HTMLElement;
  private readonly sizeLabel: HTMLElement;
  private state: TextBarState | null = null;
  private picker: CoColorPicker | null = null;
  private pickerKind: ColorKind = "fore";
  private pickerRange: Range | null = null;
  /** Close the custom picker when clicking anywhere outside it + the toolbar. */
  private readonly onDocDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (
      this.picker &&
      !this.picker.classList.contains("hidden") &&
      !this.picker.contains(t) &&
      !this.root.contains(t)
    ) {
      this.hidePicker();
    }
  };

  constructor(private readonly host: TextBarHost) {
    const el = document.createElement("div");
    el.className = "co-text-bar";
    el.style.display = "none";
    el.innerHTML =
      // Shape-only leading controls: shape-select + fill colour (shown only in shape mode).
      `<button class="ctb-btn ctb-shape-only ctb-shape-kind" data-act="shape-kind" data-tip="Shape"><span class="ctb-shape-ico">${ico(SHAPE_SVG.rectangle)}</span><span class="ctb-caret">▾</span></button>` +
      `<button class="ctb-btn ctb-shape-only ctb-fill" data-act="fill" data-tip="Fill color"><span class="ctb-fill-dot" data-fill></span><span class="ctb-caret">▾</span></button>` +
      `<span class="ctb-sep ctb-shape-only"></span>` +
      `<button class="ctb-text" data-act="font" data-tip="Font"><span class="ctb-font-label">Sans</span><span class="ctb-caret">▾</span></button>` +
      `<button class="ctb-text" data-act="size" data-tip="Font size"><span class="ctb-size-label">Large</span><span class="ctb-caret">▾</span></button>` +
      `<span class="ctb-sep"></span>` +
      // B/I/U/S — inline on desktop; on mobile they collapse behind one toggle that expands a
      // vertical flyout (saves the width that was making the toolbar overflow on phones).
      `<span class="ctb-marks">` +
      `<button class="ctb-btn ctb-marks-toggle" data-act="marks" data-tip="Text style">${ico(SVG.type)}<span class="ctb-caret">▾</span></button>` +
      `<span class="ctb-marks-menu">` +
      `<button class="ctb-btn ctb-b" data-mark="bold" data-tip="Bold">B</button>` +
      `<button class="ctb-btn ctb-i" data-mark="italic" data-tip="Italic">I</button>` +
      `<button class="ctb-btn ctb-u" data-mark="underline" data-tip="Underline">U</button>` +
      `<button class="ctb-btn ctb-strike" data-mark="strike" data-tip="Strikethrough">S</button>` +
      `</span>` +
      `</span>` +
      `<span class="ctb-sep"></span>` +
      `<button class="ctb-btn" data-act="bullet" data-tip="Bulleted list">${ico(SVG.list)}</button>` +
      `<button class="ctb-btn" data-act="link" data-tip="Link">${ico(SVG.link)}</button>` +
      `<span class="ctb-sep"></span>` +
      `<button class="ctb-btn ctb-color" data-act="color" data-tip="Text color"><span class="ctb-a">A</span><span class="ctb-underbar" data-swatch></span></button>` +
      `<button class="ctb-btn ctb-hl" data-act="highlight" data-tip="Highlight"><span class="ctb-hl-box" data-hlswatch></span></button>` +
      // Shape-only trailing control: text alignment (matters for shapes' centred labels).
      `<span class="ctb-sep ctb-shape-only"></span>` +
      `<button class="ctb-btn ctb-shape-only ctb-align" data-act="align" data-tip="Alignment"><span class="ctb-align-ico">${ico(ALIGN_SVG.center)}</span><span class="ctb-caret">▾</span></button>`;
    document.body.appendChild(el);
    this.root = el;
    this.fontLabel = el.querySelector(".ctb-font-label") as HTMLElement;
    this.sizeLabel = el.querySelector(".ctb-size-label") as HTMLElement;
    this.wire();
  }

  private wire(): void {
    // Keep the editor focused + its selection intact when a control is pressed.
    this.root.addEventListener("mousedown", (e) => e.preventDefault());
    this.root.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!btn) return;
      // Pressing anything outside the marks group collapses its mobile flyout.
      if (!btn.closest(".ctb-marks")) this.closeMarks();
      if (btn.dataset.mark) return this.applyMark(btn.dataset.mark);
      switch (btn.dataset.act) {
        case "marks":
          return this.toggleMarks();
        case "font":
          return this.openFontPop(btn);
        case "size":
          return this.openSizePop(btn);
        case "bullet":
          return this.host.toggleBullets();
        case "link":
          return this.openLinkPop(btn);
        case "color":
          return this.openColorPop(btn, "fore");
        case "highlight":
          return this.openColorPop(btn, "hilite");
        case "shape-kind":
          return this.openShapePop(btn);
        case "fill":
          return this.openColorPop(btn, "fill");
        case "align":
          return this.openAlignPop(btn);
      }
    });
  }

  /** Expand/collapse the mobile B/I/U/S flyout. */
  private toggleMarks(): void {
    this.root.querySelector(".ctb-marks")?.classList.toggle("open");
  }
  private closeMarks(): void {
    this.root.querySelector(".ctb-marks")?.classList.remove("open");
  }

  private applyMark(mark: string): void {
    this.closePop();
    this.editor?.focus();
    document.execCommand(mark === "strike" ? "strikeThrough" : mark, false);
    this.host.onFormat();
  }

  private applyColor(kind: ColorKind, hex: string, savedRange?: Range): void {
    if (kind === "fill") {
      // Shape fill is a block prop (no execCommand / selection) — route straight to the host.
      this.host.setFill(hex || "#ffffff");
      return;
    }
    this.editor?.focus();
    if (savedRange) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(savedRange);
    }
    document.execCommand("styleWithCSS", false, "true");
    if (kind === "fore") document.execCommand("foreColor", false, hex || "#0e1116");
    else document.execCommand("hiliteColor", false, hex || "transparent");
    this.host.onFormat();
  }

  /** Colour popover matching the draw tool: the shared swatches (.sw) + a custom-colour picker. */
  private openColorPop(anchor: HTMLElement, kind: ColorKind): void {
    const id = kind === "fore" ? "color" : kind === "fill" ? "fill" : "highlight";
    if (this.pop?.dataset.for === id) {
      this.closePop();
      return;
    }
    this.closePop();
    const colors = kind === "hilite" ? HIGHLIGHTS : SWATCHES; // fore + fill share the full palette
    const names = kind === "hilite" ? HIGHLIGHT_NAMES : COLOR_NAMES;
    // Ring the active swatch. Foreground tracks `color`; fill tracks `fill`; highlight none.
    const cur =
      (kind === "fore"
        ? this.state?.color
        : kind === "fill"
          ? this.state?.fill
          : ""
      )?.toLowerCase() ?? "";
    const sw = colors
      .map((c) =>
        c
          ? `<button class="sw${c.toLowerCase() === cur ? " on" : ""}" type="button" data-color="${c}" data-tip="${names[c.toUpperCase()] ?? c}" style="--sw:${c}"></button>`
          : `<button class="sw sw-none" type="button" data-color="" data-tip="None"></button>`,
      )
      .join("");
    const customOn = !!cur && !colors.some((c) => c.toLowerCase() === cur);
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-color-pop";
    pop.dataset.for = id;
    pop.innerHTML = `<div class="swatches" data-swatches>${sw}<button class="sw sw-custom${customOn ? " on" : ""}" type="button" data-custom data-tip="Custom"></button></div>`;
    const grid = pop.querySelector("[data-swatches]") as HTMLElement;
    grid.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor's selection alive
    grid.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".sw");
      if (!t) return;
      if (t.hasAttribute("data-custom")) return this.openPicker(kind, anchor);
      this.applyColor(kind, t.getAttribute("data-color") ?? "");
      this.closePop();
    });
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 220;
    pop.style.left = `${Math.max(8, Math.min(ar.left + ar.width / 2 - pw / 2, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${ar.bottom + 6}px`;
    this.pop = pop;
  }

  /** Shape-kind popover (shape mode): a grid of the drawable shapes; picking changes the box's kind. */
  private openShapePop(anchor: HTMLElement): void {
    if (this.pop?.dataset.for === "shape-kind") {
      this.closePop();
      return;
    }
    this.closePop();
    const cur = this.state?.shape;
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-shape-pop";
    pop.dataset.for = "shape-kind";
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    pop.innerHTML = SHAPE_ORDER.map(
      (k) =>
        `<button class="ctb-shape-opt${k === cur ? " on" : ""}" type="button" data-kind="${k}" data-tip="${SHAPE_NAMES[k]}">${ico(SHAPE_SVG[k])}</button>`,
    ).join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
      if (!b) return;
      this.host.setShapeKind(b.getAttribute("data-kind") as ShapeKind);
      this.closePop();
    });
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 200;
    pop.style.left = `${Math.max(8, Math.min(ar.left, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${ar.bottom + 6}px`;
    this.pop = pop;
  }

  /** Alignment popover (shape mode): left / center / right for the shape's label. */
  private openAlignPop(anchor: HTMLElement): void {
    if (this.pop?.dataset.for === "align") {
      this.closePop();
      return;
    }
    this.closePop();
    const cur = this.state?.align ?? "center";
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-align-pop";
    pop.dataset.for = "align";
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    const aligns: TextAlign[] = ["left", "center", "right"];
    pop.innerHTML = aligns
      .map(
        (a) =>
          `<button class="ctb-align-opt${a === cur ? " on" : ""}" type="button" data-align="${a}" data-tip="${a[0]!.toUpperCase() + a.slice(1)}">${ico(ALIGN_SVG[a])}</button>`,
      )
      .join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-align]");
      if (!b) return;
      this.host.setAlign(b.getAttribute("data-align") as TextAlign);
      this.closePop();
    });
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 130;
    pop.style.left = `${Math.max(8, Math.min(ar.left + ar.width / 2 - pw / 2, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${ar.bottom + 6}px`;
    this.pop = pop;
  }

  /** The shared <co-color-picker> for an arbitrary colour (reuses the draw tool's picker). */
  private openPicker(kind: ColorKind, anchor: HTMLElement): void {
    const sel = window.getSelection();
    this.pickerRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null; // save before focus moves
    this.pickerKind = kind;
    this.closePop();
    if (!this.picker) {
      this.picker = document.createElement("co-color-picker") as CoColorPicker;
      document.body.appendChild(this.picker);
      this.picker.addEventListener("color-change", (e) => {
        const color = (e as CustomEvent<{ color: string }>).detail.color;
        this.applyColor(this.pickerKind, color, this.pickerRange ?? undefined);
        const s = window.getSelection();
        if (s && s.rangeCount) this.pickerRange = s.getRangeAt(0).cloneRange(); // keep the range valid
      });
    }
    this.picker.value =
      (this.pickerKind === "fill" ? this.state?.fill : this.state?.color) || "#0e1116";
    this.picker.classList.remove("hidden");
    const r = anchor.getBoundingClientRect();
    const pw = this.picker.offsetWidth || 232;
    this.picker.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - pw - 8))}px`;
    this.picker.style.top = `${r.bottom + 6}px`;
    document.addEventListener("pointerdown", this.onDocDown);
  }

  /** The link `<a>` the current selection sits in (or null) — so the link button can branch. */
  private currentLink(): HTMLAnchorElement | null {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !this.editor) return null;
    const up = (n: Node | null): HTMLAnchorElement | null => {
      let el: Node | null = n;
      while (el && el !== this.editor) {
        if (el.nodeType === Node.ELEMENT_NODE && (el as HTMLElement).tagName === "A")
          return el as HTMLAnchorElement;
        el = el.parentNode;
      }
      return null;
    };
    const range = sel.getRangeAt(0);
    return up(range.startContainer) ?? up(range.endContainer) ?? up(sel.anchorNode);
  }

  /** Select a link's full contents so createLink/unlink act on the whole thing. */
  private selectLinkContents(link: HTMLAnchorElement): void {
    this.editor?.focus();
    const range = document.createRange();
    range.selectNodeContents(link);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(range);
  }

  private linkBtn(): HTMLElement {
    return this.root.querySelector<HTMLElement>('[data-act="link"]') ?? this.root;
  }

  /** Link button: the floating URL editor — prefilled with a remove-link (unlink) icon when the
   *  selection is already linked, an empty "type a URL" field otherwise. */
  private openLinkPop(anchor: HTMLElement): void {
    if (this.pop?.dataset.for === "link") {
      this.closePop();
      this.editor?.focus();
      return;
    }
    const link = this.currentLink();
    if (link) this.openLinkInput(anchor, link.getAttribute("href") ?? "", link);
    else this.openLinkInput(anchor, "");
  }

  /** The floating "Type or paste URL" field above the box (no native dialog). When `editLink` is
   *  given the field is prefilled, the new URL replaces that link's href, and a remove-link icon
   *  (which unlinks the text) sits beside it. */
  private openLinkInput(anchor: HTMLElement, prefill: string, editLink?: HTMLAnchorElement): void {
    this.closePop();
    this.root.style.display = "none"; // hide the toolbar so the link input doesn't overlap it
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null; // the text to link
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-link-pop";
    pop.dataset.for = "link";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ctb-link-input";
    input.placeholder = "Type or paste URL";
    input.spellcheck = false;
    input.value = prefill;
    let done = false;
    const finish = (apply: boolean, remove = false): void => {
      if (done) return;
      done = true;
      this.root.style.display = ""; // bring the toolbar back
      const url = input.value.trim();
      this.closePop();
      this.editor?.focus();
      if (editLink && editLink.isConnected) this.selectLinkContents(editLink);
      else if (saved) {
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(saved);
      }
      if (remove) {
        document.execCommand("unlink", false);
        this.host.onFormat();
      } else if (apply && url) {
        document.execCommand("createLink", false, url);
        if (!editLink) {
          // A brand-new link gets the default link look: blue (from CSS) + an underline mark.
          // It's a real, toggleable mark (links carry no UA underline), so U still turns it off.
          document.execCommand("styleWithCSS", false, "true");
          if (!document.queryCommandState("underline")) document.execCommand("underline", false);
        }
        this.host.onFormat();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(false));
    pop.appendChild(input);
    if (editLink) {
      // Editing an existing link → a remove-link (unlink) icon strips the link, FigJam-style.
      const sep = document.createElement("span");
      sep.className = "ctb-link-sep";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "ctb-link-unlink";
      rm.setAttribute("data-tip", "Remove link");
      rm.innerHTML = UNLINK_ICON;
      rm.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur the input first
      rm.addEventListener("click", () => finish(false, true));
      pop.append(sep, rm);
    }
    document.body.appendChild(pop);
    const er = this.editor?.getBoundingClientRect();
    const pw = pop.offsetWidth || 300;
    if (er) {
      pop.style.left = `${Math.max(8, er.left + er.width / 2 - pw / 2)}px`;
      pop.style.top = `${Math.max(8, er.top - pop.offsetHeight - 12)}px`;
    } else {
      const ar = anchor.getBoundingClientRect();
      pop.style.left = `${ar.left}px`;
      pop.style.top = `${ar.bottom + 4}px`;
    }
    this.pop = pop;
    input.focus();
    if (prefill) input.select();
  }

  /** Select a link's text and open the URL input prefilled — the toolbar's Edit + the hover card
   *  (driven by TextLayer) both route here. Assumes `link` lives in the active editor. */
  editLink(link: HTMLAnchorElement): void {
    this.selectLinkContents(link);
    this.openLinkInput(this.linkBtn(), link.getAttribute("href") ?? "", link);
  }

  // ---- popovers ----
  private openPop(
    anchor: HTMLElement,
    grid: boolean,
    items: { html: string; on: () => void }[],
  ): void {
    const reopening = this.pop?.dataset.for === anchor.dataset.act;
    this.closePop();
    if (reopening) return; // clicking the same control again just closes it
    const pop = document.createElement("div");
    pop.className = grid ? "ctb-pop ctb-pop-grid" : "ctb-pop";
    pop.dataset.for = anchor.dataset.act ?? "";
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "ctb-pop-item";
      b.innerHTML = it.html;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        it.on();
        this.closePop();
      });
      pop.appendChild(b);
    }
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    pop.style.left = `${ar.left}px`;
    pop.style.top = `${ar.bottom + 4}px`;
    this.pop = pop;
  }
  private closePop(): void {
    this.pop?.remove();
    this.pop = null;
    this.hidePicker();
  }
  private hidePicker(): void {
    this.picker?.classList.add("hidden");
    document.removeEventListener("pointerdown", this.onDocDown);
  }

  /** Font menu — a checkmark on the active family (FigJam-style). */
  private openFontPop(anchor: HTMLElement): void {
    const cur = this.state?.fontFamily;
    this.openPop(
      anchor,
      false,
      TEXT_FONTS.map((f) => ({
        html: `<span class="ctb-check">${f.css === cur ? "✓" : ""}</span><span style="font-family:${f.css}">${f.label}</span>`,
        on: () => this.host.setFontFamily(f.css),
      })),
    );
  }

  /** Size menu — named presets (check on the active one) + a numeric input for an exact value. */
  private openSizePop(anchor: HTMLElement): void {
    if (this.pop?.dataset.for === "size") {
      this.closePop();
      return;
    }
    this.closePop();
    const cur = Math.round(this.state?.fontSize ?? 24);
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-pop-size";
    pop.dataset.for = "size";
    let applied = false;
    const setSize = (n: number): void => {
      if (applied) return; // a preset click already handled it (don't let the input's blur re-apply)
      applied = true;
      if (Number.isFinite(n) && n >= 4 && n <= 400) this.host.setFontSize(n);
      this.closePop();
      this.editor?.focus();
    };
    for (const p of SIZE_PRESETS) {
      const b = document.createElement("button");
      b.className = "ctb-pop-item";
      b.innerHTML = `<span class="ctb-check">${p.size === cur ? "✓" : ""}</span><span>${p.label}</span>`;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => setSize(p.size));
      pop.appendChild(b);
    }
    const input = document.createElement("input");
    input.type = "number";
    input.className = "ctb-size-input";
    input.value = String(cur);
    input.setAttribute("min", "4");
    input.setAttribute("max", "400");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        setSize(parseInt(input.value, 10));
      } else if (e.key === "Escape") {
        e.preventDefault();
        applied = true;
        this.closePop();
        this.editor?.focus();
      }
    });
    input.addEventListener("blur", () => setSize(parseInt(input.value, 10)));
    pop.appendChild(input);
    document.body.appendChild(pop);
    const ar = anchor.getBoundingClientRect();
    pop.style.left = `${ar.left}px`;
    pop.style.top = `${ar.bottom + 4}px`;
    this.pop = pop;
  }

  // ---- lifecycle (driven by TextLayer) ----
  show(editor: HTMLElement, state: TextBarState): void {
    this.editor = editor;
    this.root.style.display = "";
    this.reflect(state);
  }
  hide(): void {
    this.editor = null;
    this.closePop();
    this.closeMarks();
    this.root.style.display = "none";
  }
  /** Place the bar above the editor (flipping below if it'd run off the top of the viewport). */
  positionOver(rect: DOMRect): void {
    const barH = this.root.offsetHeight || 44;
    const barW = this.root.offsetWidth || 360;
    let top = rect.top - barH - 8;
    if (top < 8) top = rect.bottom + 8; // flip below if it'd run off the top
    // centre the bar over the box, clamped to the viewport
    const centred = rect.left + rect.width / 2 - barW / 2;
    const left = Math.max(8, Math.min(centred, window.innerWidth - barW - 8));
    this.root.style.top = `${top}px`;
    this.root.style.left = `${left}px`;
  }
  reflect(s: TextBarState): void {
    this.state = s;
    this.fontLabel.textContent = fontLabelFor(s.fontFamily);
    this.sizeLabel.textContent = sizeLabelFor(s.fontSize);
    this.markBtn("bold")?.classList.toggle("on", s.bold);
    this.markBtn("italic")?.classList.toggle("on", s.italic);
    this.markBtn("underline")?.classList.toggle("on", s.underline);
    this.markBtn("strike")?.classList.toggle("on", s.strike);
    // The mobile marks toggle lights up when any of B/I/U/S is active.
    this.root
      .querySelector<HTMLElement>(".ctb-marks-toggle")
      ?.classList.toggle("on", s.bold || s.italic || s.underline || s.strike);
    this.root.querySelector<HTMLElement>('[data-act="bullet"]')?.classList.toggle("on", s.bullet);
    const sw = this.root.querySelector<HTMLElement>("[data-swatch]");
    if (sw) sw.style.background = s.color || "#0e1116";
    // Shape mode: toggle the shape-only controls + reflect shape kind / fill / alignment.
    const isShape = s.shape != null;
    this.root.classList.toggle("shape-mode", isShape);
    if (isShape) {
      const ico2 = this.root.querySelector<HTMLElement>(".ctb-shape-ico");
      if (ico2 && s.shape) ico2.innerHTML = ico(SHAPE_SVG[s.shape]);
      const dot = this.root.querySelector<HTMLElement>("[data-fill]");
      if (dot) dot.style.background = s.fill || "#ffffff";
      const aico = this.root.querySelector<HTMLElement>(".ctb-align-ico");
      if (aico) aico.innerHTML = ico(ALIGN_SVG[s.align ?? "center"]);
    }
  }
  private markBtn(mark: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-mark="${mark}"]`);
  }
  destroy(): void {
    this.closePop();
    this.picker?.remove();
    this.root.remove();
  }
}
