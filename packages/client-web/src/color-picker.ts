// <komu-color-picker> — a custom colour picker (light-DOM Web Component).
//
// Saturation/value square + hue slider + hex field + (where supported) an
// eyedropper. Driven by the `value` property (a hex string); reports live edits
// via a `color-change` event. Reuses the global `.color-picker` styles. ADR-0005.

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function toHex(h: number, s: number, v: number): string {
  const [r, g, b] = hsvToRgb(h, s, v);
  return (
    "#" +
    [r, g, b]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1] ?? "", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

export class CoColorPicker extends HTMLElement {
  #h = 0;
  #s = 0;
  #v = 0;
  #wired = false;

  connectedCallback(): void {
    this.classList.add("color-picker");
    if (this.#wired) return;
    this.#wired = true;
    this.#build();
  }

  get value(): string {
    return toHex(this.#h, this.#s, this.#v);
  }
  set value(hex: string) {
    const rgb = parseHex(hex);
    if (!rgb) return;
    [this.#h, this.#s, this.#v] = rgbToHsv(...rgb);
    this.#sync();
  }

  #build(): void {
    const ED = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    this.innerHTML =
      '<div class="cp-top">' +
      (ED
        ? '<button class="cp-eyedropper" type="button" data-tip="Pick from screen" aria-label="Eyedropper">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 0 1 3 3L18 9l.4.4a2.1 2.1 0 0 1 0 3 2.1 2.1 0 0 1-3 0l-3.8-3.8a2.1 2.1 0 0 1 0-3 2.1 2.1 0 0 1 3 0Z"/></svg></button>'
        : "") +
      '<input class="cp-hex" type="text" spellcheck="false" aria-label="Hex colour" />' +
      "</div>" +
      '<div class="cp-hue" data-hue tabindex="0" role="slider" aria-label="Hue" aria-valuemin="0" aria-valuemax="360">' +
      '<div class="cp-thumb" data-hue-thumb></div></div>' +
      '<div class="cp-sv" data-sv tabindex="0" role="slider" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100">' +
      '<div class="cp-thumb cp-sv-thumb" data-sv-thumb></div></div>';

    const sv = this.querySelector<HTMLElement>("[data-sv]");
    const hue = this.querySelector<HTMLElement>("[data-hue]");
    const hex = this.querySelector<HTMLInputElement>(".cp-hex");

    this.#dragArea(sv, (px, py) => {
      this.#s = clamp01(px);
      this.#v = 1 - clamp01(py);
      this.#sync();
      this.#emit();
    });
    this.#dragArea(hue, (px) => {
      this.#h = clamp01(px) * 360;
      this.#sync();
      this.#emit();
    });

    // Keyboard access for the 2-D SV square + hue track (the pointer drag above is mouse-only).
    this.#keyNudge(sv, (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === "ArrowLeft") this.#s = clamp01(this.#s - step);
      else if (e.key === "ArrowRight") this.#s = clamp01(this.#s + step);
      else if (e.key === "ArrowUp") this.#v = clamp01(this.#v + step);
      else if (e.key === "ArrowDown") this.#v = clamp01(this.#v - step);
      else return false;
      return true;
    });
    this.#keyNudge(hue, (e) => {
      const step = e.shiftKey ? 30 : 6;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") this.#h = Math.max(0, this.#h - step);
      else if (e.key === "ArrowRight" || e.key === "ArrowUp")
        this.#h = Math.min(360, this.#h + step);
      else return false;
      return true;
    });

    hex?.addEventListener("change", () => {
      const rgb = parseHex(hex.value);
      if (rgb) {
        [this.#h, this.#s, this.#v] = rgbToHsv(...rgb);
        this.#sync();
        this.#emit();
      } else {
        this.#sync(); // revert to the current valid value
      }
    });

    this.querySelector(".cp-eyedropper")?.addEventListener("click", () => {
      // EyeDropper.open() rejects when the user cancels with Esc — swallow that, don't log.
      void new ED!()
        .open()
        .then((r) => {
          this.value = r.sRGBHex;
          this.#emit();
        })
        .catch(() => {});
    });

    this.#sync();
  }

  /** Wire pointer drag (with capture) over a track/area; reports normalised 0..1 coords. */
  #dragArea(el: HTMLElement | null, onMove: (px: number, py: number) => void): void {
    if (!el) return;
    const move = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      onMove((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    };
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      move(e);
    });
    el.addEventListener("pointermove", (e) => {
      if (el.hasPointerCapture(e.pointerId)) move(e);
    });
  }

  /** Arrow-key nudging for a focusable track; `handle` mutates state and returns true if handled. */
  #keyNudge(el: HTMLElement | null, handle: (e: KeyboardEvent) => boolean): void {
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      if (!handle(e)) return;
      e.preventDefault();
      this.#sync();
      this.#emit();
    });
  }

  #sync(): void {
    const hue = `hsl(${this.#h}, 100%, 50%)`;
    const sv = this.querySelector<HTMLElement>("[data-sv]");
    const hueEl = this.querySelector<HTMLElement>("[data-hue]");
    const svT = this.querySelector<HTMLElement>("[data-sv-thumb]");
    const hueT = this.querySelector<HTMLElement>("[data-hue-thumb]");
    const hex = this.querySelector<HTMLInputElement>(".cp-hex");
    if (sv) {
      sv.style.setProperty("--cp-hue", hue);
      // valuetext (the hex) is what AT announces; valuenow (saturation) just completes the slider so
      // it isn't reported as empty — a 2-D control can't express both axes in one aria-valuenow.
      sv.setAttribute("aria-valuenow", String(Math.round(this.#s * 100)));
      sv.setAttribute("aria-valuetext", this.value); // current colour, announced to screen readers
    }
    if (hueEl) hueEl.setAttribute("aria-valuenow", String(Math.round(this.#h)));
    if (svT) {
      svT.style.left = `${this.#s * 100}%`;
      svT.style.top = `${(1 - this.#v) * 100}%`;
      svT.style.background = this.value;
    }
    if (hueT) hueT.style.left = `${(this.#h / 360) * 100}%`;
    if (hex && document.activeElement !== hex) hex.value = this.value;
  }

  #emit(): void {
    this.dispatchEvent(
      new CustomEvent("color-change", { detail: { color: this.value }, bubbles: true }),
    );
  }
}

if (!customElements.get("komu-color-picker"))
  customElements.define("komu-color-picker", CoColorPicker);

declare global {
  interface HTMLElementTagNameMap {
    "komu-color-picker": CoColorPicker;
  }
}
