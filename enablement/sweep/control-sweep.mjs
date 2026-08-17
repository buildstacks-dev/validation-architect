/**
 * Recurring falsifiability sweep for negative controls (VA-ENF-008).
 *
 * Standing scheduled-lane obligation for product repos that adopt it:
 * re-prove, on a cadence, that every LANDED negative control can still make
 * its detector fire. Per control the sweep runs the detector command twice —
 * once unseeded, expecting green, and once with VA_SEEDED_CONTROL=<control-id>
 * in the environment, expecting RED. A control whose seeded run stays green
 * cannot go red and fails the sweep; a detector whose unseeded baseline is
 * not green fails too (a broken command is not red-capability); a sweep that
 * swept nothing fails rather than passes (design rule 17).
 *
 * The convention the sweep runs on (documented in the audit skill's
 * harness-policy-conformance reference and the implement-harness-ticket
 * skill): control tests are identified BY ID through the checked model — the
 * inventory join maps each control to the tests that implement it — and every
 * negative-control test seeds its declared violation when VA_SEEDED_CONTROL
 * names its control id. Detector selection, commands, and status come from
 * the compiled corpus via the public validation-architect API; this script
 * never re-derives design meaning from prose.
 *
 * Adoption is opt-in per model: activate the `scheduled` lane with this
 * script as its command (see enablement/ci/control-sweep.yml for the CI
 * half). A corpus that does not adopt it compiles and checks exactly as
 * before. Status-aware like the closure checks: controls of pending, blocked,
 * or parked tickets are reported as skipped, never failed.
 *
 * Usage: node control-sweep.mjs [target-dir]
 */

import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/** Minimal read-only RepositoryPort over a local checkout. */
export function createLocalPort(root) {
  const revision = () => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "unversioned";
    }
  };
  const walk = async (dir, out) => {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path, out);
      else out.push(relative(root, path).replaceAll("\\", "/"));
    }
    return out;
  };
  return {
    revision: async () => revision(),
    readFile: async (path) => {
      try {
        return await readFile(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    listFiles: async (globs) => {
      const all = await walk(root, []);
      const prefixes = globs.map((glob) => glob.split("*")[0].replace(/\/$/, ""));
      return all.filter((path) => prefixes.some((prefix) => prefix === "" || path === prefix || path.startsWith(`${prefix}/`)));
    },
    changedPaths: async () => [],
  };
}

/**
 * Deterministic sweep plan from the public relationship graph: one entry per
 * negative control of an implementable, test-lane family whose owner ticket
 * is landed. Controls of non-landed tickets and evidence-lane families are
 * reported as skipped, never failed.
 */
export function planControlSweep(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const ticketByFamily = new Map(
    graph.edges.filter((edge) => edge.type === "delivered-by").map((edge) => [edge.from, edge.to]),
  );
  const testsByControl = new Map();
  for (const edge of graph.edges) {
    if (edge.type !== "implemented-by") continue;
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from?.kind !== "control" || to?.kind !== "test") continue;
    const tests = testsByControl.get(from.id) ?? [];
    tests.push(to);
    testsByControl.set(from.id, tests);
  }

  const entries = [];
  const skipped = [];
  for (const control of graph.nodes.filter((node) => node.kind === "control")) {
    const family = nodes.get(control.details.family_id);
    if (!family || family.kind !== "family") continue;
    if (family.details.status !== "implementable") {
      skipped.push({ control_id: control.id, family_id: family.id, reason: `family is ${family.details.status}` });
      continue;
    }
    const planned = family.details.planned_tests ?? [];
    if (planned.length === 0) {
      skipped.push({ control_id: control.id, family_id: family.id, reason: "evidence-lane family; its control lives outside the test inventory" });
      continue;
    }
    const ticket = nodes.get(ticketByFamily.get(family.id) ?? "");
    const ticketStatus = ticket?.kind === "ticket" ? ticket.details.status : undefined;
    if (ticketStatus !== "landed") {
      skipped.push({ control_id: control.id, family_id: family.id, reason: `owner ticket is ${ticketStatus ?? "unknown"}` });
      continue;
    }
    const tests = testsByControl.get(control.id) ?? [];
    const command = tests.map((test) => test.details.command).find((value) => typeof value === "string" && value.length > 0);
    const paths = [...new Set(tests.map((test) => test.path).filter(Boolean))].sort();
    entries.push({
      control_id: control.id,
      family_id: family.id,
      expected_failure: control.meaning,
      command,
      paths,
    });
  }
  entries.sort((left, right) => left.control_id.localeCompare(right.control_id));
  skipped.sort((left, right) => left.control_id.localeCompare(right.control_id));
  return { entries, skipped };
}

function defaultExecute({ command, paths, cwd, env }) {
  return new Promise((resolveExit) => {
    const child = spawn(`${command} ${paths.join(" ")}`.trim(), {
      shell: true,
      cwd,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    child.on("error", () => resolveExit(1));
    child.on("close", (code) => resolveExit(code ?? 1));
  });
}

/**
 * Run the plan: per control, unseeded baseline must be green and the seeded
 * run must be red. Returns the process exit code (0 only when every planned
 * control proved it can go red).
 */
export async function runControlSweep(plan, { cwd, execute = defaultExecute, log = console.log } = {}) {
  let failures = 0;
  for (const entry of plan.entries) {
    if (!entry.command || entry.paths.length === 0) {
      failures += 1;
      log(`FAIL ${entry.control_id}: no runnable implemented test (command or observed spec missing); the check closure should already be red.`);
      continue;
    }
    const baseline = await execute({ command: entry.command, paths: entry.paths, cwd, env: {} });
    if (baseline !== 0) {
      failures += 1;
      log(`FAIL ${entry.control_id}: unseeded baseline run is not green (exit ${baseline}); a broken detector run is not red-capability.`);
      continue;
    }
    const seeded = await execute({
      command: entry.command,
      paths: entry.paths,
      cwd,
      env: { VA_SEEDED_CONTROL: entry.control_id },
    });
    if (seeded === 0) {
      failures += 1;
      log(`FAIL ${entry.control_id}: detector cannot go red against its seeded violation (${entry.expected_failure}).`);
      continue;
    }
    log(`ok   ${entry.control_id}: baseline green, went red under seed (exit ${seeded}).`);
  }
  return failures === 0 ? 0 : 1;
}

export async function main(target = ".", options = {}) {
  const log = options.log ?? console.log;
  const api = options.api ?? (await import("validation-architect"));
  const repo = createLocalPort(target);
  let graph;
  try {
    graph = (await api.explain(repo, "control-sweep")).graph;
  } catch (error) {
    log(`control sweep: corpus did not compile — ${error?.message ?? error}`);
    return 1;
  }
  const plan = planControlSweep(graph);
  for (const item of plan.skipped) {
    log(`skip ${item.control_id} (${item.family_id}): ${item.reason}.`);
  }
  if (plan.entries.length === 0) {
    log("control sweep: swept no landed control — refusing to pass on an empty walk (rule 17).");
    return 1;
  }
  log(`control sweep: proving ${plan.entries.length} landed control(s) can go red.`);
  return runControlSweep(plan, { cwd: target, log, ...(options.execute ? { execute: options.execute } : {}) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv[2] ?? ".");
}
