import type { Marker } from "./types.js";

const MARKERS: Marker[] = ["AWAITING-HUMAN", "REQUEST-READER-TEST", "CAMPAIGN-COMPLETE"];

/**
 * A marker is `<<NAME>>` alone on its own line (surrounding whitespace ok).
 * If several appear, the last one wins — the designer's final word on how the
 * turn should be routed. Inline mentions (e.g. quoting the protocol) are
 * deliberately NOT matched.
 */
export function parseMarker(text: string): Marker | undefined {
  let found: Marker | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    for (const m of MARKERS) {
      if (trimmed === `<<${m}>>`) found = m;
    }
  }
  return found;
}

/** Strip marker lines so the counterpart never sees protocol plumbing. */
export function stripMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !MARKERS.some((m) => trimmed === `<<${m}>>`);
    })
    .join("\n")
    .trimEnd();
}
