// Normalizes OpenF1 `car_data` rows into the ChainBreak replay schema.
// Distance is integrated from speed over each row's real timestamp gap, because
// OpenF1 `location` x/y values are not in documented metres. Location rows are
// accepted for interface compatibility but are not used for distance.
export function fromOpenF1(carData, _locationData = []) {
  const sortedCars = [...carData]
    .filter((row) => Number.isFinite(Date.parse(row.date)))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const startedAt = sortedCars.length ? Date.parse(sortedCars[0].date) : 0;
  let cumulativeDistance = 0;
  let previous = null;
  return sortedCars.map((row) => {
    const rowTime = Date.parse(row.date);
    const speed = Number(row.speed) || 0;
    if (previous) {
      const dt = (rowTime - previous.time) / 1000;
      // Skip gaps longer than 2 s (pit/garage or missing data) instead of inventing distance.
      if (dt > 0 && dt <= 2) cumulativeDistance += ((previous.speed + speed) / 2 / 3.6) * dt;
    }
    previous = { time: rowTime, speed };
    return {
      t: rowTime - startedAt,
      driver: `CAR ${row.driver_number}`,
      speed,
      throttle: Number(row.throttle) || 0,
      brake: Number(row.brake) || 0,
      gear: Number(row.n_gear) || 0,
      rpm: Number(row.rpm) || 0,
      distance: Number(cumulativeDistance.toFixed(1)),
      source: "openf1",
    };
  });
}
