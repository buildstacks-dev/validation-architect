import { defineConfig } from "vitest/config";

// One `pnpm test` runs both halves of the single package's offline suite.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["test/**/*.test.ts"],
          // test/fixtures holds synthetic target-repo trees for the trace CLI —
          // their *.test.ts files are scan subjects, not suite members.
          exclude: ["test/design/**", "test/fixtures/**", "**/node_modules/**"],
          // Offline suite only: no live provider calls belong here. Live
          // campaigns run through `pnpm vda run <fixture>` and spend quota.
          environment: "node",
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "design",
          include: ["test/design/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
          testTimeout: 15_000,
        },
      },
    ],
  },
});
