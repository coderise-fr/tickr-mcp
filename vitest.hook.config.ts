import { defineConfig } from "vitest/config";

// Plugin hook tests: they need a runtime where node:sqlite loads without a flag (Node 22.13+).
// They spawn child processes and fsync SQLite files, which is slow on shared CI runners (Windows
// above all): a generous timeout and fewer parallel workers keep timing out from being flaky.
export default defineConfig({
  test: {
    include: ["tests/hook/**/*.test.ts"],
    testTimeout: process.env.CI ? 90_000 : 20_000,
    hookTimeout: process.env.CI ? 90_000 : 10_000,
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
