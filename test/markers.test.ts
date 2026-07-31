import { describe, expect, it } from "vitest";
import { parseMarker, stripMarkers } from "../src/markers.js";

describe("parseMarker", () => {
  it("finds a marker alone on its own line", () => {
    expect(parseMarker("Some teaching...\n\n<<AWAITING-HUMAN>>")).toBe("AWAITING-HUMAN");
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMarker("text\n   <<CAMPAIGN-COMPLETE>>   \n")).toBe("CAMPAIGN-COMPLETE");
  });

  it("last marker wins when several appear", () => {
    const text = "<<AWAITING-HUMAN>>\nrevised my mind\n<<REQUEST-READER-TEST>>";
    expect(parseMarker(text)).toBe("REQUEST-READER-TEST");
  });

  it("ignores inline mentions that are not alone on a line", () => {
    expect(parseMarker("I will end with <<CAMPAIGN-COMPLETE>> when done.")).toBeUndefined();
    expect(parseMarker("the marker <<AWAITING-HUMAN>> means I expect a reply")).toBeUndefined();
  });

  it("returns undefined when no marker present", () => {
    expect(parseMarker("no protocol here")).toBeUndefined();
  });
});

describe("stripMarkers", () => {
  it("removes marker lines but keeps inline mentions", () => {
    const text = "Please review the boundary map.\n<<AWAITING-HUMAN>>";
    expect(stripMarkers(text)).toBe("Please review the boundary map.");
    const inline = "the marker <<AWAITING-HUMAN>> is documentation";
    expect(stripMarkers(inline)).toBe(inline);
  });
});
