// Image-upload contract — the single source of truth shared by the worker (upload validation + the
// content-hash key's file extension) and the client (file-input `accept`, pre-validation, downscale)
// so the two can never drift out of agreement (e.g. the worker accepting a type the client rejects).

/** Hard cap on an uploaded image's byte size (free-tier R2: bound storage, zero egress). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Accepted upload MIME type → the file extension baked into its R2 content-hash key. */
export const UPLOAD_IMAGE_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** The accepted MIME types — for a membership check or a file-input `accept` attribute. */
export const UPLOAD_IMAGE_TYPES: readonly string[] = Object.keys(UPLOAD_IMAGE_EXT);
