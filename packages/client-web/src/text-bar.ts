// src/text-bar.ts — the floating rich-text toolbar shown above the active text editor.
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
import { COLOR_NAMES, tColor } from "./draw-bar";
import { applyTranslations, t } from "./i18n";
import { lineWeightIcon } from "./icons";
import { SWATCHES } from "./palette";
import type { BorderStyle, ShapeKind, TextAlign } from "@komuboard/shared";

export interface TextBarHost {
  setFontFamily(css: string): void;
  setFontSize(size: number): void;
  toggleBullets(): void;
  /** A mark changed via execCommand → TextLayer re-measures/broadcasts + re-reflects. */
  onFormat(): void;
  /** Shape-mode controls (only used when the box being edited is a shape). */
  setShapeKind(kind: ShapeKind): void;
  setFill(color: string): void;
  /** Set the shape's border colour and/or style (omit a field to leave it unchanged). */
  setBorder(p: { color?: string; style?: BorderStyle }): void;
  setAlign(align: TextAlign): void;
  /** Selection-mode marks — applied to the whole selected box (no live editor). `setLink("")`
   *  removes the link; a `""` colour/highlight clears it. */
  applyMark(mark: string): void;
  setColor(hex: string): void;
  setHighlight(hex: string): void;
  setLink(url: string): void;
  /** Selection-mode Link click: enter the box's text edit mode with all text selected, so the link
   *  input can link the whole label (and the user can then refine to a specific selection). */
  linkSelection(): void;
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
  /** When set, the bar enters shape mode (adds shape-select / fill / border / align controls). */
  shape?: ShapeKind;
  /** Current shape fill + border + text alignment (shape mode). */
  fill?: string;
  borderColor?: string;
  borderStyle?: BorderStyle;
  align?: TextAlign;
}

/** Which colour a colour popover/picker drives: text fore-colour, highlight, shape fill, or border. */
type ColorKind = "fore" | "hilite" | "fill" | "border";

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
// Named size presets + a numeric input for an exact value.
const SIZE_PRESETS: { label: string; size: number; key: string }[] = [
  { label: "Small", size: 16, key: "text.size.small" },
  { label: "Medium", size: 24, key: "text.size.medium" },
  { label: "Large", size: 40, key: "text.size.large" },
  { label: "Extra large", size: 64, key: "text.size.extraLarge" },
  { label: "Huge", size: 96, key: "text.size.huge" },
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
// Shape fill reuses the shared swatches minus pink (per request) — a separate list so the draw
// tool / text colour keep the full SWATCHES set.
const SHAPE_FILLS = SWATCHES.filter((c) => c !== "#ec4899");
// Shape border colours — a smaller set than the fill palette. Leads with the default outline ink.
const BORDER_COLORS = ["#1f2933", "#dc2626", "#f59e0b", "#16a34a", "#2563eb", "#7c3aed", "#ffffff"];
const BORDER_STYLES: { style: BorderStyle; label: string; key: string; svg: string }[] = [
  { style: "solid", label: "Solid", key: "draw.solid", svg: '<path d="M3 10h14"/>' },
  {
    style: "dashed",
    label: "Dashed",
    key: "text.borderDashed",
    svg: '<path d="M3 10h14" stroke-dasharray="3.2 2.6"/>',
  },
  {
    style: "none",
    label: "No border",
    key: "text.noBorder",
    svg: '<path d="M4 16 16 4" stroke="#e8554e"/>',
  },
];

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
};
const SHAPE_ORDER: ShapeKind[] = ["rectangle", "ellipse", "rhombus", "triangle"];
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
  const f = TEXT_FONTS.find((f) => f.css === css);
  return f ? t(`text.font.${f.label.toLowerCase()}`) : t("text.font");
}
/** A named preset's label when the size matches one (Small/Medium/…), else the raw number. */
function sizeLabelFor(size: number): string {
  const p = SIZE_PRESETS.find((p) => p.size === Math.round(size));
  return p ? t(p.key) : String(Math.round(size));
}

export class TextBar {
  readonly root: HTMLDivElement;
  private editor: HTMLElement | null = null;
  /** True when shown over a *selected* (not editing) box — controls apply to the whole box. */
  private selectionMode = false;
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
    el.className = "komu-text-bar";
    el.style.display = "none";
    el.innerHTML =
      // Shape-only leading controls: shape-select + fill colour (shown only in shape mode).
      `<button class="ctb-btn ctb-shape-only ctb-shape-kind" data-act="shape-kind" data-i18n-tip="text.shape"><span class="ctb-shape-ico">${ico(SHAPE_SVG.rectangle)}</span><span class="ctb-caret">▾</span></button>` +
      `<button class="ctb-btn ctb-shape-only ctb-fill" data-act="fill" data-i18n-tip="text.fillColor"><span class="ctb-fill-dot" data-fill></span><span class="ctb-caret">▾</span></button>` +
      `<button class="ctb-btn ctb-shape-only ctb-border" data-act="border" data-i18n-tip="text.border"><span class="ctb-border-ico">${lineWeightIcon("ctb-ico")}</span><span class="ctb-caret">▾</span></button>` +
      `<span class="ctb-sep ctb-shape-only"></span>` +
      `<button class="ctb-text" data-act="font" data-i18n-tip="text.font"><span class="ctb-font-label" data-i18n="text.font.sans">Sans</span><span class="ctb-caret">▾</span></button>` +
      `<button class="ctb-text" data-act="size" data-i18n-tip="text.fontSize"><span class="ctb-size-label" data-i18n="text.size.medium">Medium</span><span class="ctb-caret">▾</span></button>` +
      `<span class="ctb-sep"></span>` +
      // B/I/U/S — inline on desktop; on mobile they collapse behind one toggle that expands a
      // vertical flyout (saves the width that was making the toolbar overflow on phones).
      `<span class="ctb-marks">` +
      `<button class="ctb-btn ctb-marks-toggle" data-act="marks" data-i18n-tip="text.textStyle">${ico(SVG.type)}<span class="ctb-caret">▾</span></button>` +
      `<span class="ctb-marks-menu">` +
      `<button class="ctb-btn ctb-b" data-mark="bold" data-i18n-tip="text.bold">B</button>` +
      `<button class="ctb-btn ctb-i" data-mark="italic" data-i18n-tip="text.italic">I</button>` +
      `<button class="ctb-btn ctb-u" data-mark="underline" data-i18n-tip="text.underline">U</button>` +
      `<button class="ctb-btn ctb-strike" data-mark="strike" data-i18n-tip="text.strikethrough">S</button>` +
      `</span>` +
      `</span>` +
      `<span class="ctb-sep"></span>` +
      `<button class="ctb-btn" data-act="bullet" data-i18n-tip="text.bulletedList">${ico(SVG.list)}</button>` +
      `<button class="ctb-btn" data-act="link" data-i18n-tip="text.link">${ico(SVG.link)}</button>` +
      `<span class="ctb-sep"></span>` +
      `<button class="ctb-btn ctb-color" data-act="color" data-i18n-tip="text.textColor"><span class="ctb-a">A</span><span class="ctb-underbar" data-swatch></span></button>` +
      `<button class="ctb-btn ctb-hl" data-act="highlight" data-i18n-tip="text.highlight"><span class="ctb-hl-box" data-hlswatch></span></button>` +
      // Shape-only trailing control: text alignment (matters for shapes' centred labels).
      `<span class="ctb-sep ctb-shape-only"></span>` +
      `<button class="ctb-btn ctb-shape-only ctb-align" data-act="align" data-i18n-tip="text.alignment"><span class="ctb-align-ico">${ico(ALIGN_SVG.center)}</span><span class="ctb-caret">▾</span></button>`;
    document.body.appendChild(el);
    applyTranslations(el);
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
          // Selection mode: hand off to the host, which enters edit mode + selects all the text,
          // then re-opens the link input (now editing) via openLink().
          if (this.selectionMode) return this.host.linkSelection();
          return this.openLinkPop(btn);
        case "color":
          return this.openColorPop(btn, "fore");
        case "highlight":
          return this.openColorPop(btn, "hilite");
        case "shape-kind":
          return this.openShapePop(btn);
        case "fill":
          return this.openColorPop(btn, "fill");
        case "border":
          return this.openBorderPop(btn);
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
    if (this.selectionMode) return this.host.applyMark(mark); // whole-box (no live editor)
    this.editor?.focus();
    document.execCommand(mark === "strike" ? "strikeThrough" : mark, false);
    this.host.onFormat();
  }

  private applyColor(kind: ColorKind, hex: string, savedRange?: Range): void {
    if (kind === "fill") {
      // Shape fill is a block prop (no execCommand / selection) — route straight to the host.
      // The "No fill" swatch passes "" → a transparent fill.
      this.host.setFill(hex || "transparent");
      return;
    }
    if (kind === "border") {
      // Border colour is a block prop too; choosing one re-enables the outline if it was off.
      const patch: { color: string; style?: BorderStyle } = { color: hex || "#1f2933" };
      if (this.state?.borderStyle === "none") patch.style = "solid";
      this.host.setBorder(patch);
      return;
    }
    if (this.selectionMode) {
      // Whole-box colour/highlight (no live editor).
      if (kind === "fore") this.host.setColor(hex);
      else this.host.setHighlight(hex);
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
    // hilite + fill offer a "none" swatch (the "" entry, rendered as the red-slash sw-none); fore
    // doesn't. Fill's none = transparent.
    const colors =
      kind === "hilite" ? HIGHLIGHTS : kind === "fill" ? ["", ...SHAPE_FILLS] : SWATCHES;
    const names = kind === "hilite" ? HIGHLIGHT_NAMES : COLOR_NAMES;
    const noneTip = t(kind === "fill" ? "text.noFill" : "common.none");
    // Ring the active swatch. Foreground tracks `color`; fill tracks `fill`; highlight none.
    const curRaw = kind === "fore" ? this.state?.color : kind === "fill" ? this.state?.fill : "";
    const cur = (curRaw ?? "").toLowerCase();
    const noneActive = kind === "fill" && (cur === "" || cur === "transparent");
    const sw = colors
      .map((c) =>
        c
          ? `<button class="sw${c.toLowerCase() === cur ? " on" : ""}" type="button" data-color="${c}" data-tip="${tColor(names[c.toUpperCase()], c)}" style="--sw:${c}"></button>`
          : `<button class="sw sw-none${noneActive ? " on" : ""}" type="button" data-color="" data-tip="${noneTip}"></button>`,
      )
      .join("");
    const customOn = !noneActive && !!cur && !colors.some((c) => c.toLowerCase() === cur);
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-color-pop";
    pop.dataset.for = id;
    pop.innerHTML = `<div class="swatches" data-swatches>${sw}<button class="sw sw-custom${customOn ? " on" : ""}" type="button" data-custom data-i18n-tip="common.custom"></button></div>`;
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
    this.placePop(pop, anchor, true);
    this.pop = pop;
  }

  /** Border popover (shape mode): a row of styles (solid / dashed / none) + a row of border colours. */
  private openBorderPop(anchor: HTMLElement): void {
    if (this.pop?.dataset.for === "border") {
      this.closePop();
      return;
    }
    this.closePop();
    const curStyle = this.state?.borderStyle ?? "solid";
    const curColor = (this.state?.borderColor ?? BORDER_COLORS[0]!).toLowerCase();
    const customOn = !!curColor && !BORDER_COLORS.some((c) => c.toLowerCase() === curColor);
    const styleRow = BORDER_STYLES.map(
      (b) =>
        `<button class="ctb-border-style${b.style === curStyle ? " on" : ""}" type="button" data-style="${b.style}" data-tip="${t(b.key)}"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${b.svg}</svg></button>`,
    ).join("");
    const colorRow = BORDER_COLORS.map(
      (c) =>
        `<button class="sw${c.toLowerCase() === curColor ? " on" : ""}" type="button" data-bcolor="${c}" data-tip="${tColor(COLOR_NAMES[c.toUpperCase()], c)}" style="--sw:${c}"></button>`,
    ).join("");
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-border-pop";
    pop.dataset.for = "border";
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    pop.innerHTML =
      `<div class="ctb-border-styles">${styleRow}</div>` +
      `<div class="swatches">${colorRow}<button class="sw sw-custom${customOn ? " on" : ""}" type="button" data-custom data-i18n-tip="common.custom"></button></div>`;
    pop.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const sBtn = t.closest<HTMLElement>("[data-style]");
      if (sBtn) {
        this.host.setBorder({ style: sBtn.getAttribute("data-style") as BorderStyle });
        this.closePop();
        return;
      }
      if (t.closest("[data-custom]")) return this.openPicker("border", anchor);
      const cBtn = t.closest<HTMLElement>("[data-bcolor]");
      if (cBtn) {
        // Choosing a colour also re-enables the outline if it was "none".
        const patch: { color: string; style?: BorderStyle } = {
          color: cBtn.getAttribute("data-bcolor") ?? BORDER_COLORS[0]!,
        };
        if (curStyle === "none") patch.style = "solid";
        this.host.setBorder(patch);
        this.closePop();
      }
    });
    document.body.appendChild(pop);
    this.placePop(pop, anchor, true);
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
        `<button class="ctb-shape-opt${k === cur ? " on" : ""}" type="button" data-kind="${k}" data-tip="${t(`shape.${k}`)}">${ico(SHAPE_SVG[k])}</button>`,
    ).join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
      if (!b) return;
      this.host.setShapeKind(b.getAttribute("data-kind") as ShapeKind);
      this.closePop();
    });
    document.body.appendChild(pop);
    this.placePop(pop, anchor);
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
          `<button class="ctb-align-opt${a === cur ? " on" : ""}" type="button" data-align="${a}" data-tip="${t(`text.align.${a}`)}">${ico(ALIGN_SVG[a])}</button>`,
      )
      .join("");
    pop.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-align]");
      if (!b) return;
      this.host.setAlign(b.getAttribute("data-align") as TextAlign);
      this.closePop();
    });
    document.body.appendChild(pop);
    this.placePop(pop, anchor, true);
    this.pop = pop;
  }

  /** The shared <komu-color-picker> for an arbitrary colour (reuses the draw tool's picker). */
  private openPicker(kind: ColorKind, anchor: HTMLElement): void {
    const sel = window.getSelection();
    this.pickerRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null; // save before focus moves
    this.pickerKind = kind;
    this.closePop();
    if (!this.picker) {
      this.picker = document.createElement("komu-color-picker") as CoColorPicker;
      document.body.appendChild(this.picker);
      this.picker.addEventListener("color-change", (e) => {
        const color = (e as CustomEvent<{ color: string }>).detail.color;
        this.applyColor(this.pickerKind, color, this.pickerRange ?? undefined);
        const s = window.getSelection();
        if (s && s.rangeCount) this.pickerRange = s.getRangeAt(0).cloneRange(); // keep the range valid
      });
    }
    this.picker.value =
      (this.pickerKind === "fill"
        ? this.state?.fill
        : this.pickerKind === "border"
          ? this.state?.borderColor
          : this.state?.color) || "#0e1116";
    this.picker.classList.remove("hidden");
    this.placePop(this.picker, anchor);
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
    // Measure the toolbar + anchor BEFORE hiding the toolbar — otherwise, in selection mode (no live
    // editor), the anchor lives inside the now-hidden bar and collapses to 0,0 (link input jumped to
    // the top-left corner). The bar sits just above the node, so it's a reliable "above the box" ref.
    const barRect = this.root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    this.root.style.display = "none"; // hide the toolbar so the link input doesn't overlap it
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null; // the text to link
    this.setLinkHighlight(saved); // keep the linked text visibly highlighted while the input is focused
    const pop = document.createElement("div");
    pop.className = "ctb-pop ctb-link-pop";
    pop.dataset.for = "link";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ctb-link-input";
    input.placeholder = t("text.linkPlaceholder");
    input.spellcheck = false;
    input.value = prefill;
    let done = false;
    const finish = (apply: boolean, remove = false): void => {
      if (done) return;
      done = true;
      this.root.style.display = ""; // bring the toolbar back
      const url = input.value.trim();
      this.closePop();
      // Selection mode: link the whole box via the host (no live editor / selection to restore).
      if (this.selectionMode) {
        if (remove) this.host.setLink("");
        else if (apply && url) this.host.setLink(url);
        return;
      }
      this.editor?.focus();
      if (editLink && editLink.isConnected) this.selectLinkContents(editLink);
      else if (saved) {
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(saved);
        // Reading the range back forces the selection to commit synchronously. Without it, a
        // focus()+addRange race on the nested shape editor (an inner contenteditable inside a
        // contenteditable=false box) leaves execCommand acting on a collapsed caret → it inserts
        // the URL as text instead of linking the restored selection.
        if (s?.rangeCount) s.getRangeAt(0);
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
      // Editing an existing link → a remove-link (unlink) icon strips the link.
      const sep = document.createElement("span");
      sep.className = "ctb-link-sep";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "ctb-link-unlink";
      rm.setAttribute("data-tip", t("text.removeLink"));
      rm.innerHTML = UNLINK_ICON;
      rm.addEventListener("mousedown", (e) => e.preventDefault()); // don't blur the input first
      rm.addEventListener("click", () => finish(false, true));
      pop.append(sep, rm);
    }
    document.body.appendChild(pop);
    const pw = pop.offsetWidth || 300;
    // Anchor the field above the node's box. When editing, climb from the editor to its `.komu-text`
    // box (for shapes the editor is the inner body, so use the box rect — same placement a text node
    // gets). In selection mode there's no editor, so fall back to the toolbar's pre-hide position.
    const editBox = this.editor?.closest<HTMLElement>(".komu-text") ?? null;
    const er = editBox?.getBoundingClientRect();
    const ref = er && er.width ? er : barRect.width ? barRect : anchorRect;
    pop.style.left = `${Math.max(8, Math.min(ref.left + ref.width / 2 - pw / 2, window.innerWidth - pw - 8))}px`;
    pop.style.top = `${Math.max(8, ref.top - pop.offsetHeight - 12)}px`;
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

  /** Open the link input for the active editor's current selection — used after the host enters edit
   *  mode (selection-mode Link click) so the URL applies to the just-selected text. */
  openLink(): void {
    this.openLinkPop(this.linkBtn());
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
    this.placePop(pop, anchor);
    this.pop = pop;
  }
  /** Position a popover relative to its anchor: downward by default (like a normal dropdown),
   *  flipping up only if it would clip the bottom of the viewport. `center` horizontally centres it
   *  over the anchor (else left-aligns). */
  private placePop(pop: HTMLElement, anchor: HTMLElement, center = false): void {
    applyTranslations(pop); // lazily-built popover subtree → resolve its data-i18n-* into the active locale
    const ar = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 220;
    const ph = pop.offsetHeight || 44;
    const rawLeft = center ? ar.left + ar.width / 2 - pw / 2 : ar.left;
    pop.style.left = `${Math.max(8, Math.min(rawLeft, window.innerWidth - pw - 8))}px`;
    let top = ar.bottom + 6; // open downward
    if (top + ph > window.innerHeight - 8) top = ar.top - ph - 6; // flip up if it'd run off the bottom
    pop.style.top = `${Math.max(8, top)}px`;
  }
  private closePop(): void {
    this.pop?.remove();
    this.pop = null;
    this.hidePicker();
    this.setLinkHighlight(null);
  }
  private hidePicker(): void {
    this.picker?.classList.add("hidden");
    document.removeEventListener("pointerdown", this.onDocDown);
  }
  /** Paint a persistent highlight over the text being linked while the URL input is focused. The
   *  native selection can't be used — once focus moves to the input the editor has no selection to
   *  render — so we use the CSS Custom Highlight API (`::highlight(komu-link-target)`), which paints a
   *  range regardless of focus and without touching the DOM. Pass null to clear it. */
  private setLinkHighlight(range: Range | null): void {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (!reg || typeof Highlight === "undefined") return;
    if (range && !range.collapsed) reg.set("komu-link-target", new Highlight(range.cloneRange()));
    else reg.delete("komu-link-target");
  }

  /** Font menu — a checkmark on the active family. */
  private openFontPop(anchor: HTMLElement): void {
    const cur = this.state?.fontFamily;
    this.openPop(
      anchor,
      false,
      TEXT_FONTS.map((f) => ({
        html: `<span class="ctb-check">${f.css === cur ? "✓" : ""}</span><span style="font-family:${f.css}">${t(`text.font.${f.label.toLowerCase()}`)}</span>`,
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
      b.innerHTML = `<span class="ctb-check">${p.size === cur ? "✓" : ""}</span><span>${t(p.key)}</span>`;
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
    this.placePop(pop, anchor);
    this.pop = pop;
  }

  // ---- lifecycle (driven by TextLayer) ----
  show(editor: HTMLElement, state: TextBarState): void {
    this.editor = editor;
    this.selectionMode = false;
    this.root.style.display = "";
    this.reflect(state);
  }
  /** Show over a *selected* (not editing) box — controls apply to the whole box via the host. */
  showForSelection(state: TextBarState): void {
    this.editor = null;
    this.selectionMode = true;
    this.root.style.display = "";
    this.reflect(state);
  }
  hide(): void {
    this.editor = null;
    this.selectionMode = false;
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
      if (dot) {
        const noFill = !s.fill || s.fill === "transparent";
        dot.classList.toggle("is-none", noFill); // red-slash when the shape has no fill
        dot.style.background = noFill ? "" : (s.fill ?? "");
      }
      // Tint the border icon to its colour (dimmed when the outline is off).
      const bico = this.root.querySelector<HTMLElement>(".ctb-border-ico");
      if (bico) {
        const off = s.borderStyle === "none";
        bico.style.color = off ? "" : (s.borderColor ?? "#1f2933");
        bico.classList.toggle("is-none", off);
      }
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
