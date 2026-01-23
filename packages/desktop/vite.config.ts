import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"

const host = process.env.TAURI_DEV_HOST || "127.0.0.1"

// https://vite.dev/config/
export default defineConfig({
  plugins: [appPlugin],
  publicDir: "../app/public",
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  esbuild: {
    // Improves production stack traces
    keepNames: true,
  },
  // build: {
  // sourcemap: true,
  // },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 5373,
    strictPort: true,
    host,
    hmr: host
      ? {
          protocol: "ws",
          host,
        port: 5374,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
})
