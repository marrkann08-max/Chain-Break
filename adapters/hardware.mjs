import { fromEsp32 } from "./esp32.mjs";

// Source-agnostic hardware state. Freshness is judged by server arrival time,
// never by the packet's own timestamp. When the signal is missing or stale the
// status carries no reading at all — the replay fallback is declared instead.
export class HardwareAdapter {
  constructor({ staleAfterMs = 2500 } = {}) {
    this.staleAfterMs = staleAfterMs;
    this.lastPacketAt = 0;
    this.latest = null;
    this.packetCount = 0;
    this.incidentSeq = 0;
    this.lastIncident = null;
  }

  ingest(packet, now = Date.now()) {
    const previous = this.latest;
    const wasFresh = previous !== null && now - this.lastPacketAt <= this.staleAfterMs;
    const reading = fromEsp32(packet, previous?.distance ?? 0);
    // A node keeps sending incident:true while the button is held or the IMU is
    // shaking; only the rising edge (or the first true after a lost link) is a new event.
    if (reading.incident && !(wasFresh && previous.incident)) {
      this.incidentSeq += 1;
      this.lastIncident = {
        seq: this.incidentSeq,
        at: now,
        vehicleId: reading.driver,
        triggerSource: reading.triggerSource,
        accelMagnitudeMs2: reading.accelMagnitudeMs2,
        simulated: reading.simulated,
      };
    }
    this.latest = reading;
    this.lastPacketAt = now;
    this.packetCount += 1;
    return this.status(now);
  }

  status(now = Date.now()) {
    const ageMs = this.latest ? Math.max(0, now - this.lastPacketAt) : null;
    const fresh = this.latest !== null && ageMs <= this.staleAfterMs;
    const shared = {
      lastPacketAt: this.lastPacketAt || null, ageMs, packetCount: this.packetCount, staleAfterMs: this.staleAfterMs,
      // Incident events are real past events from received packets, so they are reported even when the link is stale.
      incident: { seq: this.incidentSeq, last: this.lastIncident ? { ...this.lastIncident } : null, active: fresh && this.latest.incident },
    };
    if (fresh) {
      const simulated = this.latest.simulated;
      return {
        ...shared,
        connected: true,
        simulated,
        state: simulated ? "BENCH" : "LIVE",
        mode: simulated ? "BENCH SIMULATOR" : "HARDWARE",
        degraded: false,
        detectionSource: simulated ? "Bench simulator (not a physical sensor)" : "ESP32 + IMU incident node",
        reading: { ...this.latest },
        message: simulated ? "Bench simulator packets flowing — flagged simulated, not hardware" : "ESP32 + IMU signal healthy",
      };
    }
    return {
      ...shared,
      connected: false,
      simulated: false,
      state: this.latest ? "SIGNAL_LOST" : "NO_SIGNAL",
      mode: "REPLAY FALLBACK",
      degraded: true,
      detectionSource: "Cached replay (fallback)",
      reading: null,
      message: this.latest
        ? `Signal lost ${(ageMs / 1000).toFixed(1)} s ago — degraded mode, replay fallback active`
        : "No ESP32 signal — degraded mode, replay fallback active",
    };
  }
}
