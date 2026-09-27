import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { processSession } from "./pipeline.mjs";
import { buildStressReport, brakeByWindow, timeToHazard, INTERVENTIONS, PRIMARY_INTERVENTION, REFERENCE_CONDITIONS } from "./stress-engine.mjs";
import { HardwareAdapter } from "../adapters/hardware.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = resolve(projectRoot, "public");
const enginePath = resolve(projectRoot, "lib", "stress-engine.mjs");
const MAX_BODY_BYTES = 4096;
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

// Scenario definition for the demo incident. The following car's state is a
// stated scenario parameter, not measured telemetry.
export const INCIDENT = Object.freeze({
  id: "NODE-A",
  label: "CAR 16 stationary at incident node (injected fault)",
  location: "Variante Ascari approach (sample geometry)",
  incidentCar: "CAR 16",
  followingCar: "CAR 09",
  followingDistanceM: 470,
  followingSpeedKph: 252,
});

export const STRESS_CONFIG = Object.freeze({ count: 1200, seed: 7331 });

export async function createChainBreakServer({ hardware = new HardwareAdapter(), sessionFile = join(projectRoot, "data", "demo-session.json"), benchIntervalMs = 250 } = {}) {
  const frames = processSession(JSON.parse(await readFile(sessionFile, "utf8")));
  const base = { distanceM: INCIDENT.followingDistanceM, speedKph: INCIDENT.followingSpeedKph };
  const bench = createBenchSimulator(hardware, benchIntervalMs);
  let cachedReport = null;

  const session = {
    id: "chainbreak-demo",
    circuit: "Monza-style sample",
    provenance: { kind: "synthetic-sample", label: "Synthetic sample · cached", detail: "Bundled historical-style telemetry created for this prototype. It is not OpenF1 data and not a recording of a real incident." },
    sampleRateMs: 500,
    frames,
    incident: {
      ...INCIDENT,
      timeToHazardS: timeToHazard(base.distanceM, base.speedKph),
      brakeByWindowS: brakeByWindow(base.distanceM, base.speedKph),
      referenceGrip: REFERENCE_CONDITIONS.grip,
    },
    stress: { ...STRESS_CONFIG, systemUnderTest: INTERVENTIONS[PRIMARY_INTERVENTION].label },
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      if (req.method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "ChainBreak", replay: session.provenance.kind, hardware: hardware.status() });
      if (req.method === "GET" && pathname === "/api/session") return sendJson(res, 200, session);
      if (req.method === "GET" && pathname === "/api/stress") {
        cachedReport ??= buildStressReport(base, STRESS_CONFIG);
        return sendJson(res, 200, cachedReport);
      }
      if (req.method === "POST" && pathname === "/api/stress/run") {
        assertSameOriginJson(req);
        const started = performance.now();
        const report = buildStressReport(base, STRESS_CONFIG);
        cachedReport = report;
        return sendJson(res, 200, { ...report, computeMs: Math.round(performance.now() - started) });
      }
      if (req.method === "GET" && pathname === "/api/hardware") return sendJson(res, 200, { ...hardware.status(), bench: bench.running });
      if (req.method === "POST" && pathname === "/api/hardware/packet") {
        assertSameOriginJson(req);
        const packet = await readJson(req);
        try { hardware.ingest(packet); } catch (error) { throw httpError(422, error.message); }
        return sendJson(res, 202, { ...hardware.status(), bench: bench.running });
      }
      if (req.method === "POST" && pathname === "/api/hardware/bench") {
        assertSameOriginJson(req);
        const { action } = await readJson(req);
        if (action === "start") bench.start();
        else if (action === "stop") bench.stop();
        else throw httpError(400, 'Expected {"action":"start"} or {"action":"stop"}');
        return sendJson(res, 200, { ...hardware.status(), bench: bench.running });
      }
      throw httpError(404, "Unknown API route");
    }

    if (req.method !== "GET" && req.method !== "HEAD") throw httpError(405, "Method not allowed");
    const filePath = pathname === "/engine/stress-engine.mjs" ? enginePath : resolvePublic(pathname);
    const body = await readFile(filePath).catch(() => { throw httpError(404, "Not found"); });
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": MIME[extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error.status || 500;
      if (status === 500) console.error(error);
      if (res.headersSent) return res.end();
      if ((req.url || "").startsWith("/api/")) return sendJson(res, status, { ok: false, error: status === 500 ? "Internal server error" : error.message });
      res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
      res.end(status === 404 ? "Not found" : error.message);
    });
  });
  server.on("close", () => bench.stop());
  server.chainbreak = { hardware, bench };
  return server;
}

function resolvePublic(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw httpError(400, "Bad path"); }
  if (decoded.includes("\0")) throw httpError(400, "Bad path");
  const filePath = resolve(publicRoot, decoded === "/" ? "index.html" : `.${decoded}`);
  if (!filePath.startsWith(publicRoot + sep)) throw httpError(404, "Not found");
  return filePath;
}

// Server-side bench simulator: exercises the real ingest + staleness path with
// packets that are explicitly flagged as simulated.
function createBenchSimulator(hardware, intervalMs) {
  let timer = null, autoStop = null;
  const send = () => hardware.ingest({ ts: Date.now(), vehicle_id: "BENCH-SIM", speed_kph: 0, imu_ax: 0, simulated: true });
  const bench = {
    get running() { return timer !== null; },
    start() {
      if (timer) return;
      send();
      timer = setInterval(send, intervalMs);
      autoStop = setTimeout(() => bench.stop(), 5 * 60 * 1000);
      timer.unref?.(); autoStop.unref?.();
    },
    stop() { clearInterval(timer); clearTimeout(autoStop); timer = null; autoStop = null; },
  };
  return bench;
}

// JSON content type forces a CORS preflight for cross-site requests, and a
// foreign Origin is rejected outright, so other web pages cannot drive the API.
function assertSameOriginJson(req) {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw httpError(415, "Expected application/json");
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host;
    try { host = new URL(origin).host; } catch { throw httpError(403, "Bad origin"); }
    if (host !== req.headers.host) throw httpError(403, "Cross-origin request rejected");
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "Request body too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw httpError(400, "Invalid JSON"); }
}

function sendJson(res, status, value) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
