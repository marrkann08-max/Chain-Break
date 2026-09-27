import { simulateApproach, predictFailure, fullDeceleration, INTERVENTIONS, PRIMARY_INTERVENTION, REFERENCE_CONDITIONS, MODEL_ASSUMPTIONS, SCENARIO_RANGES, featureVector } from "/engine/stress-engine.mjs";

const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const OUTCOMES = ["SAFE", "MARGINAL", "UNSAFE"];
const count = (n) => Number(n).toLocaleString("en-US");
const signed = (n, digits = 1) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`;

const state = {
  session: null, report: null, stage: "loading", frameIndex: 0, playing: false, replayTimer: null,
  replayed: false, incident: false, runToken: 0, inspected: null, inspectedId: null, animation: null,
  hardwareState: null, hardwareTimer: null, incidentSeqSeen: null, incidentSource: null, linkLostBanner: false,
};

// ---------- small DOM helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value; else if (key === "text") node.textContent = value; else if (key.startsWith("data-")) node.setAttribute(key, value); else node[key] = value;
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}
function svg(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) key === "text" ? (node.textContent = value) : node.setAttribute(key, value);
  if (parent) parent.append(node);
  return node;
}
function dlRows(target, rows) { target.replaceChildren(...rows.map(([term, value, tone]) => el("div", tone ? { "data-tone": tone } : {}, el("dt", { text: term }), el("dd", { text: value })))); }
function setStatus(message, tone = "neutral") { const line = $("#status-line"); line.textContent = message; line.dataset.tone = tone; state.linkLostBanner = false; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { "content-type": "application/json" } : {} });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

// ---------- stage machine ----------
function setStage(stage) {
  state.stage = stage;
  document.body.dataset.stage = stage;
  const ready = stage === "ready";
  $("#btn-replay").disabled = !ready;
  $("#btn-incident").disabled = !ready;
  $("#btn-test").disabled = !(stage === "incident" || stage === "complete");
  $("#btn-reset").disabled = stage === "loading";
  $("#scrubber").disabled = !ready;
  $("#btn-incident").firstChild.textContent = state.incident ? "Incident active " : "Trigger incident node ";
  $("#btn-test").firstChild.textContent = stage === "running" ? "Running… " : stage === "complete" ? "Re-run stress test " : `Run ${count(state.session?.stress.count ?? 1200)} stress tests `;
  const order = ["replay", "incident", "test", "compare"];
  const current = { loading: -1, ready: state.replayed ? 1 : 0, incident: 2, running: 2, complete: 3 }[stage];
  const done = { loading: -1, ready: state.replayed ? 0 : -1, incident: 1, running: 1, complete: 3 }[stage];
  $("#steps").querySelectorAll("li").forEach((li) => {
    const i = order.indexOf(li.dataset.step);
    li.dataset.state = i <= done ? "done" : i === current ? "current" : "todo";
    li.toggleAttribute("aria-current", i === current);
  });
}

// ---------- boot ----------
async function init() {
  setStatus("Loading replay and scenario definition…");
  try {
    state.session = await api("/api/session");
  } catch (error) {
    $("#load-error").hidden = false;
    $("#load-error-detail").textContent = `${error.message}. Start the server with “npm start”, then retry.`;
    setStatus("Server unreachable — the dashboard needs the local ChainBreak server.", "error");
    setChip("#chip-replay", "Unavailable", "bad");
    return;
  }
  $("#load-error").hidden = true;
  const { frames, provenance } = state.session;
  $("#scrubber").max = String(frames.length - 1);
  setChip("#chip-replay", provenance.label, "neutral", provenance.detail);
  $("#approach-tag").textContent = "Replay · synthetic sample";
  $("#sweep-tag").textContent = `Latin hypercube · seed ${state.session.stress.seed}`;
  $("#in-intervention").replaceChildren(...Object.entries(INTERVENTIONS).map(([key, value]) => el("option", { value: key, text: key === PRIMARY_INTERVENTION ? `${value.label} (system under test)` : value.label })));
  buildApproachSvg();
  renderFrame(0);
  renderKpis();
  renderAssumptions(MODEL_ASSUMPTIONS);
  setStage("ready");
  setStatus("Ready. Press Space to replay the telemetry, then I to trigger the incident node.");
  pollHardware();
}

// ---------- replay ----------
function renderFrame(index) {
  const frames = state.session.frames;
  state.frameIndex = Math.max(0, Math.min(frames.length - 1, Number(index)));
  const frame = frames[state.frameIndex];
  $("#scrubber").value = String(state.frameIndex);
  $("#scrubber").setAttribute("aria-valuetext", `t plus ${(frame.t / 1000).toFixed(1)} seconds, ${Math.round(frame.speed)} kilometres per hour`);
  $("#clock").textContent = `t+${(frame.t / 1000).toFixed(1)} s · ${Math.round(frame.speed)} km/h`;
  drawReplay();
}
function toggleReplay() {
  if (state.stage !== "ready") return;
  state.playing = !state.playing;
  if (state.playing) {
    state.replayed = true;
    if (state.frameIndex >= state.session.frames.length - 1) renderFrame(0);
    setStage("ready");
    setStatus("Replaying CAR 16’s recorded approach into the incident node. Press I to trigger the incident at any time.");
    stepReplay();
  } else {
    clearTimeout(state.replayTimer);
    setStatus("Replay paused. Press Space to continue or I to trigger the incident node.");
  }
  $("#btn-replay").firstChild.textContent = state.playing ? "❚❚ Pause replay " : "▶ Replay telemetry ";
}
function stepReplay() {
  clearTimeout(state.replayTimer);
  if (!state.playing) return;
  const last = state.session.frames.length - 1;
  if (state.frameIndex >= last) {
    stopReplay();
    setStatus("Replay complete. Press I to trigger the incident node.");
    return;
  }
  renderFrame(state.frameIndex + 1);
  state.replayTimer = setTimeout(stepReplay, state.session.sampleRateMs);
}
function stopReplay() {
  state.playing = false;
  clearTimeout(state.replayTimer);
  $("#btn-replay").firstChild.textContent = "▶ Replay telemetry ";
}

// Single incident-activation path, used by the I key, the button and real ESP32 packets.
// `hardwareEvent` is the server's record of a received incident:true rising edge.
function triggerIncident(hardwareEvent = null) {
  if (state.stage !== "ready") return false;
  stopReplay();
  state.incident = true;
  state.replayed = true;
  state.incidentSource = hardwareEvent;
  const { incident } = state.session;
  const origin = hardwareEvent ? describeHardwareIncident(hardwareEvent) : "Manual trigger (injected fault)";
  $("#approach-tag").textContent = hardwareEvent ? `Incident from ${hardwareEvent.simulated ? "bench simulator" : "ESP32"} · motion modeled from here` : "Incident active · motion modeled from here";
  $("#approach-note").textContent = `${origin}: CAR 16 stationary at the incident node. The replay is frozen; the following car’s approach is modeled from its stated state (${incident.followingDistanceM} m, ${incident.followingSpeedKph} km/h).`;
  drawReplay();
  renderKpis();
  setStage("incident");
  setStatus(`${origin}. Following car ${incident.followingCar} identified: ${incident.followingDistanceM} m out at ${incident.followingSpeedKph} km/h, ${incident.timeToHazardS} s to the node. Press T to stress-test the warning chain.`, "warn");
  return true;
}
function describeHardwareIncident(event) {
  const node = event.simulated ? `bench simulator (${event.vehicleId})` : `ESP32 node ${event.vehicleId}`;
  const how = event.triggerSource === "button" ? "button press" : event.triggerSource === "imu" ? `IMU impact${event.accelMagnitudeMs2 !== null ? ` ${(event.accelMagnitudeMs2 / 9.81).toFixed(1)} g` : ""}` : "incident flag";
  return `Incident detected by ${node} · ${how}`;
}

function renderKpis() {
  const incident = state.session.incident;
  if (!state.incident) {
    ["#k-car", "#k-speed", "#k-distance", "#k-tth", "#k-window"].forEach((id) => { $(id).textContent = "—"; });
    $("#k-car").textContent = "Not identified";
    return;
  }
  $("#k-car").textContent = incident.followingCar;
  $("#k-speed").textContent = `${incident.followingSpeedKph} km/h`;
  $("#k-distance").textContent = `${incident.followingDistanceM} m`;
  $("#k-tth").textContent = `${incident.timeToHazardS.toFixed(2)} s`;
  $("#k-window").textContent = `${incident.brakeByWindowS.toFixed(2)} s`;
  $("#k-window").title = `Latest moment full braking can start and still stop outside the ${MODEL_ASSUMPTIONS.safetyMarginM} m buffer, at reference grip ${incident.referenceGrip}. Detection, network and driver reaction all have to fit inside it.`;
}

// ---------- approach figure ----------
const AP = { left: 64, right: 972, dMax: 520, dMin: -30, stripY: 40, stripH: 30, chartTop: 124, chartBottom: 262, vMax: 320 };
const xFor = (d) => AP.left + ((AP.dMax - Math.max(AP.dMin, Math.min(AP.dMax, d))) / (AP.dMax - AP.dMin)) * (AP.right - AP.left);
const yFor = (kph) => AP.chartBottom - (Math.min(AP.vMax, Math.max(0, kph)) / AP.vMax) * (AP.chartBottom - AP.chartTop);
const layers = {};

function buildApproachSvg() {
  const root = $("#approach-svg");
  root.querySelectorAll(":scope > :not(desc)").forEach((node) => node.remove());
  const base = svg("g", { class: "ap-base" }, root);
  svg("rect", { x: AP.left, y: AP.stripY, width: AP.right - AP.left, height: AP.stripH, rx: 4, class: "track" }, base);
  svg("rect", { x: xFor(MODEL_ASSUMPTIONS.sightDistanceM), y: AP.stripY, width: xFor(0) - xFor(MODEL_ASSUMPTIONS.sightDistanceM), height: AP.stripH, class: "sight-zone" }, base);
  svg("text", { x: xFor(MODEL_ASSUMPTIONS.sightDistanceM) + 8, y: AP.stripY + AP.stripH / 2 + 6, class: "sight-label", text: `visible ≤ ${MODEL_ASSUMPTIONS.sightDistanceM} m` }, base);
  svg("rect", { x: xFor(MODEL_ASSUMPTIONS.safetyMarginM), y: AP.stripY, width: xFor(0) - xFor(MODEL_ASSUMPTIONS.safetyMarginM), height: AP.stripH, class: "buffer" }, base);
  for (let d = 500; d >= 0; d -= 100) svg("text", { x: xFor(d), y: AP.stripY + AP.stripH + 17, class: "ap-tick", "text-anchor": "middle", text: `${d} m` }, base);
  svg("line", { x1: xFor(0), x2: xFor(0), y1: AP.stripY - 18, y2: AP.chartBottom, class: "node-line" }, base);
  svg("text", { x: xFor(0) - 6, y: AP.stripY - 8, class: "ap-label node-label", "text-anchor": "end", text: "" }, base).id = "node-label";
  for (const v of [0, 100, 200, 300]) {
    svg("line", { x1: AP.left, x2: AP.right, y1: yFor(v), y2: yFor(v), class: "grid" }, base);
    svg("text", { x: AP.left - 10, y: yFor(v) + 4, class: "ap-tick", "text-anchor": "end", text: String(v) }, base);
  }
  svg("text", { x: AP.left - 10, y: AP.chartTop - 12, class: "ap-tick", "text-anchor": "end", text: "km/h" }, base);
  svg("text", { x: AP.right, y: AP.chartBottom + 20, class: "ap-tick", "text-anchor": "end", text: "distance to incident node →" }, base);
  layers.brakeBy = svg("g", { class: "brake-by" }, root);
  layers.replay = svg("g", {}, root);
  layers.model = svg("g", {}, root);
  layers.cars = svg("g", {}, root);
}

function drawReplay() {
  const frames = state.session.frames;
  const shown = state.incident ? frames : frames.slice(0, state.frameIndex + 1);
  layers.replay.replaceChildren();
  const points = shown.map((f) => `${xFor(f.features.hazardDistanceM).toFixed(1)},${yFor(f.speed).toFixed(1)}`).join(" ");
  if (shown.length > 1) svg("polyline", { points, class: "trace-replay" }, layers.replay);
  const lastShown = shown.at(-1);
  svg("text", { x: xFor(frames[0].features.hazardDistanceM) + 4, y: yFor(frames[0].speed) - 10, class: "ap-label muted replay-label", text: "CAR 16 · recorded replay" }, layers.replay);
  $("#node-label").textContent = state.incident ? "⚠ Incident node — CAR 16 stationary" : "Incident node";
  $("#node-label").classList.toggle("active", state.incident);

  layers.brakeBy.replaceChildren();
  layers.cars.replaceChildren();
  const lead = svg("g", { class: `car lead${state.incident ? " stopped" : ""}` }, layers.cars);
  const leadX = state.incident ? xFor(0) : xFor(lastShown.features.hazardDistanceM);
  svg("circle", { cx: leadX, cy: AP.stripY + AP.stripH / 2, r: 9 }, lead);
  if (!state.incident) svg("circle", { cx: leadX, cy: yFor(lastShown.speed), r: 4, class: "trace-head" }, layers.replay);

  if (state.incident) {
    const { followingDistanceM, followingSpeedKph, referenceGrip } = state.session.incident;
    const speedMs = followingSpeedKph / 3.6;
    const brakeByD = MODEL_ASSUMPTIONS.safetyMarginM + (speedMs * speedMs) / (2 * fullDeceleration(referenceGrip));
    svg("line", { x1: xFor(brakeByD), x2: xFor(brakeByD), y1: AP.stripY - 4, y2: AP.stripY + AP.stripH + 4, class: "brake-by-line" }, layers.brakeBy);
    svg("text", { x: xFor(brakeByD), y: AP.stripY + AP.stripH + 32, "text-anchor": "middle", class: "ap-label brake-by-label", text: `latest full-brake point · ${Math.round(brakeByD)} m` }, layers.brakeBy);
    const follower = svg("g", { class: "car follower", id: "follower" }, layers.cars);
    svg("circle", { cx: xFor(followingDistanceM), cy: AP.stripY + AP.stripH / 2, r: 9 }, follower);
    svg("text", { x: xFor(followingDistanceM), y: AP.stripY - 8, "text-anchor": "middle", class: "ap-label follower-label", text: state.session.incident.followingCar }, follower);
  }
}

function drawModeledApproach(result, counterfactual) {
  layers.model.replaceChildren();
  if (!result) return;
  const { followingDistanceM } = state.session.incident;
  // Draw only up to the incident node; an impact is shown as the speed reached there.
  const clip = (trace, impactKph) => {
    const inside = trace.filter((p) => p.x <= followingDistanceM);
    return impactKph === null ? inside : [...inside, { ...inside.at(-1), x: followingDistanceM, v: impactKph }];
  };
  const toPath = (trace) => trace.map((p, i) => `${i ? "L" : "M"}${xFor(followingDistanceM - p.x).toFixed(1)},${yFor(p.v).toFixed(1)}`).join("");
  result = { ...result, trace: clip(result.trace, result.impactSpeedKph) };
  if (counterfactual) svg("path", { d: toPath(clip(counterfactual.trace, counterfactual.impactSpeedKph)), class: "trace-none" }, layers.model);
  // Colour the modeled profile by phase: cruise → commanded slowing → full braking.
  let segment = [];
  const flush = (phase) => { if (segment.length > 1) svg("path", { d: toPath(segment), class: `trace-model phase-${phase}` }, layers.model); };
  result.trace.forEach((point, i) => {
    const phase = point.phase;
    if (i > 0 && result.trace[i - 1].phase !== phase) { segment.push(point); flush(result.trace[i - 1].phase); segment = [result.trace[i - 1]]; }
    segment.push(point);
  });
  flush(result.trace.at(-1).phase);

  const endD = followingDistanceM - result.trace.at(-1).x;
  const impact = result.impactSpeedKph !== null;
  const markerX = impact ? xFor(0) : xFor(endD);
  const tone = result.outcome.toLowerCase();
  svg("line", { x1: markerX, x2: markerX, y1: AP.stripY - 2, y2: AP.stripY + AP.stripH + 2, class: `stop-mark ${tone}` }, layers.model);
  const label = impact ? `reaches node at ${result.impactSpeedKph} km/h` : `stops ${Math.max(0, result.clearanceM).toFixed(0)} m short`;
  svg("text", { x: Math.min(markerX, xFor(0) - 8), y: impact ? yFor(result.impactSpeedKph) - 10 : AP.chartBottom - 8, "text-anchor": "end", class: `ap-label strong ${tone}`, text: label }, layers.model);
  if (counterfactual) {
    const cf = counterfactual.impactSpeedKph !== null ? `reaches node at ${counterfactual.impactSpeedKph} km/h` : `stops ${Math.max(0, counterfactual.clearanceM).toFixed(0)} m short`;
    svg("text", { x: xFor(0) - 10, y: AP.chartTop + 20, "text-anchor": "end", class: "ap-label muted", text: `- - - no connected warning: ${cf}` }, layers.model);
  }
}

function animateFollower(result) {
  cancelAnimationFrame(state.animation);
  const follower = $("#follower circle");
  if (!follower || !result) return;
  const { followingDistanceM } = state.session.incident;
  const trace = result.trace, duration = trace.at(-1).t;
  const head = svg("circle", { r: 5, class: "trace-head" }, layers.model);
  const start = performance.now();
  const frame = (now) => {
    const t = Math.min(duration, (now - start) / 1000);
    let i = trace.findIndex((p) => p.t >= t);
    if (i < 0) i = trace.length - 1;
    const p = trace[i];
    follower.setAttribute("cx", xFor(followingDistanceM - p.x));
    head.setAttribute("cx", xFor(followingDistanceM - p.x));
    head.setAttribute("cy", yFor(p.v));
    if (t < duration) state.animation = requestAnimationFrame(frame);
  };
  state.animation = requestAnimationFrame(frame);
}

// ---------- stress test ----------
async function runStressTest() {
  if (!(state.stage === "incident" || state.stage === "complete")) return;
  const token = ++state.runToken;
  cancelAnimationFrame(state.animation);
  clearResults();
  setStage("running");
  setStatus(`Running ${count(state.session.stress.count)} degraded scenarios through the stopping-envelope simulator…`);
  $("#progress").hidden = false;
  $("#progress").dataset.mode = "busy";
  let report;
  try {
    report = await api("/api/stress/run", { method: "POST", body: "{}" });
  } catch (error) {
    if (token !== state.runToken) return;
    $("#progress").hidden = true;
    setStage("incident");
    setStatus(`Stress test failed: ${error.message}. Press T to retry.`, "error");
    return;
  }
  if (token !== state.runToken) return;
  state.report = report;
  $("#progress").dataset.mode = "reveal";
  setStatus(`Computed ${count(report.count)} scenarios in ${report.computeMs} ms on this machine — plotting outcomes…`);
  buildScatter(report);
  await revealScatter(report, token);
  if (token !== state.runToken) return;
  $("#progress").hidden = true;
  drawBoundaryLine(report);
  renderBoundary(report);
  renderInterventions(report);
  renderContributors(report);
  renderAssumptions(report.assumptions);
  enableInspector(report);
  loadReference(report.boundary.fitted.latencyS ?? 0.5);
  setStage("complete");
  const b = report.boundary.fitted;
  const where = b.status === "within-range" ? `protection breaks beyond ${b.latencyS.toFixed(2)} s of network latency` : b.status === "unsafe-at-zero" ? "the reference case is unsafe even with zero latency" : "no boundary inside the tested latency range";
  setStatus(`Test complete · ${count(report.totals.unsafe)} of ${count(report.count)} scenarios unsafe · at reference conditions, ${where}.`, "success");
  document.body.classList.add("just-completed");
  setTimeout(() => document.body.classList.remove("just-completed"), 2400);
}

function clearResults() {
  state.report = null;
  state.inspected = null;
  state.inspectedId = null;
  $("#scatter").querySelectorAll(":scope > :not(desc)").forEach((node) => node.remove());
  ["#n-safe", "#n-marginal", "#n-unsafe"].forEach((id) => { $(id).textContent = "—"; });
  $("#dist-bar").querySelectorAll("i").forEach((bar) => { bar.style.width = "0%"; });
  $("#boundary-value").textContent = "—";
  $("#boundary-card").dataset.status = "";
  $("#boundary-sentence").textContent = "Run the stress test to find how much network latency the connected warning can absorb.";
  dlRows($("#reference-list"), [["Awaiting test", "—"]]);
  dlRows($("#quality-list"), [["Awaiting test", "—"]]);
  $("#interventions").replaceChildren(el("p", { class: "empty", text: "Run the stress test to compare interventions on the identical scenario set." }));
  $("#int-tag").textContent = "—";
  $("#contributors").replaceChildren(el("p", { class: "empty", text: "Waiting for the stress test." }));
  disableInspector();
  layers.model?.replaceChildren();
  if (state.session && layers.cars) drawReplay();
}

// ---------- scatter ----------
const SC = { left: 58, right: 624, top: 14, bottom: 292 };
const sx = (latency) => SC.left + ((latency - SCENARIO_RANGES.latencyS[0]) / (SCENARIO_RANGES.latencyS[1] - SCENARIO_RANGES.latencyS[0])) * (SC.right - SC.left);
const sy = (grip) => SC.bottom - ((grip - SCENARIO_RANGES.grip[0]) / (SCENARIO_RANGES.grip[1] - SCENARIO_RANGES.grip[0])) * (SC.bottom - SC.top);

function buildScatter() {
  const root = $("#scatter");
  root.querySelectorAll(":scope > :not(desc)").forEach((node) => node.remove());
  const axes = svg("g", { class: "axes" }, root);
  for (let l = 0; l <= 2.4001; l += 0.4) {
    svg("line", { x1: sx(l), x2: sx(l), y1: SC.top, y2: SC.bottom, class: "grid" }, axes);
    svg("text", { x: sx(l), y: SC.bottom + 18, "text-anchor": "middle", class: "ap-tick", text: `${l.toFixed(1)}` }, axes);
  }
  for (const g of [0.6, 0.7, 0.8, 0.9, 1.0]) {
    svg("line", { x1: SC.left, x2: SC.right, y1: sy(g), y2: sy(g), class: "grid" }, axes);
    svg("text", { x: SC.left - 8, y: sy(g) + 4, "text-anchor": "end", class: "ap-tick", text: g.toFixed(1) }, axes);
  }
  svg("text", { x: SC.right, y: SC.bottom + 38, "text-anchor": "end", class: "ap-tick", text: "one-way network latency (s) →" }, axes);
  svg("text", { x: 14, y: SC.top + 4, class: "ap-tick", transform: `rotate(-90 14 ${SC.top + 4})`, "text-anchor": "end", text: "grip (1.0 = dry) →" }, axes);
  layers.points = svg("g", { class: "points" }, root);
  layers.boundary = svg("g", { class: "fit-boundary" }, root);
  layers.selection = svg("g", {}, root);
}

function revealScatter(report, token) {
  const rows = report.scenarios;
  const totals = [0, 0, 0];
  const duration = reduceMotion ? 0 : 1600;
  const start = performance.now();
  let drawn = 0;
  return new Promise((resolve) => {
    const frame = (now) => {
      if (token !== state.runToken) return resolve();
      const target = duration ? Math.min(rows.length, Math.ceil(((now - start) / duration) * rows.length)) : rows.length;
      const fragment = document.createDocumentFragment();
      for (; drawn < target; drawn += 1) {
        const [id, latency, , grip, , , , outcome] = rows[drawn];
        totals[outcome] += 1;
        fragment.append(svg("circle", { cx: sx(latency).toFixed(1), cy: sy(grip).toFixed(1), r: 3.3, class: `pt o${outcome}`, "data-id": id }));
      }
      layers.points.append(fragment);
      $("#n-safe").textContent = count(totals[0]);
      $("#n-marginal").textContent = count(totals[1]);
      $("#n-unsafe").textContent = count(totals[2]);
      const bars = $("#dist-bar").querySelectorAll("i");
      totals.forEach((n, i) => { bars[i].style.width = `${(n / rows.length) * 100}%`; });
      $("#progress-fill").style.width = `${(drawn / rows.length) * 100}%`;
      if (drawn < rows.length) requestAnimationFrame(frame); else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function drawBoundaryLine(report) {
  layers.boundary.replaceChildren();
  const { weights } = report.model;
  const reference = report.reference;
  const points = [];
  for (let g = SCENARIO_RANGES.grip[0]; g <= SCENARIO_RANGES.grip[1] + 1e-9; g += 0.005) {
    const x = featureVector({ ...reference, grip: g, latencyS: SCENARIO_RANGES.latencyS[0] });
    const logit = weights[0] + x.reduce((sum, value, j) => sum + value * weights[j + 1], 0);
    const latency = SCENARIO_RANGES.latencyS[0] + (-logit / weights[1]) * (SCENARIO_RANGES.latencyS[1] - SCENARIO_RANGES.latencyS[0]);
    if (latency >= SCENARIO_RANGES.latencyS[0] && latency <= SCENARIO_RANGES.latencyS[1]) points.push(`${sx(latency).toFixed(1)},${sy(g).toFixed(1)}`);
  }
  if (points.length > 1) {
    svg("polyline", { points: points.join(" "), class: "fit-line" }, layers.boundary);
    const [lx, ly] = points.at(-1).split(",").map(Number);
    svg("text", { x: lx + 8, y: ly + 14, class: "ap-label fit-label", text: "fitted 50% boundary" }, layers.boundary);
  }
  const b = report.boundary.fitted;
  if (b.status === "within-range") {
    const cx = sx(b.latencyS), cy = sy(reference.grip);
    svg("circle", { cx, cy, r: 8, class: "ref-mark" }, layers.boundary);
    svg("text", { x: cx + 12, y: cy - 10, class: "ap-label strong", text: `${b.latencyS.toFixed(2)} s @ grip ${reference.grip}` }, layers.boundary);
  }
}

function onScatterClick(event) {
  if (!state.report) return;
  const root = $("#scatter");
  const matrix = root.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  let best = null, bestDistance = 14 * 14;
  for (const row of state.report.scenarios) {
    const dx = sx(row[1]) - point.x, dy = sy(row[3]) - point.y, distance = dx * dx + dy * dy;
    if (distance < bestDistance) { best = row; bestDistance = distance; }
  }
  if (best) loadScenarioRow(best);
}

// ---------- result panels ----------
function renderBoundary(report) {
  const { fitted, direct } = report.boundary;
  const { holdout, training } = report.model;
  const sut = report.systemUnderTest.label;
  const car = state.session.incident.followingCar;
  $("#boundary-card").dataset.status = fitted.status;
  if (fitted.status === "within-range") {
    $("#boundary-value").textContent = fitted.latencyS.toFixed(2);
    $("#boundary-sentence").textContent = `With everything else at reference, the connected ${sut.toLowerCase()} still gives ${car} room to stop at low latency. Beyond ${fitted.latencyS.toFixed(2)} s of one-way network latency, the fitted model classifies the approach as more likely UNSAFE than not. That is ${Math.round((fitted.latencyS / report.base.brakeByWindowS) * 100)}% of the ${report.base.brakeByWindowS.toFixed(2)} s brake-by window gone to the network alone.`;
  } else if (fitted.status === "unsafe-at-zero") {
    $("#boundary-value").textContent = "0.00";
    $("#boundary-sentence").textContent = `Even with zero latency the fitted model classifies the reference approach as unsafe for the ${sut.toLowerCase()}.`;
  } else {
    $("#boundary-value").textContent = `>${SCENARIO_RANGES.latencyS[1]}`;
    $("#boundary-sentence").textContent = "The fitted model does not cross 50% unsafe inside the tested latency range; no boundary is claimed.";
  }
  dlRows($("#reference-list"), [
    ["Approach", `${report.base.speedKph} km/h · ${report.base.distanceM} m`],
    ["Packet loss", `${Math.round(report.reference.packetLoss * 100)}%`],
    ["Grip", report.reference.grip.toFixed(2)],
    ["Driver delay", `+${report.reference.driverDelayS.toFixed(2)} s`],
    ["Sensor", report.reference.sensorDropout ? "Dropout" : "Healthy"],
    ["System under test", sut],
  ]);
  dlRows($("#quality-list"), [
    ["Held-out accuracy", `${holdout.accuracy.toFixed(1)}% (n=${holdout.n})`],
    ["Always-“unsafe” baseline", `${holdout.majorityBaseline.toFixed(1)}%`],
    ["Balanced accuracy", `${holdout.balancedAccuracy.toFixed(1)}%`],
    ["Direct simulation check", direct.status === "within-range" ? `first UNSAFE at ${direct.latencyS.toFixed(2)} s` : direct.status === "unsafe-at-zero" ? "unsafe at 0 s" : "no crossing ≤ 2.4 s"],
    ["Fit", `${training.method}, ${training.converged ? "converged" : "NOT converged"} in ${training.iterations} steps`, training.converged ? null : "bad"],
  ]);
}

function outcomeBar(item, total) {
  const bar = el("div", { class: "stack" });
  for (const key of ["safe", "marginal", "unsafe"]) {
    const part = el("i", { "data-outcome": key, title: `${key}: ${count(item[key])}` });
    part.style.width = `${(item[key] / total) * 100}%`;
    bar.append(part);
  }
  return bar;
}

function renderInterventions(report) {
  const allSame = report.interventions.every((item) => item.scenarioSet === report.scenarioSet && item.evaluated === report.count);
  $("#int-tag").textContent = allSame ? `${count(report.count)} identical runs · set ${report.scenarioSet}` : "⚠ scenario sets differ";
  $("#interventions").replaceChildren(...report.interventions.map((item) => {
    const tol = item.latencyTolerance;
    const tolerance = tol.status === "not-connected" ? "no message sent" : tol.status === "unsafe-at-zero" ? "unsafe even at 0 s" : tol.status === "beyond-tested-range" ? "> 2.4 s" : `${tol.latencyS.toFixed(2)} s`;
    return el("div", { class: `int-row${item.primary ? " primary" : ""}` },
      el("div", { class: "int-head" },
        el("strong", { text: item.label }),
        item.primary ? el("span", { class: "badge", text: "System under test" }) : null,
        el("b", { class: "int-rate", text: `${item.unsafeRate.toFixed(1)}% unsafe` })),
      outcomeBar(item, item.evaluated),
      el("dl", { class: "int-stats" },
        el("div", {}, el("dt", { text: "Median stopping margin" }), el("dd", { text: `${signed(item.medianMarginM)} m` })),
        el("div", {}, el("dt", { text: "Latency tolerance (ref.)" }), el("dd", { text: tolerance })),
        el("div", {}, el("dt", { text: "Safe / marginal" }), el("dd", { text: `${count(item.safe)} / ${count(item.marginal)}` }))),
      el("p", { class: "int-summary", text: item.summary }));
  }));
}

function renderContributors(report) {
  const items = report.model.contributors;
  const max = Math.max(...items.map((item) => Math.abs(item.coefficient)));
  const [first, second] = items;
  $("#contributors").replaceChildren(
    el("p", { class: "lead-in", text: `${first.label} dominates: moving it across ${first.range} shifts the log-odds of UNSAFE by ${signed(first.coefficient, 1)}, versus ${signed(second.coefficient, 1)} for ${second.label.toLowerCase()}.` }),
    ...items.map((item, i) => {
      const bar = el("span", { class: `bar${item.coefficient < 0 ? " negative" : ""}` });
      bar.style.width = `${(Math.abs(item.coefficient) / max) * 100}%`;
      return el("div", { class: "contrib" },
        el("span", { class: "rank", text: String(i + 1) }),
        el("div", { class: "contrib-name" }, el("strong", { text: item.label }), el("small", { text: item.range })),
        el("div", { class: "track-bar" }, bar),
        el("b", { text: signed(item.coefficient, 2) }));
    }));
}

function renderAssumptions(a) {
  dlRows($("#assumption-list"), [
    ["Driver reaction", `${a.reactionBaselineS} s + delay`],
    ["Full braking (dry)", `${a.dryDecelerationMs2} m/s² × grip`],
    ["Stationary car visible at", `${a.sightDistanceM} m`],
    ["Safety buffer", `${a.safetyMarginM} m`],
    ["Sensor fallback penalty", `+${a.sensorFallbackPenaltyS} s`],
    ["Retry per lost packet", `+${a.packetRetryIntervalS} s`],
    ["SAFE / MARGINAL bands", `≥ ${a.outcomeBands.safeMarginM} m / ≥ ${a.outcomeBands.marginalMarginM} m`],
    ["VSC decision time", `${INTERVENTIONS.vsc.decisionS} s`],
  ]);
}

// ---------- inspector ----------
const inputs = () => ({ latency: $("#in-latency"), loss: $("#in-loss"), grip: $("#in-grip"), delay: $("#in-delay"), dropout: $("#in-dropout"), intervention: $("#in-intervention") });

function enableInspector(report) {
  Object.values(inputs()).forEach((input) => { input.disabled = false; });
  $("#btn-ref").disabled = false;
  $("#btn-animate").disabled = false;
  $("#insp-hint").textContent = "Drag a slider, or click any point in the scatter to load that exact scenario.";
  const b = report.boundary.fitted;
  const mark = $("#latency-mark");
  mark.hidden = b.status !== "within-range";
  if (b.status === "within-range") {
    mark.style.left = `${(b.latencyS / SCENARIO_RANGES.latencyS[1]) * 100}%`;
    mark.title = `Fitted boundary ${b.latencyS.toFixed(2)} s`;
  }
  $("#inspector").classList.add("enabled");
}
function disableInspector() {
  Object.values(inputs()).forEach((input) => { input.disabled = true; });
  $("#btn-ref").disabled = true;
  $("#btn-animate").disabled = true;
  $("#latency-mark").hidden = true;
  $("#inspector").classList.remove("enabled");
  $("#insp-hint").textContent = "Available after the stress test. Drag a slider or click a point in the scatter.";
  $("#verdict").dataset.outcome = "none";
  $("#verdict").replaceChildren(el("strong", { text: "—" }), el("span", { text: "No scenario selected" }));
  $("#insp-kpis").replaceChildren();
  $("#chain").replaceChildren();
  $("#per-int tbody").replaceChildren();
  $("#insp-source").textContent = "—";
  ["#out-latency", "#out-loss", "#out-grip", "#out-delay"].forEach((id) => { $(id).textContent = "—"; });
}

function setInputs(scenario, interventionKey) {
  const i = inputs();
  i.latency.value = scenario.latencyS; i.loss.value = scenario.packetLoss; i.grip.value = scenario.grip; i.delay.value = scenario.driverDelayS;
  i.dropout.checked = scenario.sensorDropout; i.intervention.value = interventionKey;
}
function loadReference(latencyS) {
  const { reference } = state.report;
  state.inspectedId = null;
  state.inspected = { ...reference, latencyS: Math.round(latencyS * 100) / 100, retries: undefined };
  setInputs(state.inspected, PRIMARY_INTERVENTION);
  inspect("Reference conditions at the fitted boundary latency · packet loss uses expected retries.");
}
function loadScenarioRow(row) {
  const [id, latencyS, packetLoss, grip, dropout, driverDelayS, retries] = row;
  state.inspectedId = id;
  state.inspected = { distanceM: state.report.base.distanceM, speedKph: state.report.base.speedKph, latencyS, packetLoss, grip, sensorDropout: dropout === 1, driverDelayS, retries };
  setInputs(state.inspected, PRIMARY_INTERVENTION);
  inspect(`Scenario #${id} from the sweep · ${retries} lost transmission${retries === 1 ? "" : "s"} sampled for this run.`);
}
function onInspectorInput(event) {
  if (!state.report || !state.inspected) return;
  const i = inputs();
  const lossChanged = event?.target === i.loss;
  state.inspected = {
    ...state.inspected,
    latencyS: Number(i.latency.value), packetLoss: Number(i.loss.value), grip: Number(i.grip.value), driverDelayS: Number(i.delay.value), sensorDropout: i.dropout.checked,
    retries: lossChanged ? undefined : state.inspected.retries,
  };
  if (event?.target !== i.intervention) state.inspectedId = null;
  inspect(state.inspected.retries === undefined ? "Custom scenario · packet loss uses expected retries." : `Custom scenario · keeps ${state.inspected.retries} sampled lost transmission${state.inspected.retries === 1 ? "" : "s"}.`);
}

function inspect(source) {
  const scenario = state.inspected;
  const key = $("#in-intervention").value;
  const result = simulateApproach(scenario, key, MODEL_ASSUMPTIONS, { trace: true });
  const counterfactual = key === "none" ? null : simulateApproach(scenario, "none", MODEL_ASSUMPTIONS, { trace: true });
  $("#insp-source").textContent = source;
  $("#out-latency").textContent = `${scenario.latencyS.toFixed(2)} s`;
  $("#out-loss").textContent = `${Math.round(scenario.packetLoss * 100)}%`;
  $("#out-grip").textContent = scenario.grip.toFixed(2);
  $("#out-delay").textContent = `+${scenario.driverDelayS.toFixed(2)} s`;
  $("#in-latency").setAttribute("aria-valuetext", `${scenario.latencyS.toFixed(2)} seconds`);

  const tone = result.outcome.toLowerCase();
  const verdictText = result.impactSpeedKph !== null
    ? `Reaches the stationary car at ${result.impactSpeedKph} km/h`
    : result.outcome === "UNSAFE" ? `Stops ${result.clearanceM.toFixed(0)} m short — inside the ${MODEL_ASSUMPTIONS.safetyMarginM} m buffer` : `Stops ${result.clearanceM.toFixed(0)} m short of the stationary car`;
  $("#verdict").dataset.outcome = tone;
  $("#verdict").replaceChildren(el("strong", { text: result.outcome }), el("span", { text: verdictText }));

  const fitted = key === PRIMARY_INTERVENTION ? `${predictFailure(state.report.model, scenario).toFixed(1)}%` : "n/a — fitted to double yellow";
  const t = result.timeline;
  dlRows($("#insp-kpis"), [
    ["Stopping margin", `${signed(result.marginM)} m`, tone],
    ["Warning shown to driver", t.warningAtS === null ? "never (no message)" : `${t.warningAtS.toFixed(2)} s`],
    ["Warned before seeing hazard", t.warningAtS === null ? "—" : result.warnedBeforeSighting ? "yes" : "no — too late", result.warnedBeforeSighting ? null : "bad"],
    ["Fitted P(UNSAFE)", fitted],
  ]);
  drawChain(result);

  $("#per-int tbody").replaceChildren(...Object.entries(INTERVENTIONS).map(([k, value]) => {
    const r = k === key ? result : simulateApproach(scenario, k);
    return el("tr", { class: k === key ? "selected" : "" },
      el("th", { scope: "row", text: value.label }),
      el("td", {}, el("span", { class: "pill", "data-outcome": r.outcome.toLowerCase(), text: r.outcome })),
      el("td", { text: `${signed(r.marginM)} m` }));
  }));

  drawModeledApproach(result, counterfactual);
  state.lastResult = result;
  layers.selection.replaceChildren();
  if (state.inspectedId !== null) {
    const row = state.report.scenarios[state.inspectedId - 1];
    svg("circle", { cx: sx(row[1]), cy: sy(row[3]), r: 8, class: "sel" }, layers.selection);
  } else {
    svg("circle", { cx: sx(scenario.latencyS), cy: sy(scenario.grip), r: 8, class: "sel custom" }, layers.selection);
  }
}

function drawChain(result) {
  const root = $("#chain");
  root.replaceChildren();
  const t = result.timeline;
  const end = Math.max(t.stoppedAtS, t.impactAtS ?? 0);
  const W = 560, left = 8, right = 552, y = 30, h = 24;
  const tx = (s) => left + (Math.min(s, end) / end) * (right - left);
  const segments = [];
  // Once the driver brakes on sight, later links of the warning chain no longer matter.
  const cap = Math.min(t.emergencyAtS ?? Infinity, t.stoppedAtS);
  const push = (from, to, cls, label) => { const end = Math.min(to, cap); if (end - from > 0.005) segments.push({ from, to: end, cls, label }); };
  if (t.warningAtS !== null) {
    push(0, t.detectionS, "detect", "Detect");
    push(t.detectionS, t.detectionS + t.decisionS, "decide", "Decide");
    push(t.detectionS + t.decisionS, t.warningAtS, "network", t.warningAtS > cap ? "Network (late)" : "Network");
    push(t.warningAtS, t.commandAtS, "react", "React");
    push(t.commandAtS, t.stoppedAtS, "command", "Slow");
  } else {
    push(0, t.sightedAtS ?? 0, "idle", "No warning");
    push(t.sightedAtS ?? 0, t.emergencyAtS ?? 0, "react", "React");
  }
  if (t.emergencyAtS !== null && t.emergencyAtS < t.stoppedAtS) segments.push({ from: t.emergencyAtS, to: t.stoppedAtS, cls: "brake", label: "Brake" });
  svg("rect", { x: left, y, width: right - left, height: h, rx: 3, class: "chain-bg" }, root);
  for (const s of segments) {
    const x = tx(s.from), width = Math.max(1, tx(s.to) - x);
    svg("rect", { x, y, width, height: h, class: `seg ${s.cls}` }, root);
    if (width > 44) svg("text", { x: x + width / 2, y: y + 16, "text-anchor": "middle", class: "seg-label", text: s.label }, root);
  }
  const marker = (s, label, cls, anchor = "middle") => {
    svg("line", { x1: tx(s), x2: tx(s), y1: y - 6, y2: y + h + 6, class: `chain-mark ${cls}` }, root);
    svg("text", { x: tx(s), y: y - 10, "text-anchor": anchor, class: `chain-mark-label ${cls}`, text: label }, root);
  };
  if (t.sightedAtS !== null) marker(t.sightedAtS, `hazard visible ${t.sightedAtS.toFixed(1)} s`, "sight", tx(t.sightedAtS) > W * 0.8 ? "end" : "middle");
  if (t.impactAtS !== null) marker(t.impactAtS, "reaches node", "impact", "end");
  for (let s = 0; s <= end; s += 1) svg("text", { x: tx(s), y: y + h + 20, "text-anchor": s === 0 ? "start" : "middle", class: "ap-tick", text: `${s} s` }, root);
  root.setAttribute("aria-label", `Timeline: ${segments.map((s) => `${s.label} ${(s.to - s.from).toFixed(2)} s`).join(", ")}${t.impactAtS !== null ? `, reaches the incident node at ${t.impactAtS.toFixed(2)} s` : ""}.`);
}

// ---------- hardware ----------
function setChip(selector, value, tone, title = "") {
  const chip = $(selector);
  chip.dataset.tone = tone;
  chip.querySelector("strong").textContent = value;
  chip.title = title;
}
async function pollHardware() {
  clearTimeout(state.hardwareTimer);
  try {
    renderHardware(await api("/api/hardware"));
  } catch {
    setChip("#chip-hardware", "Server unreachable", "bad");
    $("#hw-state").dataset.state = "unknown";
    $("#hw-mode").textContent = "Unknown";
    $("#hw-message").textContent = "Cannot reach the local server for hardware status.";
  }
  state.hardwareTimer = setTimeout(pollHardware, 400);
}
function renderHardware(status) {
  const previous = state.hardwareState;
  state.hardwareState = status.state;
  handleHardwareIncident(status.incident);
  const tone = status.state === "LIVE" ? "good" : status.state === "BENCH" ? "info" : "warn";
  setChip("#chip-hardware", status.connected ? status.mode : "Replay fallback · degraded", tone, status.message);
  $("#hw-state").dataset.state = status.state;
  $("#hw-mode").textContent = status.degraded ? "DEGRADED MODE · REPLAY FALLBACK" : status.mode;
  $("#hw-message").textContent = status.message;
  dlRows($("#hw-details"), [
    ["Incident detection source", status.detectionSource],
    ["Last packet", status.ageMs === null ? "never" : `${(status.ageMs / 1000).toFixed(1)} s ago`],
    ["Packets received", count(status.packetCount)],
    ["Declared stale after", `${(status.staleAfterMs / 1000).toFixed(1)} s`],
    ["Live reading", status.reading ? liveReading(status.reading) : "none — nothing fabricated"],
    ["Last incident event", status.incident?.last ? `#${status.incident.last.seq} · ${status.incident.last.triggerSource} · ${new Date(status.incident.last.at).toLocaleTimeString()}` : "none received"],
  ]);
  $("#btn-bench-start").disabled = status.bench;
  $("#btn-bench-cut").disabled = !status.bench;
  const lost = status.state === "SIGNAL_LOST" || status.state === "NO_SIGNAL";
  const wasLost = previous === "SIGNAL_LOST" || previous === "NO_SIGNAL";
  if (previous && !wasLost && status.state === "SIGNAL_LOST" && state.stage !== "running") {
    setStatus("ESP32 link lost. ChainBreak declared degraded mode and continues on the cached replay — no sensor values are invented.", "warn");
    state.linkLostBanner = true;
  } else if (state.linkLostBanner && !lost) {
    // The link came back: never leave a "link lost" banner next to a healthy panel.
    state.linkLostBanner = false;
    setStatus(`${status.mode === "HARDWARE" ? "ESP32" : "Bench simulator"} link restored — ${status.message}.`, "neutral");
  }
}
function liveReading(reading) {
  const magnitude = reading.accelMagnitudeMs2 !== null ? ` · |a|=${reading.accelMagnitudeMs2.toFixed(2)} m/s²` : "";
  return `${reading.driver} · a=${reading.imuAccelerationMs2} m/s²${magnitude}${reading.incident ? " · INCIDENT" : ""}${reading.simulated ? " (simulated)" : ""}`;
}
// Fire the incident path once per new server-side incident event. Events that
// happened before this page loaded, or before the last reset, are only recorded.
function handleHardwareIncident(incident) {
  if (!incident) return;
  if (state.incidentSeqSeen === null) { state.incidentSeqSeen = incident.seq; return; }
  if (incident.seq <= state.incidentSeqSeen) return;
  state.incidentSeqSeen = incident.seq;
  if (state.stage === "ready") triggerIncident(incident.last);
}
async function bench(action) {
  try { renderHardware(await api("/api/hardware/bench", { method: "POST", body: JSON.stringify({ action }) })); }
  catch (error) { setStatus(`Bench simulator request failed: ${error.message}`, "error"); }
}

// ---------- reset & wiring ----------
function reset() {
  if (state.stage === "loading") return;
  state.runToken += 1;
  stopReplay();
  cancelAnimationFrame(state.animation);
  state.incident = false;
  state.replayed = false;
  $("#progress").hidden = true;
  clearResults();
  $("#approach-tag").textContent = "Replay · synthetic sample";
  $("#approach-note").textContent = "Replay shows the bundled synthetic sample. Trigger the incident node to identify the following car.";
  renderFrame(0);
  renderKpis();
  renderAssumptions(MODEL_ASSUMPTIONS);
  setStage("ready");
  if (!$("#btn-bench-cut").disabled) bench("stop");
  setStatus("Reset. Ready for the next run: Space to replay, I for the incident, T for the stress test.");
}

$("#btn-replay").addEventListener("click", toggleReplay);
$("#btn-incident").addEventListener("click", () => triggerIncident());
$("#btn-test").addEventListener("click", runStressTest);
$("#btn-reset").addEventListener("click", reset);
$("#btn-retry").addEventListener("click", init);
$("#scrubber").addEventListener("input", (event) => { stopReplay(); state.replayed = true; renderFrame(event.target.value); });
$("#scatter").addEventListener("click", onScatterClick);
$("#inspector-form").addEventListener("input", onInspectorInput);
$("#inspector-form").addEventListener("submit", (event) => event.preventDefault());
$("#btn-ref").addEventListener("click", () => state.report && loadReference(state.report.boundary.fitted.latencyS ?? 0.5));
$("#btn-animate").addEventListener("click", () => animateFollower(state.lastResult));
$("#btn-bench-start").addEventListener("click", () => bench("start"));
$("#btn-bench-cut").addEventListener("click", () => bench("stop"));
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = event.target.tagName;
  const typing = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  if (event.key === " " && !typing && tag !== "BUTTON") { event.preventDefault(); toggleReplay(); return; }
  if (typing) return;
  const key = event.key.toLowerCase();
  if (key === "i") triggerIncident(); else if (key === "t") runStressTest(); else if (key === "r") reset();
});

init();
