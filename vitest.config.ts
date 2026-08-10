import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // test/fixtures holds synthetic target-repo trees for the trace CLI —
    // their *.test.ts files are scan subjects, not suite members.
    exclude: ["test/fixtures/**", "**/node_modules/**"],
    // Offline suite only: no live provider calls belong here. Live campaigns
    // run through `pnpm vda run <fixture>` and spend real quota.
    environment: "node",
    testTimeout: 15_000,
  },
});
