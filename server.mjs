import { createChainBreakServer } from "./lib/app.mjs";

const port = Number(process.env.PORT || 4173);
// Loopback by default. Use HOST=0.0.0.0 only when a physical ESP32 must reach this laptop over Wi-Fi.
const host = process.env.HOST || "127.0.0.1";
const server = await createChainBreakServer();

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${port} is already in use. Close the other ChainBreak window or run with PORT=4174.`);
  else console.error(error);
  process.exit(1);
});

server.listen(port, host, () => console.log(`ChainBreak running at http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port} (offline, no external services)`));
