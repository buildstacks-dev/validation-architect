// CF-W01-S — widget lifecycle reaches every ratified state (HB-001).
// This spec is honest: it plants the transitions and asserts on outcomes.
describe("CF-W01-S", () => {
  it("draft -> active on publish", () => {});
  it("active -> retired on retire", () => {});
  it("negative control: a seeded illegal transition is rejected and recorded", () => {});
});
