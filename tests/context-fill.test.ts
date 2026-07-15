import test from "node:test";
import assert from "node:assert/strict";
import { contextFillFromModelUsage, type ModelUsageLike } from "../src/core/context-fill";

const usage = (overrides: Partial<ModelUsageLike>): ModelUsageLike => ({
  inputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  contextWindow: 200_000,
  ...overrides,
});

test("sums input and both cache flavors against the window", () => {
  const fill = contextFillFromModelUsage({
    "claude-fable-5": usage({
      inputTokens: 20_000,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 30_000,
    }),
  });
  assert.equal(fill, 0.75);
});

test("the WORST model wins — one hot model is pressure even if another is cool", () => {
  const fill = contextFillFromModelUsage({
    cool: usage({ inputTokens: 10_000 }),
    hot: usage({ inputTokens: 180_000 }),
  });
  assert.equal(fill, 0.9);
});

test("unknown pressure is NO pressure: missing usage, no models, or broken windows report null", () => {
  assert.equal(contextFillFromModelUsage(undefined), null);
  assert.equal(contextFillFromModelUsage({}), null);
  assert.equal(
    contextFillFromModelUsage({ broken: usage({ contextWindow: 0 }) }),
    null,
    "a zero window must never divide into a trigger",
  );
  assert.equal(
    contextFillFromModelUsage({ broken: usage({ contextWindow: Number.NaN }) }),
    null,
  );
});

test("non-finite token fields count as zero, not poison", () => {
  const fill = contextFillFromModelUsage({
    m: usage({ inputTokens: Number.NaN, cacheReadInputTokens: 100_000 }),
  });
  assert.equal(fill, 0.5);
});
