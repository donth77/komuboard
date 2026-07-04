// Detect an image's real type from its magic bytes. The upload endpoint stores + serves THIS type,
// never the client-declared Content-Type header — so an attacker can't upload HTML (or any non-image)
// labelled `image/png` and have it served back and MIME-sniffed into executable script. Pure +
// dependency-free so it unit-tests without the Workers runtime.

export interface SniffedImage {
  type: string;
  ext: string;
}

/** Return the supported image type detected from the leading bytes, or null for anything else. */
export function sniffImage(b: Uint8Array): SniffedImage | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { type: "image/png", ext: "png" };
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { type: "image/jpeg", ext: "jpg" };
  // GIF: "GIF8"
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return { type: "image/gif", ext: "gif" };
  // WebP: "RIFF"...."WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return { type: "image/webp", ext: "webp" };
  return null;
}
