import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "../src/api/index.js";

/**
 * Public-surface detectors (VA-API-002/003): the deterministic function set
 * is exactly seven, the port set is exactly three, and the contract layer's
 * import graph carries no effect-bearing or provider dependency. An eighth
 * deterministic function, a fourth port, or a forbidden import turns one of
 * these red.
 */

const root = join(import.meta.dirname, "..");
const apiDir = join(root, "src", "api");

const DETERMINISTIC_FUNCTIONS = ["compile", "check", "explain", "plan", "ingest", "render", "migrate"] as const;

describe("deterministic entry-point surface", () => {
  it("exports exactly the seven deterministic functions", () => {
    const entryModule = readFileSync(join(apiDir, "entry-points.ts"), "utf8");
    const exported = [...entryModule.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]);
    expect(exported.sort()).toEqual([...DETERMINISTIC_FUNCTIONS].sort());
    for (const name of DETERMINISTIC_FUNCTIONS) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("declares exactly three injected ports and no fourth effect seam", () => {
    const portsModule = readFileSync(join(apiDir, "ports.ts"), "utf8");
    const contractsModule = readFileSync(join(apiDir, "campaign-contracts.ts"), "utf8");
    const portInterfaces = [...`${portsModule}\n${contractsModule}`.matchAll(/^export interface (\w+Port)\b/gm)].map(
      (match) => match[1],
    );
    expect(portInterfaces.sort()).toEqual(["CampaignStorePort", "RepositoryPort", "TurnPort"]);
  });

  it("RepositoryPort exposes no write, exec, publish, or credential method", () => {
    const portsModule = readFileSync(join(apiDir, "ports.ts"), "utf8");
    const declaration = portsModule.slice(
      portsModule.indexOf("interface RepositoryPort"),
      portsModule.indexOf("export type Seat"),
    );
    expect(declaration).toMatch(/revision\(/);
    expect(declaration).toMatch(/readFile\(/);
    expect(declaration).toMatch(/listFiles\(/);
    expect(declaration).toMatch(/changedPaths\(/);
    expect(declaration).not.toMatch(/write|exec|spawn|publish|credential|token|branch/i);
  });
});

describe("import boundary", () => {
  const FORBIDDEN = [
    /from "node:fs/,
    /from "node:child_process/,
    /from "node:net/,
    /from "node:http/,
    /@anthropic-ai\//,
    /@openai\//,
    /from "\.\.\/orchestrator/,
    /from "\.\.\/designer/,
    /from "\.\.\/stakeholder/,
    /from "\.\.\/readers/,
    /from "\.\.\/auditor/,
    /from "\.\.\/workspace/,
    /from "\.\.\/cli/,
    /from "\.\.\/enablement/,
    /from "\.\.\/fixtures/,
  ];

  it("the api layer imports no filesystem, process, network, provider, or campaign-host module", () => {
    for (const file of readdirSync(apiDir)) {
      const source = readFileSync(join(apiDir, file), "utf8");
      for (const pattern of FORBIDDEN) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("importing the public surface performed no observable effect (module loaded in this suite)", () => {
    // The import at the top of this file executed the whole api module graph.
    // Effect-bearing imports would have needed the forbidden modules above;
    // their absence plus successful load is the offline effect-free evidence.
    expect(Object.keys(api).length).toBeGreaterThan(20);
  });
});

describe("schema asset closure", () => {
  it("every published ID has an asset and every asset has a published ID", () => {
    const assets = readdirSync(join(root, "schemas")).filter((file) => file.endsWith(".schema.json"));
    const ids = Object.values(api.PUBLISHED_SCHEMA_IDS);
    expect(assets.length).toBe(ids.length);
    for (const id of ids) {
      const file = api.schemaAssetFile(id);
      expect(assets).toContain(file);
      const parsed = JSON.parse(readFileSync(join(root, "schemas", file), "utf8"));
      expect(parsed.$id).toBe(id);
    }
  });
});
