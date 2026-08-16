import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Without this file, `npm run dev`'s vite client (default port 5173) has no
// way to reach the API server (server/index.ts, default port 4178/4179 in
// this session) - every fetch("/api/...") just hits vite's own dev server
// and gets its index.html back ("Unexpected token '<'"). The documented dev
// entry point (README) is the API server's own port, which serves the
// prebuilt dist/ - this proxy is what makes the live-reloading vite client
// itself usable against real data during development.
const apiPort = process.env.PORT || 4178;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        ws: true
      }
    }
  }
});
