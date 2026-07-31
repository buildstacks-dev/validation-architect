import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Offline suite only: no live provider calls belong here. Live campaigns
    // run through `pnpm vda run <fixture>` and spend real quota.
    environment: "node",
    testTimeout: 15_000,
  },
});
