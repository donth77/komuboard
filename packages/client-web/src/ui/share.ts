// "Share this board" dialog — the room link, a QR code to join on mobile/VR, a Copy-link control,
// and the no-signup helper. Built on the reusable <komu-dialog> (focus-trapped, Esc/backdrop close).
// QR is generated locally (qrcode-generator, no network) so a shared link never leaves the device.
import qrcode from "qrcode-generator";
import { type CoDialog, createDialog } from "../dialog";
import { t } from "../i18n";

/** Build the Share dialog for `roomUrl`. Returns the dialog — call `.open()` to show it. */
export function createShareDialog(roomUrl: string): CoDialog {
  const body = document.createElement("div");
  body.className = "share-body";

  // QR — error-correction "M", auto-sized (typeNumber 0); rendered as a crisp scalable SVG.
  const qr = qrcode(0, "M");
  qr.addData(roomUrl);
  qr.make();
  const qrWrap = document.createElement("div");
  qrWrap.className = "share-qr";
  qrWrap.setAttribute("role", "img");
  qrWrap.setAttribute("data-i18n-aria", "share.qrLabel");
  qrWrap.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 0, scalable: true });

  const cap = document.createElement("p");
  cap.className = "share-cap";
  cap.setAttribute("data-i18n", "share.scanForLink");

  // Room link + Copy.
  const row = document.createElement("div");
  row.className = "share-url-row";
  const input = document.createElement("input");
  input.type = "text";
  input.readOnly = true;
  input.value = roomUrl;
  input.className = "share-url";
  input.setAttribute("data-i18n-aria", "share.roomLink");
  input.addEventListener("focus", () => input.select());
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "share-copy";
  copy.textContent = t("share.copyLink");
  let resetTimer = 0;
  copy.addEventListener("click", () => {
    void copyText(roomUrl, input);
    copy.textContent = t("share.copied");
    copy.classList.add("ok");
    copy.setAttribute("aria-live", "polite");
    window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      copy.textContent = t("share.copyLink");
      copy.classList.remove("ok");
    }, 1600);
  });
  row.append(input, copy);

  const helper = document.createElement("p");
  helper.className = "share-helper";
  helper.setAttribute("data-i18n", "share.helper");

  body.append(qrWrap, cap, row, helper);

  // Native share sheet (mobile/supported browsers) — added to the footer only when available.
  const footer = document.createElement("div");
  footer.className = "share-footer";
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const native = document.createElement("button");
    native.type = "button";
    native.className = "share-native";
    native.setAttribute("data-i18n", "share.native");
    native.addEventListener("click", () => {
      void navigator
        .share({ title: t("app.name"), text: t("share.shareText"), url: roomUrl })
        .catch(() => {
          /* user dismissed the share sheet — no-op */
        });
    });
    footer.appendChild(native);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("data-dialog-close", "");
  close.className = "share-done";
  close.setAttribute("data-i18n", "common.done");
  footer.appendChild(close);

  return createDialog({ titleKey: "share.title", body, footer, width: 340 });
}

/** Copy `text` to the clipboard, falling back to a selection + execCommand on older/denied paths. */
async function copyText(text: string, fallbackField: HTMLInputElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackField.focus();
    fallbackField.select();
    document.execCommand?.("copy");
  }
}
