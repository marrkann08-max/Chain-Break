import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromOpenF1 } from "../adapters/openf1.mjs";

const sessionKey = process.argv[2] || "latest";
const driver = process.argv[3] || "1";
const base = "https://api.openf1.org/v1";
const carUrl = `${base}/car_data?session_key=${encodeURIComponent(sessionKey)}&driver_number=${encodeURIComponent(driver)}`;

try {
  const response = await fetch(carUrl, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`OpenF1 request failed (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("OpenF1 returned no car_data rows for that session/driver");
  const frames = fromOpenF1(rows);
  const output = resolve(dirname(fileURLToPath(import.meta.url)), "..", "data", "openf1-session.json");
  await mkdir(dirname(output), { recursive: true });
  // Provenance travels with the data so fetched sessions are never confused with the bundled synthetic sample.
  await writeFile(output, JSON.stringify({ provenance: { source: "OpenF1", sessionKey, driverNumber: driver, fetchedAt: new Date().toISOString(), url: carUrl }, frames }, null, 2));
  console.log(`Saved ${frames.length} normalized OpenF1 readings to ${output}`);
} catch (error) {
  console.error(`Could not fetch OpenF1 data: ${error.message}`);
  console.error("The bundled offline replay (data/demo-session.json) is unaffected.");
  process.exitCode = 1;
}
