import { defineConfig } from "vitest/config";

// Plugin hook tests: they need a runtime where node:sqlite loads without a flag (Node 22.13+).
export default defineConfig({ test: { include: ["tests/hook/**/*.test.ts"], testTimeout: 20_000 } });
