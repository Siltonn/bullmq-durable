import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The client is a static SPA embedded under an arbitrary mount path (e.g.
 * `/admin/bullmq`). We therefore emit **relative** asset URLs (`base: "./"`)
 * so the bundle works no matter where the host app mounts it — the real base
 * path is injected at runtime via `window.__BULLMQ_COCKPIT__.basePath`.
 *
 * In dev, Vite serves the SPA at `/` and proxies `/api` to the standalone Hono
 * server run alongside Vite by the `dev` script (concurrently).
 */
const DEV_SERVER_PORT = Number(process.env.COCKPIT_DEV_API_PORT ?? 3011)

export default defineConfig({
  root: "client",
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./client/src", import.meta.url)),
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      // Type-only: the client imports `AppRouter` from the server for tRPC
      // inference. It never pulls server *values* into the browser bundle.
      "@server": fileURLToPath(new URL("./src/server", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendor libraries into their own
        // long-cacheable chunks.
        manualChunks: {
          react: ["react", "react-dom"],
          tanstack: ["@tanstack/react-query", "@tanstack/react-router", "@tanstack/react-table"],
          heroui: ["@heroui/react", "framer-motion"],
          charts: ["recharts"],
        },
      },
    },
  },
  server: {
    port: Number(process.env.COCKPIT_DEV_CLIENT_PORT ?? 3010),
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${DEV_SERVER_PORT}`,
        changeOrigin: true,
      },
    },
  },
})
