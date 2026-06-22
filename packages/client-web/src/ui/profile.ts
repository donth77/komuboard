// src/ui/profile.ts — the "Your profile" dialog (display name + colour + avatar photo).
//
// A self-contained UI module lifted out of main.ts: it owns the <komu-dialog>, the draft state,
// the swatch grid, and the photo upload/crop. It reports a committed profile through the
// `onSave` callback only — so all realtime / identity / persistence wiring stays in main.ts and
// this module has no dependency on the Yjs provider. Light DOM; reuses the global
// `.avatar-edit` / `.field` / `.swatches` styles + <komu-dialog>.

import { USER_COLOR_NAMES } from "@komuboard/shared";
import { createDialog } from "../dialog";
import { COLOR_NAMES } from "../draw-bar";
import { initials, safePhotoUrl } from "../util";

export interface ProfileDraft {
  name: string;
  color: string;
  photo?: string;
}

export interface ProfileDialogOptions {
  /** The selectable colour palette (white is dropped — a white avatar would be invisible). */
  swatches: string[];
  /** The current profile, read fresh each time the dialog opens. */
  initial: () => ProfileDraft;
  /** Called with the raw draft when the user hits Save; the host persists + broadcasts it
   *  (and decides the empty-name fallback, since it owns the existing identity). */
  onSave: (profile: ProfileDraft) => void;
}

/** Resize a chosen image to a small square JPEG data URL (avatar thumbnail). */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = 96;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return c.toDataURL("image/jpeg", 0.82);
}

/** Build the profile dialog once and return an `open()` that (re)seeds it from the current profile. */
export function createProfileDialog(opts: ProfileDialogOptions): { open: () => void } {
  const dialog = createDialog({
    title: "Your profile",
    width: 360,
    body:
      '<div class="avatar-edit"><div class="avatar-preview" id="profile-avatar"></div>' +
      '<div class="avatar-edit-actions">' +
      '<button type="button" class="btn-soft" id="profile-photo-btn">Upload photo</button>' +
      '<button type="button" class="btn-link" id="profile-photo-clear">Remove</button>' +
      '<input type="file" id="profile-photo-input" accept="image/*" hidden /></div></div>' +
      '<label class="field"><span>Display name</span><input type="text" id="profile-name" maxlength="40" placeholder="Your name" /></label>' +
      '<div class="field" id="profile-color-field"><span>Color</span><div class="swatches" id="profile-swatches" data-tip-in-dialog></div></div>',
    footer:
      '<button type="button" class="btn-ghost" data-dialog-close>Cancel</button>' +
      '<button type="button" class="btn-primary" id="profile-save">Save</button>',
  });

  const dName = document.getElementById("profile-name") as HTMLInputElement | null;
  const dAvatar = document.getElementById("profile-avatar");
  const dSwatches = document.getElementById("profile-swatches");
  const dPhotoInput = document.getElementById("profile-photo-input") as HTMLInputElement | null;
  const dPhotoClear = document.getElementById("profile-photo-clear");
  // The selectable avatar colours are the identity palette (USER_COLORS, passed in). White is dropped
  // defensively in case a palette ever includes it — a white avatar would be invisible.
  const palette = opts.swatches.filter((c) => c.toLowerCase() !== "#ffffff");
  let draft: ProfileDraft = opts.initial();

  function renderDraftAvatar(): void {
    if (!dAvatar) return;
    dAvatar.style.setProperty("--av", draft.color);
    const photo = safePhotoUrl(draft.photo);
    if (photo) {
      dAvatar.style.backgroundImage = `url("${photo}")`;
      dAvatar.classList.add("has-photo");
      dAvatar.textContent = "";
    } else {
      dAvatar.style.backgroundImage = "";
      dAvatar.classList.remove("has-photo");
      dAvatar.textContent = initials(draft.name || "Guest");
    }
    // "Remove" only applies to an uploaded photo — the default initials avatar can't be removed.
    if (dPhotoClear) dPhotoClear.style.display = draft.photo ? "" : "none";
  }
  function renderSwatches(): void {
    if (!dSwatches) return;
    dSwatches.innerHTML = palette
      .map((c) => {
        const name = USER_COLOR_NAMES[c] ?? COLOR_NAMES[c.toUpperCase()] ?? c;
        return `<button type="button" class="sw${c === draft.color ? " on" : ""}" data-color="${c}" data-tip="${name}" style="--sw:${c}" aria-label="${name}"></button>`;
      })
      .join("");
  }

  dName?.addEventListener("input", () => {
    draft.name = dName.value;
    renderDraftAvatar();
  });
  dSwatches?.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(".sw");
    if (!t) return;
    draft.color = t.getAttribute("data-color") ?? draft.color;
    renderSwatches();
    renderDraftAvatar();
  });
  document
    .getElementById("profile-photo-btn")
    ?.addEventListener("click", () => dPhotoInput?.click());
  dPhotoClear?.addEventListener("click", () => {
    draft.photo = undefined;
    renderDraftAvatar();
  });
  dPhotoInput?.addEventListener("change", () => {
    const file = dPhotoInput.files?.[0];
    if (!file) return;
    void fileToAvatarDataUrl(file).then((url) => {
      draft.photo = url;
      renderDraftAvatar();
    });
    dPhotoInput.value = "";
  });
  // close is handled by <komu-dialog>: header ✕, the Cancel [data-dialog-close], and backdrop click
  document.getElementById("profile-save")?.addEventListener("click", () => {
    opts.onSave({ name: draft.name, color: draft.color, photo: draft.photo });
    dialog.close();
  });

  return {
    open(): void {
      draft = opts.initial();
      if (dName) dName.value = draft.name;
      renderSwatches();
      renderDraftAvatar();
      dialog.open();
      dName?.focus();
      dName?.select();
    },
  };
}
