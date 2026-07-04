import { describe, expect, it } from "vitest";

import { sniffImage } from "./image-sniff";

const bytes = (...b: number[]): Uint8Array => new Uint8Array(b);

describe("sniffImage — magic-byte image detection", () => {
  it("detects PNG", () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.type).toBe(
      "image/png",
    );
  });
  it("detects JPEG", () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))?.ext).toBe("jpg");
  });
  it("detects GIF", () => {
    expect(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))?.type).toBe("image/gif");
  });
  it("detects WebP (RIFF…WEBP)", () => {
    expect(
      sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))?.type,
    ).toBe("image/webp");
  });
  it("rejects HTML masquerading as an image", () => {
    // "<!DOCTYPE" — the classic MIME-sniff-to-script payload
    expect(sniffImage(bytes(0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54))).toBeNull();
  });
  it("rejects empty / too-short input", () => {
    expect(sniffImage(bytes())).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50))).toBeNull();
  });
});
