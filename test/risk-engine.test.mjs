import test from "node:test";
import assert from "node:assert/strict";
import { assessRisk, deriveFeatures } from "../lib/risk-engine.mjs";

test("raises a critical explainable alert for hard braking near a hazard", () => {
  const prior = { t: 0, speed: 250 };
  const current = { t: 500, speed: 220, yellow: true };
  const features = deriveFeatures(current, prior, 55);
  const result = assessRisk(current, features);
  assert.equal(result.level, "CRITICAL");
  assert.ok(result.reasons.some((reason) => reason.label === "Severe deceleration"));
  assert.ok(result.reasons.some((reason) => reason.label === "Short arrival window"));
});

test("keeps ordinary running clear", () => {
  const current = { t: 500, speed: 200, yellow: false };
  const features = deriveFeatures(current, { t: 0, speed: 199 }, 800);
  assert.equal(assessRisk(current, features).level, "CLEAR");
});
