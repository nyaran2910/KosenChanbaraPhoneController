import { createControllerServer } from "./server.js";

const hostKey = process.env.HOST_KEY ?? "";
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "";
const port = Number(process.env.PORT ?? "8080");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer from 1 to 65535");
}

const app = createControllerServer({ hostKey, publicBaseUrl });
app.server.listen(port, "0.0.0.0", () => {
  console.log(`controller signaling listening on ${port}`);
});

async function shutdown() {
  await app.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
