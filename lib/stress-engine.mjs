// ChainBreak stress engine.
// Pure, dependency-free module shared by the server (sweep + model fit) and the
// browser (live scenario inspector). Everything here is a prototype model with
// explicit assumptions — not a certified safety or crash-probability model.

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-clamp(value, -30, 30)));

export const MODEL_ASSUMPTIONS = Object.freeze({
  reactionBaselineS: 0.72,          // alert-driver perception–reaction time
  dryDecelerationMs2: 11.2,         // conservative full braking on a dry track (~1.1 g)
  minimumDecelerationMs2: 2.5,      // floor so very low grip never divides by ~0
  safetyMarginM: 18,                // buffer the car must stop outside of
  sightDistanceM: 250,              // distance at which the stationary car becomes visible
  sensorFallbackPenaltyS: 0.32,     // extra detection time when the incident-node sensor drops out
  packetRetryIntervalS: 0.3,        // each lost transmission adds one retry interval
  maxRetries: 12,
  simulationStepS: 0.01,
  outcomeBands: Object.freeze({ safeMarginM: 28, marginalMarginM: 0 }),
  note: "Prototype stopping-envelope simulation. Outcome counts describe coverage of the chosen stress range, not real-world crash probabilities.",
});

// Stress envelope that the sweep samples. Uniform coverage of a test range, not
// a claim about how often these conditions occur in racing.
export const SCENARIO_RANGES = Object.freeze({
  latencyS: Object.freeze([0, 2.4]),
  packetLoss: Object.freeze([0, 0.38]),
  grip: Object.freeze([0.55, 1]),
  driverDelayS: Object.freeze([0, 1.15]),
  sensorDropoutRate: 0.16,
});

// Conditions held fixed when a single latency boundary is quoted.
export const REFERENCE_CONDITIONS = Object.freeze({ packetLoss: 0.12, grip: 0.76, sensorDropout: false, driverDelayS: 0.45 });

// Every connected intervention is delivered through the same degraded chain
// (detection → decision → network → driver). Nothing changes the car's speed
// before the driver has received and reacted to the message.
export const INTERVENTIONS = Object.freeze({
  none: Object.freeze({ label: "No connected warning", connected: false, decisionS: 0, commandDecelMs2: 0, targetSpeedFactor: 1, summary: "Driver reacts only on sighting the stationary car." }),
  yellow: Object.freeze({ label: "Yellow", connected: true, decisionS: 0, commandDecelMs2: 4, targetSpeedFactor: 0.8, summary: "Automatic light-panel yellow: lift and brake gently to 80% speed." }),
  doubleYellow: Object.freeze({ label: "Double yellow", connected: true, decisionS: 0, commandDecelMs2: 7, targetSpeedFactor: 0.5, summary: "Automatic double yellow: be prepared to stop, brake firmly to 50% speed." }),
  vsc: Object.freeze({ label: "Virtual Safety Car", connected: true, decisionS: 1.5, commandDecelMs2: 5, targetSpeedFactor: 0.6, summary: "Race-director VSC: +1.5 s decision, then slow to a 60% delta speed." }),
});

// The connected system under test: incident node auto-triggers a double yellow.
export const PRIMARY_INTERVENTION = "doubleYellow";

export const MODEL_FEATURES = Object.freeze([
  Object.freeze({ key: "latency", label: "Network latency", range: "0 → 2.4 s" }),
  Object.freeze({ key: "packetLoss", label: "Packet loss", range: "0 → 38%" }),
  Object.freeze({ key: "gripLoss", label: "Reduced grip", range: "1.00 → 0.55 grip" }),
  Object.freeze({ key: "sensorDropout", label: "Sensor dropout", range: "off → on" }),
  Object.freeze({ key: "driverDelay", label: "Driver response delay", range: "0 → 1.15 s" }),
]);

export function timeToHazard(distanceM, speedKph) {
  const speedMs = Number(speedKph) / 3.6;
  return speedMs > 0.1 ? Number((Number(distanceM) / speedMs).toFixed(2)) : null;
}

export function fullDeceleration(grip, assumptions = MODEL_ASSUMPTIONS) {
  return Math.max(assumptions.minimumDecelerationMs2, assumptions.dryDecelerationMs2 * grip);
}

// Latest moment full braking can start and still stop outside the safety margin.
export function brakeByWindow(distanceM, speedKph, grip = REFERENCE_CONDITIONS.grip, assumptions = MODEL_ASSUMPTIONS) {
  const speedMs = Number(speedKph) / 3.6;
  if (speedMs <= 0.1) return null;
  const stoppingM = (speedMs * speedMs) / (2 * fullDeceleration(grip, assumptions));
  return round((distanceM - assumptions.safetyMarginM - stoppingM) / speedMs);
}

// Expected lost transmissions before one gets through (geometric distribution).
export function expectedRetries(packetLoss) {
  const p = clamp(Number(packetLoss) || 0, 0, 0.95);
  return p / (1 - p);
}

export function sampleRetries(packetLoss, random, maxRetries = MODEL_ASSUMPTIONS.maxRetries) {
  let retries = 0;
  while (retries < maxRetries && random() < packetLoss) retries += 1;
  return retries;
}

export function classifyMargin(marginM, assumptions = MODEL_ASSUMPTIONS) {
  if (marginM >= assumptions.outcomeBands.safeMarginM) return "SAFE";
  return marginM >= assumptions.outcomeBands.marginalMarginM ? "MARGINAL" : "UNSAFE";
}

// Time-stepped approach of the following car toward a stationary car at the
// incident node. Worst case: the track is blocked, so the car must stop.
export function simulateApproach(input, interventionKey = PRIMARY_INTERVENTION, assumptions = MODEL_ASSUMPTIONS, { trace = false } = {}) {
  const intervention = INTERVENTIONS[interventionKey];
  if (!intervention) throw new RangeError(`Unknown intervention "${interventionKey}"`);
  validateInput(input);

  const speed0 = input.speedKph / 3.6;
  const brakeDecel = fullDeceleration(input.grip, assumptions);
  const retries = Number.isFinite(input.retries) ? input.retries : expectedRetries(input.packetLoss);
  const reactionS = assumptions.reactionBaselineS + input.driverDelayS;
  const detectionS = input.sensorDropout ? assumptions.sensorFallbackPenaltyS : 0;
  const networkS = input.latencyS + retries * assumptions.packetRetryIntervalS;
  const warningAtS = intervention.connected ? detectionS + intervention.decisionS + networkS : null;
  const commandAtS = warningAtS === null ? Infinity : warningAtS + reactionS;
  const commandDecel = Math.min(intervention.commandDecelMs2, brakeDecel);
  const targetMs = speed0 * intervention.targetSpeedFactor;

  let t = 0, x = 0, v = speed0, sightedAtS = null, impactSpeedMs = null, impactAtS = null;
  const points = trace ? [{ t: 0, x: 0, v: round(v * 3.6, 1), phase: "cruise" }] : null;
  let nextTraceT = 0.1;

  while (v > 0 && t < 120) {
    if (sightedAtS === null && input.distanceM - x <= assumptions.sightDistanceM) sightedAtS = t;
    const emergencyAtS = sightedAtS === null ? Infinity : sightedAtS + reactionS;
    let a = 0, phase = "cruise";
    if (t >= emergencyAtS) { a = brakeDecel; phase = "brake"; }
    else if (t >= commandAtS && v > targetMs) { a = commandDecel; phase = "command"; }

    let h = assumptions.simulationStepS;
    const floorMs = phase === "command" ? targetMs : 0;
    if (a > 0 && v - a * h < floorMs) h = (v - floorMs) / a;

    const nextX = x + v * h - 0.5 * a * h * h;
    if (impactSpeedMs === null && nextX >= input.distanceM) {
      const remaining = input.distanceM - x;
      impactSpeedMs = Math.sqrt(Math.max(0, v * v - 2 * a * remaining));
      impactAtS = t + (a > 0 ? (v - impactSpeedMs) / a : remaining / v);
    }
    x = nextX;
    v = Math.max(floorMs, v - a * h);
    if (phase !== "command" && a > 0 && v < 1e-9) v = 0;
    t += h;
    if (points && (t >= nextTraceT || v === 0)) {
      points.push({ t: round(t), x: round(x, 1), v: round(v * 3.6, 1), phase });
      nextTraceT = t + 0.1;
    }
  }

  const clearanceM = input.distanceM - x;
  const marginM = clearanceM - assumptions.safetyMarginM;
  const emergencyAtS = sightedAtS === null ? null : sightedAtS + reactionS;
  return {
    intervention: interventionKey,
    outcome: classifyMargin(marginM, assumptions),
    marginM: round(marginM, 1),
    clearanceM: round(clearanceM, 1),
    impactSpeedKph: impactSpeedMs === null ? null : round(impactSpeedMs * 3.6, 0),
    retries: intervention.connected ? round(retries, 2) : null,
    networkS: intervention.connected ? round(networkS) : null,
    warnedBeforeSighting: warningAtS !== null && sightedAtS !== null ? warningAtS < sightedAtS : warningAtS !== null,
    timeline: {
      detectionS: intervention.connected ? round(detectionS) : null,
      decisionS: intervention.connected ? intervention.decisionS : null,
      warningAtS: warningAtS === null ? null : round(warningAtS),
      commandAtS: Number.isFinite(commandAtS) ? round(commandAtS) : null,
      sightedAtS: sightedAtS === null ? null : round(sightedAtS),
      emergencyAtS: emergencyAtS === null ? null : round(emergencyAtS),
      impactAtS: impactAtS === null ? null : round(impactAtS),
      stoppedAtS: round(t),
      reactionS: round(reactionS),
    },
    trace: points,
  };
}

// Compact result used by the sweep.
export function evaluateScenario(input, interventionKey = PRIMARY_INTERVENTION, assumptions = MODEL_ASSUMPTIONS) {
  const { outcome, marginM, clearanceM, impactSpeedKph, networkS, warnedBeforeSighting } = simulateApproach(input, interventionKey, assumptions);
  return { outcome, marginM, clearanceM, impactSpeedKph, networkS, warnedBeforeSighting };
}

// Seeded Latin-hypercube sweep: every continuous variable is stratified so the
// 1,200 runs cover its whole range evenly.
export function generateScenarios(base, count = 1200, seed = 7331, ranges = SCENARIO_RANGES) {
  const random = mulberry32(seed);
  const strata = ["latencyS", "packetLoss", "grip", "driverDelayS"].reduce((all, key) => ({ ...all, [key]: shuffle([...Array(count).keys()], random) }), {});
  const sample = (key, i) => ranges[key][0] + ((strata[key][i] + random()) / count) * (ranges[key][1] - ranges[key][0]);
  return Array.from({ length: count }, (_, i) => {
    const packetLoss = round(sample("packetLoss", i), 3);
    const scenario = {
      id: i + 1,
      distanceM: base.distanceM,
      speedKph: base.speedKph,
      latencyS: round(sample("latencyS", i)),
      packetLoss,
      grip: round(sample("grip", i), 3),
      sensorDropout: random() < ranges.sensorDropoutRate,
      driverDelayS: round(sample("driverDelayS", i)),
      retries: sampleRetries(packetLoss, random),
    };
    return { ...scenario, ...evaluateScenario(scenario) };
  });
}

// Every feature is scaled to [0, 1] across its tested range, so each coefficient
// is the change in log-odds of UNSAFE across that feature's whole range.
export function featureVector(scenario, ranges = SCENARIO_RANGES) {
  return [
    normalize(scenario.latencyS, ranges.latencyS),
    normalize(scenario.packetLoss, ranges.packetLoss),
    normalize(ranges.grip[1] - scenario.grip, [0, ranges.grip[1] - ranges.grip[0]]),
    scenario.sensorDropout ? 1 : 0,
    normalize(scenario.driverDelayS, ranges.driverDelayS),
  ];
}

// L2-regularised logistic regression fitted by Newton–Raphson (IRLS) on a
// seeded 80% training split; quality is reported on the untouched 20%.
export function fitFailureModel(scenarios, { holdoutFraction = 0.2, seed = 99, l2 = 1, ranges = SCENARIO_RANGES } = {}) {
  const order = shuffle([...scenarios.keys()], mulberry32(seed));
  const holdoutSize = Math.round(scenarios.length * holdoutFraction);
  const holdoutIdx = order.slice(0, holdoutSize), trainIdx = order.slice(holdoutSize);
  const X = scenarios.map((s) => featureVector(s, ranges));
  const y = scenarios.map((s) => (s.outcome === "UNSAFE" ? 1 : 0));
  const fit = fitLogistic(trainIdx.map((i) => X[i]), trainIdx.map((i) => y[i]), l2);

  const trainPositive = trainIdx.filter((i) => y[i] === 1).length;
  const majorityClass = trainPositive * 2 >= trainIdx.length ? 1 : 0;
  const evaluation = evaluate(fit.weights, holdoutIdx.map((i) => X[i]), holdoutIdx.map((i) => y[i]), majorityClass);

  const features = MODEL_FEATURES.map((feature, j) => ({ ...feature, coefficient: round(fit.weights[j + 1], 3), oddsMultiplier: round(Math.exp(fit.weights[j + 1]), 1) }));
  return {
    weights: fit.weights,
    intercept: round(fit.weights[0], 3),
    features,
    contributors: [...features].sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient)),
    training: { n: trainIdx.length, positives: trainPositive, iterations: fit.iterations, converged: fit.converged, l2, method: "Newton–Raphson (IRLS)" },
    holdout: evaluation,
    accuracy: evaluation.accuracy,
  };
}

export function predictFailure(model, scenario, ranges = SCENARIO_RANGES) {
  return round(predict(model.weights, featureVector(scenario, ranges)) * 100, 1);
}

// Solve the fitted model for the latency where P(UNSAFE) = 50% with every other
// variable held at the reference. Only answers inside the tested latency range.
export function deriveLatencyBoundary(reference, model, ranges = SCENARIO_RANGES) {
  const wLatency = model.weights[1];
  const atZero = { ...reference, latencyS: ranges.latencyS[0] };
  const logitAtZero = model.weights[0] + featureVector(atZero, ranges).reduce((sum, value, j) => sum + value * model.weights[j + 1], 0);
  const probabilityAtZero = round(sigmoid(logitAtZero) * 100, 1);
  if (logitAtZero >= 0) return { latencyS: 0, status: "unsafe-at-zero", probabilityAtZero };
  if (wLatency <= 0) return { latencyS: null, status: "no-latency-effect", probabilityAtZero };
  const latencyS = ranges.latencyS[0] + (-logitAtZero / wLatency) * (ranges.latencyS[1] - ranges.latencyS[0]);
  if (latencyS > ranges.latencyS[1]) return { latencyS: null, status: "beyond-tested-range", probabilityAtZero };
  return { latencyS: round(latencyS), status: "within-range", probabilityAtZero };
}

// Model-free check: step latency through the simulator itself at the reference
// conditions and report the first value that produces UNSAFE.
export function directLatencyTolerance(reference, interventionKey = PRIMARY_INTERVENTION, ranges = SCENARIO_RANGES, step = 0.01) {
  const steps = Math.round((ranges.latencyS[1] - ranges.latencyS[0]) / step);
  for (let i = 0; i <= steps; i += 1) {
    const latencyS = round(ranges.latencyS[0] + i * step);
    if (evaluateScenario({ ...reference, latencyS }, interventionKey).outcome === "UNSAFE") {
      return i === 0 ? { latencyS: 0, status: "unsafe-at-zero" } : { latencyS, status: "within-range" };
    }
  }
  return { latencyS: null, status: "beyond-tested-range" };
}

export function scenarioSetFingerprint(scenarios) {
  let hash = 0x811c9dc5;
  for (const s of scenarios) {
    const key = `${s.id}|${s.distanceM}|${s.speedKph}|${s.latencyS}|${s.packetLoss}|${s.grip}|${s.sensorDropout ? 1 : 0}|${s.driverDelayS}|${s.retries};`;
    for (let i = 0; i < key.length; i += 1) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function compareInterventions(scenarios, reference) {
  const fingerprint = scenarioSetFingerprint(scenarios);
  return Object.entries(INTERVENTIONS).map(([key, intervention]) => {
    const results = scenarios.map((scenario) => evaluateScenario(scenario, key));
    const counts = countOutcomes(results);
    return {
      key,
      label: intervention.label,
      summary: intervention.summary,
      primary: key === PRIMARY_INTERVENTION,
      evaluated: results.length,
      scenarioSet: fingerprint,
      ...counts,
      unsafeRate: round((counts.unsafe / results.length) * 100, 1),
      medianMarginM: round(median(results.map((r) => r.marginM)), 1),
      latencyTolerance: intervention.connected ? directLatencyTolerance(reference, key) : { latencyS: null, status: "not-connected" },
    };
  });
}

export function buildStressReport(base, options = {}) {
  const { count = 1200, seed = 7331 } = typeof options === "number" ? { count: options } : options;
  const scenarios = generateScenarios(base, count, seed);
  const model = fitFailureModel(scenarios);
  const reference = { distanceM: base.distanceM, speedKph: base.speedKph, ...REFERENCE_CONDITIONS };
  const boundary = deriveLatencyBoundary(reference, model);
  return {
    count,
    seed,
    sampling: "Seeded Latin hypercube over the stress ranges",
    base: { ...base, timeToHazardS: timeToHazard(base.distanceM, base.speedKph), brakeByWindowS: brakeByWindow(base.distanceM, base.speedKph) },
    systemUnderTest: { key: PRIMARY_INTERVENTION, label: INTERVENTIONS[PRIMARY_INTERVENTION].label, summary: INTERVENTIONS[PRIMARY_INTERVENTION].summary },
    totals: countOutcomes(scenarios),
    model: { weights: model.weights, intercept: model.intercept, features: model.features, contributors: model.contributors, training: model.training, holdout: model.holdout, accuracy: model.accuracy },
    reference,
    boundary: { fitted: boundary, direct: directLatencyTolerance(reference) },
    interventions: compareInterventions(scenarios, reference),
    ranges: SCENARIO_RANGES,
    assumptions: MODEL_ASSUMPTIONS,
    scenarioSet: scenarioSetFingerprint(scenarios),
    // Compact rows: [id, latencyS, packetLoss, grip, sensorDropout, driverDelayS, retries, outcome(0 safe,1 marginal,2 unsafe), marginM]
    scenarios: scenarios.map((s) => [s.id, s.latencyS, s.packetLoss, s.grip, s.sensorDropout ? 1 : 0, s.driverDelayS, s.retries, OUTCOME_CODES[s.outcome], s.marginM]),
  };
}

export const OUTCOME_CODES = Object.freeze({ SAFE: 0, MARGINAL: 1, UNSAFE: 2 });

function countOutcomes(results) {
  return results.reduce((all, r) => ({ ...all, [r.outcome.toLowerCase()]: all[r.outcome.toLowerCase()] + 1 }), { safe: 0, marginal: 0, unsafe: 0 });
}

function validateInput(input) {
  for (const key of ["distanceM", "speedKph", "latencyS", "packetLoss", "grip", "driverDelayS"]) {
    if (!Number.isFinite(input[key])) throw new TypeError(`Scenario field "${key}" must be a finite number`);
  }
  if (input.distanceM <= 0 || input.speedKph < 0 || input.latencyS < 0 || input.driverDelayS < 0) throw new RangeError("Distance must be positive; speed and delays cannot be negative");
  if (input.packetLoss < 0 || input.packetLoss >= 1) throw new RangeError("Packet loss must be in [0, 1)");
  if (input.grip <= 0 || input.grip > 1.5) throw new RangeError("Grip must be in (0, 1.5]");
}

function fitLogistic(X, y, l2, maxIterations = 50, tolerance = 1e-9) {
  const d = X[0].length + 1;
  let weights = Array(d).fill(0), iterations = 0, converged = false;
  while (iterations < maxIterations && !converged) {
    const gradient = Array(d).fill(0);
    const hessian = Array.from({ length: d }, () => Array(d).fill(0));
    X.forEach((x, i) => {
      const z = [1, ...x];
      const p = predict(weights, x);
      const s = p * (1 - p);
      for (let j = 0; j < d; j += 1) {
        gradient[j] += (y[i] - p) * z[j];
        for (let k = 0; k < d; k += 1) hessian[j][k] += s * z[j] * z[k];
      }
    });
    for (let j = 1; j < d; j += 1) { gradient[j] -= l2 * weights[j]; hessian[j][j] += l2; }
    const step = solveLinear(hessian, gradient);
    weights = weights.map((w, j) => w + step[j]);
    iterations += 1;
    converged = Math.max(...step.map(Math.abs)) < tolerance;
  }
  return { weights, iterations, converged };
}

function evaluate(weights, X, y, majorityClass) {
  let tp = 0, tn = 0, fp = 0, fn = 0, logLoss = 0;
  X.forEach((x, i) => {
    const p = predict(weights, x);
    const predicted = p >= 0.5 ? 1 : 0;
    if (predicted === 1 && y[i] === 1) tp += 1; else if (predicted === 0 && y[i] === 0) tn += 1; else if (predicted === 1) fp += 1; else fn += 1;
    logLoss -= y[i] ? Math.log(Math.max(p, 1e-12)) : Math.log(Math.max(1 - p, 1e-12));
  });
  const n = y.length;
  const sensitivity = tp + fn ? tp / (tp + fn) : 0;
  const specificity = tn + fp ? tn / (tn + fp) : 0;
  return {
    n,
    accuracy: round(((tp + tn) / n) * 100, 1),
    balancedAccuracy: round(((sensitivity + specificity) / 2) * 100, 1),
    majorityBaseline: round((y.filter((label) => label === majorityClass).length / n) * 100, 1),
    sensitivity: round(sensitivity * 100, 1),
    specificity: round(specificity * 100, 1),
    logLoss: round(logLoss / n, 3),
    confusion: { tp, fp, tn, fn },
  };
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    if (Math.abs(a[col][col]) < 1e-12) throw new Error("Singular Hessian while fitting failure model");
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / a[col][col];
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  const out = Array(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = a[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= a[row][k] * out[k];
    out[row] = sum / a[row][row];
  }
  return out;
}

function predict(weights, vector) { return sigmoid(weights[0] + vector.reduce((sum, value, i) => sum + value * weights[i + 1], 0)); }
function normalize(value, [min, max]) { return (value - min) / (max - min); }
function median(values) { const sorted = [...values].sort((a, b) => a - b); const mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
function round(value, digits = 2) { return Number(value.toFixed(digits)); }
function shuffle(items, random) { for (let i = items.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; } return items; }
function mulberry32(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
