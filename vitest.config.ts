import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    server: {
      deps: {
        // Node built-ins stay external to the Vite transform pipeline.
        external: [/^node:/, "node:sqlite", "sqlite"],
      },
    },
  },
});
