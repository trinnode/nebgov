import { computeQuadraticWeight } from "../utils";

describe("computeQuadraticWeight", () => {
  it("returns 0 for balance of 0", () => {
    expect(computeQuadraticWeight(0n)).toBe(0n);
  });

  it("returns 1 for balance of 1", () => {
    expect(computeQuadraticWeight(1n)).toBe(1n);
  });

  it("handles perfect squares", () => {
    expect(computeQuadraticWeight(4n)).toBe(2n);
    expect(computeQuadraticWeight(9n)).toBe(3n);
    expect(computeQuadraticWeight(100n)).toBe(10n);
    expect(computeQuadraticWeight(10000n)).toBe(100n);
    expect(computeQuadraticWeight(1_000_000n)).toBe(1000n);
  });

  it("floors non-perfect squares", () => {
    expect(computeQuadraticWeight(2n)).toBe(1n);
    expect(computeQuadraticWeight(3n)).toBe(1n);
    expect(computeQuadraticWeight(8n)).toBe(2n);
    expect(computeQuadraticWeight(99n)).toBe(9n);
    expect(computeQuadraticWeight(101n)).toBe(10n);
    expect(computeQuadraticWeight(9999n)).toBe(99n);
  });

  it("handles typical token balances with 7 decimal places", () => {
    // 10,000 tokens at 10^7 scale = 100_000_000_000
    const balance = 100_000_000_000n;
    const weight = computeQuadraticWeight(balance);
    expect(weight).toBe(316227n); // floor(sqrt(100_000_000_000))
  });

  it("throws for negative balance", () => {
    expect(() => computeQuadraticWeight(-1n)).toThrow();
  });
});
