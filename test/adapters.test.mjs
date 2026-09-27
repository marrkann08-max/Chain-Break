import test from "node:test";
import assert from "node:assert/strict";
import { HardwareAdapter } from "../adapters/hardware.mjs";
import { fromEsp32 } from "../adapters/esp32.mjs";
import { fromOpenF1 } from "../adapters/openf1.mjs";

test("hardware adapter degrades to replay after a stale signal", () => {
  const adapter = new HardwareAdapter({ staleAfterMs: 100 });
  assert.equal(adapter.status(1000).mode, "REPLAY FALLBACK");
  assert.equal(adapter.status(1000).state, "NO_SIGNAL");
  adapter.ingest({ ts: 1000, speed_kph: 12 }, 1000);
  assert.equal(adapter.status(1050).connected, true);
  assert.equal(adapter.status(1050).mode, "HARDWARE");
  const stale = adapter.status(1200);
  assert.equal(stale.degraded, true);
  assert.equal(stale.state, "SIGNAL_LOST");
});

test("a stale or missing link never carries a sensor reading", () => {
  const adapter = new HardwareAdapter({ staleAfterMs: 100 });
  assert.equal(adapter.status(0).reading, null);
  adapter.ingest({ ts: 1, imu_ax: 9.1 }, 0);
  assert.equal(adapter.status(50).reading.imuAccelerationMs2, 9.1);
  assert.equal(adapter.status(101).reading, null);
});

test("freshness uses arrival time, not the packet's own timestamp", () => {
  const adapter = new HardwareAdapter({ staleAfterMs: 100 });
  adapter.ingest({ ts: 999999999 }, 0);
  assert.equal(adapter.status(500).connected, false);
});

test("bench-simulator packets are never reported as hardware", () => {
  const adapter = new HardwareAdapter();
  const status = adapter.ingest({ vehicle_id: "BENCH-SIM", simulated: true }, 0);
  assert.equal(status.mode, "BENCH SIMULATOR");
  assert.equal(status.state, "BENCH");
  assert.equal(status.reading.simulated, true);
  assert.notEqual(status.mode, "HARDWARE");
});

// Exact shape sent by hardware/chainbreak-node (MPU9250 + button sketch).
const nodePacket = (incident, extra = {}) => ({ ts: 1234, vehicle_id: "CHAINBREAK-NODE-01", speed_kph: 0, track_distance_m: 5120, imu_ax: 0.4, imu_ay: -0.2, imu_az: 9.7, accel_magnitude_ms2: incident ? 31.2 : 9.72, incident, trigger_source: incident ? "imu" : "none", sequence: 7, simulated: false, ...extra });

test("real node packets parse incident, trigger source and IMU magnitude", () => {
  const reading = fromEsp32(nodePacket(true));
  assert.equal(reading.incident, true);
  assert.equal(reading.triggerSource, "imu");
  assert.equal(reading.accelMagnitudeMs2, 31.2);
  assert.equal(reading.sequence, 7);
  assert.equal(fromEsp32(nodePacket(true, { incident: "true" })).incident, false, "only boolean true counts");
  assert.equal(fromEsp32(nodePacket(true, { trigger_source: "<script>" })).triggerSource, "unknown");
});

test("a held incident flag is one event; a new press after release is another", () => {
  const adapter = new HardwareAdapter({ staleAfterMs: 1000 });
  adapter.ingest(nodePacket(false), 0);
  assert.equal(adapter.status(0).incident.seq, 0);
  adapter.ingest(nodePacket(true), 300);
  adapter.ingest(nodePacket(true), 600);
  adapter.ingest(nodePacket(true), 900);
  const held = adapter.status(900).incident;
  assert.equal(held.seq, 1);
  assert.equal(held.active, true);
  assert.equal(held.last.triggerSource, "imu");
  assert.equal(held.last.at, 300);
  adapter.ingest(nodePacket(false), 1200);
  adapter.ingest(nodePacket(true, { trigger_source: "button" }), 1500);
  assert.equal(adapter.status(1500).incident.seq, 2);
  assert.equal(adapter.status(1500).incident.last.triggerSource, "button");
});

test("incident flag after a lost link counts as a new event, and history survives staleness", () => {
  const adapter = new HardwareAdapter({ staleAfterMs: 100 });
  adapter.ingest(nodePacket(true), 0);
  const stale = adapter.status(500);
  assert.equal(stale.reading, null);
  assert.equal(stale.incident.active, false);
  assert.equal(stale.incident.seq, 1, "a real past event is still reported");
  adapter.ingest(nodePacket(true), 600);
  assert.equal(adapter.status(600).incident.seq, 2);
});

test("malformed ESP32 packets are rejected", () => {
  assert.throws(() => fromEsp32(null), TypeError);
  assert.throws(() => fromEsp32([1, 2]), TypeError);
  assert.throws(() => fromEsp32({ speed_kph: "fast" }), TypeError);
  assert.throws(() => fromEsp32({ imu_ax: Infinity }), TypeError);
  const adapter = new HardwareAdapter();
  assert.throws(() => adapter.ingest({ speed_kph: "fast" }, 0));
  assert.equal(adapter.status(0).state, "NO_SIGNAL", "a rejected packet must not count as a connection");
});

test("OpenF1 distance is integrated from speed over real timestamps, tolerating unsorted rows", () => {
  const rows = [
    { date: "2024-09-01T13:00:00.500Z", driver_number: 16, speed: 360 },
    { date: "2024-09-01T13:00:00.000Z", driver_number: 16, speed: 360 },
    { date: "2024-09-01T13:00:01.000Z", driver_number: 16, speed: 360 },
    { date: "not-a-date", driver_number: 16, speed: 999 },
  ];
  const frames = fromOpenF1(rows);
  assert.equal(frames.length, 3);
  assert.deepEqual(frames.map((f) => f.t), [0, 500, 1000]);
  assert.deepEqual(frames.map((f) => f.distance), [0, 50, 100]);
  assert.equal(frames[0].source, "openf1");
});

test("OpenF1 gaps longer than two seconds do not invent distance", () => {
  const frames = fromOpenF1([
    { date: "2024-09-01T13:00:00Z", driver_number: 1, speed: 300 },
    { date: "2024-09-01T13:00:30Z", driver_number: 1, speed: 300 },
  ]);
  assert.equal(frames[1].distance, 0);
});
