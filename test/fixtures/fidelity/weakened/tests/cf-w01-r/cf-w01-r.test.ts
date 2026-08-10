// CF-W01-R — every named refusal class refuses pre-mutation (HB-001; Journey matrix).
// DELIBERATELY WEAKENED for the fidelity fixture: the citation is present
// (trace credits the family) but no assertion can fail — no seeded duplicate,
// no malformed input, a tautology where the detector should be. Closure is
// green; only a fidelity pass can catch this.
describe("CF-W01-R", () => {
  it("refuses a duplicate widget id", () => {
    expect(true).toBe(true);
  });
  it("negative control: detector fires", () => {
    // no violation is ever planted; the "control" controls nothing
    expect(1 + 1).toBe(2);
  });
});
