import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createChainBreakServer } from "../lib/app.mjs";
import { HardwareAdapter } from "../adapters/hardware.mjs";

const hardware = new HardwareAdapter({ staleAfterMs: 150 });
const server = await createChainBreakServer({ hardware, benchIntervalMs: 40 });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
test.after(() => new Promise((resolve) => server.close(resolve)));

// Raw request helper so we control the exact path (fetch would normalise "..").
function request(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const postJson = (path, value, headers = {}) => request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("serves the dashboard, engine module and session offline with security headers", async () => {
  const page = await request("/");
  assert.equal(page.status, 200);
  assert.match(page.text, /ChainBreak/);
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.doesNotMatch(page.text, /https?:\/\/(?!www\.w3\.org)/, "page must not load remote resources");
  const engine = await request("/engine/stress-engine.mjs");
  assert.equal(engine.status, 200);
  assert.match(engine.headers["content-type"], /javascript/);
  const session = await request("/api/session");
  assert.equal(session.json.provenance.kind, "synthetic-sample");
  assert.ok(session.json.frames.length > 5);
  assert.equal(session.json.incident.timeToHazardS, 6.71);
});

test("page never labels the synthetic sample as OpenF1 data or uses banned claims", async () => {
  const [page, app] = await Promise.all([request("/"), request("/app.js")]);
  for (const text of [page.text, app.text]) {
    assert.doesNotMatch(text, /digital twin/i);
    assert.doesNotMatch(text, /predicts? crash/i);
    assert.doesNotMatch(text, /FIA[- ]grade/i);
  }
});

test("blocks path traversal and unknown files", async () => {
  for (const path of ["/../package.json", "/..%2Fpackage.json", "/%2e%2e/%2e%2e/package.json", "/..%5Cserver.mjs", "/nope.js", "/%E0%A4%A"]) {
    const res = await request(path);
    assert.ok([400, 404].includes(res.status), `${path} → ${res.status}`);
    assert.doesNotMatch(res.text, /"name": "chainbreak/);
  }
});

test("unknown API routes and bad methods return JSON errors", async () => {
  const missing = await request("/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.ok, false);
  const wrongMethod = await request("/index.html", { method: "DELETE" });
  assert.equal(wrongMethod.status, 405);
});

test("stress run recomputes the same deterministic report", async () => {
  const first = await postJson("/api/stress/run", {});
  const cached = await request("/api/stress");
  assert.equal(first.status, 200);
  assert.ok(Number.isFinite(first.json.computeMs));
  assert.deepEqual(first.json.totals, cached.json.totals);
  assert.equal(first.json.boundary.fitted.status, "within-range");
});

test("POST endpoints require JSON and reject cross-origin callers", async () => {
  const plain = await request("/api/hardware/bench", { method: "POST", headers: { "content-type": "text/plain" }, body: '{"action":"start"}' });
  assert.equal(plain.status, 415);
  const foreign = await postJson("/api/hardware/bench", { action: "start" }, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const badJson = await request("/api/hardware/packet", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(badJson.status, 400);
  const huge = await request("/api/hardware/packet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(10000) }) });
  assert.equal(huge.status, 413);
  const invalid = await postJson("/api/hardware/packet", { speed_kph: "fast" });
  assert.equal(invalid.status, 422);
  assert.equal((await request("/api/hardware")).json.bench, false);
});

test("hardware packets connect, then the link degrades to replay fallback without a reading", async () => {
  const accepted = await postJson("/api/hardware/packet", { vehicle_id: "NODE-A", imu_ax: 8.4 });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.json.mode, "HARDWARE");
  await wait(220);
  const lost = await request("/api/hardware");
  assert.equal(lost.json.state, "SIGNAL_LOST");
  assert.equal(lost.json.mode, "REPLAY FALLBACK");
  assert.equal(lost.json.reading, null);
});

test("an ESP32 incident packet (no Origin header, as sent by HTTPClient) is recorded as an incident event", async () => {
  const before = (await request("/api/hardware")).json.incident.seq;
  const packet = { ts: 5000, vehicle_id: "CHAINBREAK-NODE-01", speed_kph: 0, track_distance_m: 5120, imu_ax: 12.1, imu_ay: 3.2, imu_az: 9.1, accel_magnitude_ms2: 27.4, incident: true, trigger_source: "imu", sequence: 42, simulated: false };
  const first = await postJson("/api/hardware/packet", packet);
  await postJson("/api/hardware/packet", { ...packet, sequence: 43 });
  assert.equal(first.status, 202);
  assert.equal(first.json.mode, "HARDWARE");
  const status = (await request("/api/hardware")).json;
  assert.equal(status.incident.seq, before + 1, "held flag is a single event");
  assert.equal(status.incident.last.vehicleId, "CHAINBREAK-NODE-01");
  assert.equal(status.incident.last.simulated, false);
  await wait(220);
});

test("bench simulator is labelled simulated and cutting it triggers degraded mode", async () => {
  const started = await postJson("/api/hardware/bench", { action: "start" });
  assert.equal(started.json.mode, "BENCH SIMULATOR");
  assert.equal(started.json.bench, true);
  await wait(100);
  assert.equal((await request("/api/hardware")).json.state, "BENCH");
  const stopped = await postJson("/api/hardware/bench", { action: "stop" });
  assert.equal(stopped.json.bench, false);
  await wait(220);
  const degraded = await request("/api/hardware");
  assert.equal(degraded.json.degraded, true);
  assert.equal(degraded.json.reading, null);
  const bad = await postJson("/api/hardware/bench", { action: "explode" });
  assert.equal(bad.status, 400);
});
