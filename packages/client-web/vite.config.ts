import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 5173, host: "127.0.0.1" },
  // `iwer` (the WebXR emulator) is only imported by src/vr/test-xr.ts, which the e2e suite pulls in
  // through the dev server at runtime — so Vite's startup scan never sees it. Without listing it
  // here, the first spec to import it makes Vite optimize the dependency mid-run and reload every
  // open page ("Execution context was destroyed" in whichever test is mid-flight). Dev-only.
  optimizeDeps: { include: ["iwer"] },
});
