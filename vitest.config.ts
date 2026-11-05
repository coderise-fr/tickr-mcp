import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/contract/**", "tests/hook/**", "node_modules/**"] },
});
