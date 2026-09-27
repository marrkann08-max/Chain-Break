# ChainBreak

**A hardware-connected stress-testing environment for motorsport safety systems.**

ChainBreak explores a question that conventional safety demos often miss: **when conditions degrade, at what point does a connected warning stop protecting the following driver?**

An ESP32 and MPU6050 act as an incident node. After an incident is detected, ChainBreak models the warning chain from sensing and transmission through driver response and braking. It then tests that chain across 1,200 repeatable scenarios with different network latency, packet loss, grip, sensor availability, and driver delay.

> Track 2 · Safety Testing
>
> Decision-support prototype—not a certified safety system.

## What it does

- Receives physical incident events from an ESP32, MPU6050, and push button.
- Models the approach of a following car toward a stationary incident.
- Generates 1,200 seeded Latin-hypercube stress scenarios.
- Classifies outcomes using simulated stopping margin: safe, marginal, or unsafe.
- Fits an interpretable logistic model to estimate a latency failure boundary.
- Shows which degraded conditions contribute most strongly to unsafe outcomes.
- Compares no warning, yellow, double yellow, and Virtual Safety Car interventions on the same scenarios.
- Enters an explicit degraded mode when hardware packets become stale, without inventing sensor readings.

## Why it matters

Connected safety systems are normally demonstrated under successful conditions. Real deployments must also remain understandable when a sensor disappears, packets are lost, a network slows down, grip decreases, or a driver reacts late.

ChainBreak makes those failure conditions visible and testable. Its output is not a crash prediction; it is a transparent comparison of stopping outcomes under stated assumptions.

## System overview

```text
ESP32 + MPU6050 + button
          │ incident packets
          ▼
Hardware ingest and freshness checks
          │
          ├── live incident activation
          └── stale-link replay fallback
          │
          ▼
Scenario simulator ──► 1,200-condition stress sweep
          │
          ├── failure boundary
          ├── dominant contributors
          ├── intervention comparison
          └── interactive scenario inspector
```

The backend and browser inspector share the same simulation engine, preventing the two views from drifting apart.

## Scenario

The included demonstration models a following car travelling at 252 km/h, 470 m from a stationary incident node. ChainBreak calculates the available approach window, then varies the conditions affecting whether the warning reaches the driver early enough to help.

The bundled replay is a **synthetic historical-style sample** created for this prototype. It is not a recording of a real incident. An offline OpenF1 adapter is included for experimentation, but the demonstration does not depend on internet access.

## Run locally

Requirements: Node.js 18 or newer. Runtime dependencies and API keys are not required.

```bash
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173).

Run the full verification suite:

```bash
npm run check
```

The suite performs syntax checks and 41 tests covering the simulation engine, adapters, hardware edge cases, and HTTP server.

## Controls

| Action | Button | Keyboard |
|---|---|---|
| Play replay | Replay telemetry | `Space` |
| Trigger a simulated incident | Incident | `I` |
| Run the stress sweep | Run 1,200 stress tests | `T` |
| Reset | Reset | `R` |

The dashboard also includes a clearly labelled bench simulator for testing the real ingest and staleness path without hardware.

## Hardware setup

The reference node uses an ESP32 development board and an MPU6050 IMU.

| MPU6050 | ESP32 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO 21 |
| SCL | GPIO 22 |

Connect the push button between GPIO 4 and GND. The firmware uses the ESP32's internal pull-up resistor.

Copy `hardware/chainbreak-node/secrets.example.h` to `secrets.h`, then enter the local Wi-Fi details and the computer's LAN address. `secrets.h` is excluded from Git.

Start the server on the local network:

```powershell
$env:HOST="0.0.0.0"
npm start
```

Flash `hardware/chainbreak-node/chainbreak-node.ino` from Arduino IDE using the **ESP32 Dev Module** board profile. A successful packet is accepted by the server with HTTP status `202`.

## How the model works

For each generated scenario, ChainBreak models:

1. Incident detection, including a fallback delay when the sensor drops out.
2. Decision time for the selected intervention.
3. Network delivery time, packet loss, and retry delay.
4. Driver reaction time.
5. Intervention-specific slowing followed by full braking when the incident becomes visible.
6. Remaining stopping distance relative to a safety buffer.

Every intervention is evaluated against an identical scenario set. A seeded generator makes results repeatable, while a held-out test set checks whether the fitted boundary generalizes across the simulated conditions.

## Technology

- ESP32, MPU6050, and Arduino C++
- Node.js HTTP server with no runtime packages
- HTML, CSS, and vanilla JavaScript dashboard
- Seeded Latin-hypercube sampling
- Logistic regression fitted with iteratively reweighted least squares
- Offline replay and optional OpenF1 telemetry adapter

## Reliability and safety behavior

- Hardware freshness is based on server arrival time rather than the device clock.
- A held incident signal counts once; a new false-to-true edge creates the next event.
- After 2.5 seconds without a packet, the UI clears the live reading and declares replay fallback.
- Simulated bench packets are always identified as simulated.
- Browser requests are origin-checked, JSON bodies are size-limited, and static paths are traversal-safe.

## Limitations

- Results are simulated stopping outcomes, not crash probabilities.
- The included telemetry replay and following-car state are synthetic scenario inputs.
- Braking behavior, intervention response, and decision times are explicit prototype assumptions.
- The fitted model summarizes the simulator; it has not been trained or validated on real incidents.
- ChainBreak is not FIA-grade, safety-certified, or intended for operational race control.

## Repository structure

```text
adapters/                 telemetry and hardware adapters
data/                     bundled synthetic replay
hardware/chainbreak-node/ ESP32 firmware and safe configuration template
lib/                      server, pipeline, and simulation engine
public/                   interactive dashboard
scripts/                  optional data-fetching utility
test/                     automated verification suite
server.mjs                application entry point
```

## Project status

ChainBreak is a hackathon prototype focused on explainable failure testing. Future work includes validation with measured vehicle dynamics, additional circuit scenarios, more hardware nodes, and sensitivity analysis for modeling assumptions.
