import test from "node:test";
import assert from "node:assert/strict";
import {
  brakeByWindow, buildStressReport, deriveLatencyBoundary, directLatencyTolerance, evaluateScenario, expectedRetries, featureVector,
  fitFailureModel, generateScenarios, predictFailure, sampleRetries, simulateApproach, timeToHazard,
  MODEL_ASSUMPTIONS, REFERENCE_CONDITIONS, SCENARIO_RANGES,
} from "../lib/stress-engine.mjs";

const base = { distanceM: 470, speedKph: 252 };
const reference = { ...base, ...REFERENCE_CONDITIONS };
const clean = { ...base, latencyS: 0, packetLoss: 0, grip: 1, sensorDropout: false, driverDelayS: 0 };
const report = buildStressReport(base);

test("time to hazard is distance over current speed", () => {
  assert.equal(timeToHazard(280, 252), 4);
  assert.equal(timeToHazard(470, 252), 6.71);
  assert.equal(timeToHazard(100, 0), null);
});

test("brake-by window matches closed-form stopping kinematics", () => {
  const v = 252 / 3.6, a = MODEL_ASSUMPTIONS.dryDecelerationMs2 * 0.76;
  const expected = (470 - MODEL_ASSUMPTIONS.safetyMarginM - (v * v) / (2 * a)) / v;
  assert.ok(Math.abs(brakeByWindow(470, 252, 0.76) - expected) < 0.01);
});

test("unwarned stop distance matches closed form within one simulation step", () => {
  // Hazard visible from the start: reaction then constant full braking.
  const input = { ...clean, distanceM: 200, speedKph: 100 };
  const v = 100 / 3.6, a = MODEL_ASSUMPTIONS.dryDecelerationMs2;
  const closedForm = 200 - (v * MODEL_ASSUMPTIONS.reactionBaselineS + (v * v) / (2 * a));
  const result = simulateApproach(input, "none");
  assert.ok(Math.abs(result.clearanceM - closedForm) < v * MODEL_ASSUMPTIONS.simulationStepS + 0.1, `${result.clearanceM} vs ${closedForm}`);
});

test("interventions only act after the warning is delivered and the driver reacts", () => {
  const result = simulateApproach({ ...reference, latencyS: 0.8 }, "doubleYellow", MODEL_ASSUMPTIONS, { trace: true });
  const expectedCommand = 0.8 + expectedRetries(0.12) * MODEL_ASSUMPTIONS.packetRetryIntervalS + MODEL_ASSUMPTIONS.reactionBaselineS + 0.45;
  assert.ok(Math.abs(result.timeline.commandAtS - expectedCommand) < 0.01);
  const beforeCommand = result.trace.filter((p) => p.t < result.timeline.commandAtS - 0.01);
  assert.ok(beforeCommand.length > 0 && beforeCommand.every((p) => p.v === 252), "speed must be unchanged before the command");
});

test("no connected warning is unaffected by network, packet loss and sensor faults", () => {
  const a = evaluateScenario({ ...reference, latencyS: 0 }, "none");
  const b = evaluateScenario({ ...reference, latencyS: 2.4, packetLoss: 0.38, sensorDropout: true, retries: 5 }, "none");
  assert.deepEqual(a, b);
});

test("a warning that arrives after the hazard is visible cannot beat the driver's own eyes", () => {
  const late = { ...reference, latencyS: 6 };
  assert.equal(evaluateScenario(late, "doubleYellow").marginM, evaluateScenario(late, "none").marginM);
});

test("stopping margin never improves as any single degradation worsens", () => {
  const margin = (patch) => evaluateScenario({ ...reference, latencyS: 0.4, ...patch }).marginM;
  for (let latencyS = 0; latencyS < 2.4; latencyS += 0.2) assert.ok(margin({ latencyS: latencyS + 0.2 }) <= margin({ latencyS }) + 1e-9);
  for (let grip = 1; grip > 0.56; grip -= 0.05) assert.ok(margin({ grip: grip - 0.05 }) <= margin({ grip }) + 1e-9);
  assert.ok(margin({ driverDelayS: 1 }) < margin({ driverDelayS: 0 }));
  assert.ok(margin({ sensorDropout: true }) < margin({ sensorDropout: false }));
  assert.ok(margin({ retries: 3 }) < margin({ retries: 0 }));
});

test("sensor dropout adds exactly its fallback penalty to detection", () => {
  const ok = simulateApproach({ ...reference, latencyS: 0.5 }, "doubleYellow");
  const dropped = simulateApproach({ ...reference, latencyS: 0.5, sensorDropout: true }, "doubleYellow");
  assert.equal(dropped.timeline.detectionS, MODEL_ASSUMPTIONS.sensorFallbackPenaltyS);
  assert.ok(Math.abs(dropped.timeline.warningAtS - ok.timeline.warningAtS - MODEL_ASSUMPTIONS.sensorFallbackPenaltyS) < 1e-9);
});

test("packet loss uses geometric retries: expected value and seeded sampling", () => {
  assert.ok(Math.abs(expectedRetries(0.2) - 0.25) < 1e-12);
  assert.equal(expectedRetries(0), 0);
  let seed = 0;
  const alwaysLose = () => 0; // random() < p is always true
  assert.equal(sampleRetries(0.5, alwaysLose), MODEL_ASSUMPTIONS.maxRetries);
  assert.equal(sampleRetries(0, () => (seed += 0.1) % 1), 0);
});

test("invalid scenario inputs are rejected instead of producing NaN", () => {
  assert.throws(() => simulateApproach({ ...reference, latencyS: Number.NaN }), TypeError);
  assert.throws(() => simulateApproach({ ...reference, latencyS: 0.5, packetLoss: 1 }), RangeError);
  assert.throws(() => simulateApproach({ ...reference, latencyS: -0.1 }), RangeError);
  assert.throws(() => simulateApproach({ ...reference, latencyS: 0 }, "redFlag"), RangeError);
});

test("stress generation is deterministic, covers every stratum and all outcome bands", () => {
  const first = generateScenarios(base, 600, 9);
  assert.deepEqual(first, generateScenarios(base, 600, 9));
  assert.equal(new Set(first.map((s) => s.outcome)).size, 3);
  for (const key of ["latencyS", "grip", "driverDelayS"]) {
    const [min, max] = SCENARIO_RANGES[key];
    const bins = new Set(first.map((s) => Math.min(9, Math.floor(((s[key] - min) / (max - min)) * 10))));
    assert.equal(bins.size, 10, `${key} should cover every decile`);
  }
});

test("model features are normalised to [0, 1] over the tested range", () => {
  for (const s of generateScenarios(base, 300, 3)) for (const value of featureVector(s)) assert.ok(value >= -1e-9 && value <= 1 + 1e-9);
  assert.deepEqual(featureVector({ latencyS: 2.4, packetLoss: 0.38, grip: 0.55, sensorDropout: true, driverDelayS: 1.15 }).map((v) => Math.round(v * 1e6) / 1e6), [1, 1, 1, 1, 1]);
});

test("failure model converges and is judged on held-out data against a baseline", () => {
  const { holdout, training } = report.model;
  assert.equal(training.converged, true);
  assert.equal(holdout.n + training.n, report.count);
  assert.ok(holdout.accuracy > holdout.majorityBaseline, "must beat always-predict-majority");
  assert.ok(holdout.balancedAccuracy > 75);
  const { tp, fp, tn, fn } = holdout.confusion;
  assert.equal(tp + fp + tn + fn, holdout.n);
});

test("boundary is solved from the fitted weights, not typed in", () => {
  const { fitted } = report.boundary;
  assert.equal(fitted.status, "within-range");
  const model = { weights: report.model.weights };
  assert.ok(Math.abs(predictFailure(model, { ...reference, latencyS: fitted.latencyS }) - 50) < 1.5);
  // Changing the fitted weights must move the boundary.
  const shifted = { weights: [...report.model.weights] };
  shifted.weights[0] -= 1;
  assert.ok(deriveLatencyBoundary(reference, shifted).latencyS > fitted.latencyS);
});

test("boundary never extrapolates past the tested range and flags unsafe-at-zero", () => {
  const safeModel = { weights: [-50, 1, 0, 0, 0, 0] };
  assert.deepEqual(deriveLatencyBoundary(reference, safeModel).status, "beyond-tested-range");
  assert.equal(deriveLatencyBoundary(reference, safeModel).latencyS, null);
  const unsafeModel = { weights: [5, 1, 0, 0, 0, 0] };
  assert.equal(deriveLatencyBoundary(reference, unsafeModel).status, "unsafe-at-zero");
});

test("fitted boundary agrees with the model-free simulator sweep", () => {
  const direct = directLatencyTolerance(reference);
  assert.equal(direct.status, "within-range");
  assert.ok(Math.abs(direct.latencyS - report.boundary.fitted.latencyS) < 0.25, `fitted ${report.boundary.fitted.latencyS} vs direct ${direct.latencyS}`);
  assert.equal(evaluateScenario({ ...reference, latencyS: direct.latencyS }).outcome, "UNSAFE");
  assert.notEqual(evaluateScenario({ ...reference, latencyS: direct.latencyS - 0.01 }).outcome, "UNSAFE");
});

test("every intervention is evaluated on the identical scenario set", () => {
  assert.equal(report.interventions.length, 4);
  for (const item of report.interventions) {
    assert.equal(item.evaluated, report.count);
    assert.equal(item.scenarioSet, report.scenarioSet);
    assert.equal(item.safe + item.marginal + item.unsafe, report.count);
  }
  const primary = report.interventions.find((item) => item.primary);
  assert.deepEqual({ safe: primary.safe, marginal: primary.marginal, unsafe: primary.unsafe }, report.totals);
});

test("a connected warning is never worse than no warning on any scenario", () => {
  const scenarios = generateScenarios(base, 400, 21);
  for (const s of scenarios) for (const key of ["yellow", "doubleYellow", "vsc"]) assert.ok(evaluateScenario(s, key).marginM >= evaluateScenario(s, "none").marginM - 0.5);
});

test("report is deterministic and exposes compact scenario rows", () => {
  const again = buildStressReport(base);
  assert.deepEqual(again.totals, report.totals);
  assert.deepEqual(again.boundary, report.boundary);
  assert.equal(report.scenarios.length, report.count);
  assert.equal(report.scenarios[0].length, 9);
});

test("fitFailureModel reports contributors sorted by magnitude", () => {
  const model = fitFailureModel(generateScenarios(base, 500, 5));
  const magnitudes = model.contributors.map((c) => Math.abs(c.coefficient));
  assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
});
