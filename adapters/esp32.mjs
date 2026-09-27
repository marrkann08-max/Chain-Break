// Hardware boundary: parse a JSON packet sent by an ESP32 + IMU incident node
// over serial, USB or Wi-Fi (HTTP POST /api/hardware/packet).
// Expected input: { ts, vehicle_id, speed_kph, imu_ax, imu_ay, imu_az, accel_magnitude_ms2,
//                   track_distance_m, incident, trigger_source, sequence, simulated? }
// Packets flagged `simulated: true` come from the bench simulator and are never
// reported as physical hardware.

const NUMERIC_FIELDS = ["ts", "speed_kph", "throttle_pct", "brake_pct", "gear", "rpm", "track_distance_m", "ultrasonic_cm", "imu_ax", "imu_ay", "imu_az", "accel_magnitude_ms2", "sequence"];
const TRIGGER_SOURCES = new Set(["button", "imu", "none"]);

export function fromEsp32(packet, previousDistance = 0) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new TypeError("ESP32 packet must be a JSON object");
  for (const field of NUMERIC_FIELDS) {
    if (packet[field] !== undefined && packet[field] !== null && !Number.isFinite(Number(packet[field]))) {
      throw new TypeError(`ESP32 packet field "${field}" must be a finite number`);
    }
  }
  const simulated = packet.simulated === true;
  return {
    t: Number(packet.ts ?? Date.now()),
    driver: typeof packet.vehicle_id === "string" && packet.vehicle_id.trim() ? packet.vehicle_id.trim().slice(0, 32) : "TRACK UNIT",
    speed: Number(packet.speed_kph ?? 0),
    throttle: Number(packet.throttle_pct ?? 0),
    brake: Number(packet.brake_pct ?? 0),
    gear: Number(packet.gear ?? 0),
    rpm: Number(packet.rpm ?? 0),
    distance: Number(packet.track_distance_m ?? previousDistance),
    ultrasonicDistanceM: Number(packet.ultrasonic_cm ?? 0) / 100,
    imuAccelerationMs2: Number(packet.imu_ax ?? 0),
    imuAyMs2: Number(packet.imu_ay ?? 0),
    imuAzMs2: Number(packet.imu_az ?? 0),
    accelMagnitudeMs2: packet.accel_magnitude_ms2 === undefined || packet.accel_magnitude_ms2 === null ? null : Number(packet.accel_magnitude_ms2),
    // Only a literal boolean true counts; "true", 1, etc. are not incidents.
    incident: packet.incident === true,
    triggerSource: TRIGGER_SOURCES.has(packet.trigger_source) ? packet.trigger_source : "unknown",
    sequence: packet.sequence === undefined || packet.sequence === null ? null : Number(packet.sequence),
    simulated,
    source: simulated ? "bench-simulator" : "esp32",
  };
}
