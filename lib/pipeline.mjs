import { assessRisk, deriveFeatures } from "./risk-engine.mjs";

export function normalizeReading(reading, source = "replay") {
  return {
    t: Number(reading.t),
    driver: reading.driver || "CAR 16",
    speed: Number(reading.speed),
    throttle: Number(reading.throttle ?? 0),
    brake: Number(reading.brake ?? 0),
    gear: Number(reading.gear ?? 0),
    rpm: Number(reading.rpm ?? 0),
    distance: Number(reading.distance ?? 0),
    yellow: Boolean(reading.yellow),
    source,
  };
}

export function processSession(rawReadings, hazardDistanceOnTrack = 5120) {
  const telemetry = rawReadings.map((reading) => normalizeReading(reading, reading.source || "replay"));
  return telemetry.map((current, index) => {
    const previous = telemetry[Math.max(0, index - 1)];
    const hazardDistanceM = Math.max(0, hazardDistanceOnTrack - current.distance);
    const features = deriveFeatures(current, previous, hazardDistanceM);
    return { ...current, features, risk: assessRisk(current, features) };
  });
}
