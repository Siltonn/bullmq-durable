import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "nestjs/index": "src/nestjs/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  // Keep peer dependencies external so consumers control their own versions.
  external: ["bullmq", "ioredis", "@nestjs/common", "@nestjs/core"],
  target: "node18",
})
