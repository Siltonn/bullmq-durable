import { defineConfig } from "tsup"

/**
 * Server-side build. The React client is built separately by Vite into
 * `dist/client`, so this config only compiles the Node entry points:
 *
 *  - `index`               the framework-agnostic factory + types
 *  - `adapters/*`          one mounting helper per host framework
 *  - `cli/index`           the `bullmq-cockpit` standalone binary
 *
 * `clean: true` wipes `dist` first, which is why the root `build` script runs
 * tsup *before* Vite — Vite then writes `dist/client` on top of a clean tree.
 */
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/express": "src/adapters/express.ts",
    "adapters/fastify": "src/adapters/fastify.ts",
    "adapters/nestjs": "src/adapters/nestjs.ts",
    "adapters/standalone": "src/adapters/standalone.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  target: "node18",
  // Host-provided frameworks stay external so consumers control the versions.
  external: [
    "bullmq",
    "ioredis",
    "hono",
    "zod",
    "@hono/node-server",
    "express",
    "fastify",
    "@nestjs/common",
    "@nestjs/core",
  ],
})
