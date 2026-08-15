import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// One `pnpm test` at the root runs BOTH workspace packages' offline suites.
// The design project aliases the core package specifier to the live source so
// tests never depend on a stale dist build; the packed-resolution path is
// proven separately by scripts/package-smoke.mjs.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "core",
          include: ["test/**/*.test.ts"],
          // test/fixtures holds synthetic target-repo trees for the trace CLI —
          // their *.test.ts files are scan subjects, not suite members.
          exclude: ["test/fixtures/**", "**/node_modules/**"],
          // Offline suite only: no live provider calls belong here. Live
          // campaigns run through `pnpm vda run <fixture>` and spend quota.
          environment: "node",
          testTimeout: 15_000,
        },
      },
      {
        resolve: {
          alias: {
            "validation-architect": resolve(import.meta.dirname, "src/api/index.ts"),
          },
        },
        test: {
          name: "design",
          include: ["design/test/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          environment: "node",
          testTimeout: 15_000,
        },
      },
    ],
  },
});
