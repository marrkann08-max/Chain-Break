export const DEFAULT_THRESHOLDS = Object.freeze({
  hardBrakeMs2: -7.5,
  rapidDecelMs2: -4.5,
  hazardDistanceM: 120,
  criticalEtaS: 4.0,
  speedFloorKph: 70,
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function deriveFeatures(current, previous, hazardDistanceM) {
  const dt = Math.max(0.1, (current.t - previous.t) / 1000);
  const speedMs = current.speed / 3.6;
  const acceleration = (speedMs - previous.speed / 3.6) / dt;
  const braking = acceleration < -1.5;
  const closingSpeedMs = Math.max(0, speedMs);
  const etaS = closingSpeedMs > 0.5 ? hazardDistanceM / closingSpeedMs : Infinity;
  return {
    acceleration: Number(acceleration.toFixed(2)),
    deceleration: Number(Math.min(0, acceleration).toFixed(2)),
    braking,
    hazardDistanceM: Number(Math.max(0, hazardDistanceM).toFixed(1)),
    etaS: Number.isFinite(etaS) ? Number(etaS.toFixed(1)) : null,
  };
}

export function assessRisk(telemetry, features, thresholds = DEFAULT_THRESHOLDS) {
  const reasons = [];
  let score = 5;

  if (features.deceleration <= thresholds.rapidDecelMs2) {
    const severe = features.deceleration <= thresholds.hardBrakeMs2;
    score += severe ? 32 : 18;
    reasons.push({ label: severe ? "Severe deceleration" : "Rapid deceleration", value: `${features.deceleration} m/s²`, weight: severe ? 32 : 18 });
  }
  if (features.hazardDistanceM <= thresholds.hazardDistanceM) {
    const proximity = clamp(1 - features.hazardDistanceM / thresholds.hazardDistanceM, 0, 1);
    const weight = Math.round(15 + proximity * 20);
    score += weight;
    reasons.push({ label: "Hazard proximity", value: `${features.hazardDistanceM} m`, weight });
  }
  if (features.etaS !== null && features.etaS <= thresholds.criticalEtaS) {
    const weight = Math.round(20 + clamp((thresholds.criticalEtaS - features.etaS) / thresholds.criticalEtaS, 0, 1) * 20);
    score += weight;
    reasons.push({ label: "Short arrival window", value: `${features.etaS} s ETA`, weight });
  }
  if (telemetry.speed >= thresholds.speedFloorKph && features.hazardDistanceM <= thresholds.hazardDistanceM) {
    score += 12;
    reasons.push({ label: "High approach speed", value: `${Math.round(telemetry.speed)} km/h`, weight: 12 });
  }
  if (telemetry.yellow) {
    score += 8;
    reasons.push({ label: "Track status", value: "Yellow sector", weight: 8 });
  }

  score = clamp(Math.round(score), 0, 100);
  const level = score >= 75 ? "CRITICAL" : score >= 50 ? "HIGH" : score >= 25 ? "WATCH" : "CLEAR";
  return {
    score,
    level,
    reasons: reasons.sort((a, b) => b.weight - a.weight),
    action: level === "CRITICAL" ? "Deploy local yellow · alert following drivers" : level === "HIGH" ? "Prepare local yellow · monitor closure" : level === "WATCH" ? "Monitor anomaly" : "No intervention",
  };
}
