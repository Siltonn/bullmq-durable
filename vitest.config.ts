import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // Durable runtime tests rely on a shared in-memory store per test file;
    // isolate files but allow concurrency across files.
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/index.ts",
        "src/types.ts",
        "src/scheduler.ts",
        "src/nestjs/types.ts",
        "src/store/state-store.ts",
      ],
    },
  },
  esbuild: {
    // NestJS decorators need the legacy decorator transform.
    target: "node18",
  },
})
