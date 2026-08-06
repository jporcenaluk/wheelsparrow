import { resolve } from "node:path";

import { buildApp } from "./app.js";
import { loadConfiguration } from "./config.js";
import { createReadinessGate } from "./readiness.js";
import { registerWeb } from "./web.js";

export function parsePort(value: string | undefined): number {
  const port = value === undefined ? 4321 : Number(value);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !/^\d+$/.test(value ?? "4321")
  ) {
    throw new Error("WHEELSPARROW_PORT must be an integer between 0 and 65535");
  }
  return port;
}

async function start(): Promise<void> {
  const configurationPath =
    process.env.WHEELSPARROW_CONFIG ?? resolve("wheelsparrow.yaml");
  await loadConfiguration(configurationPath);

  const readiness = createReadinessGate();
  const app =
    process.env.NODE_ENV === "development"
      ? await buildApp({ readiness })
      : await buildApp({
          readiness,
          registerWeb: async (server) => {
            await registerWeb(
              server,
              resolve(import.meta.dirname, "../../web/dist"),
            );
          },
        });

  const address = await app.listen({
    host: "127.0.0.1",
    port: parsePort(process.env.WHEELSPARROW_PORT),
  });
  readiness.markReady();
  process.stdout.write(`WHEELSPARROW_URL=${address}\n`);

  let closing = false;
  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (closing) return;
    closing = true;
    readiness.markNotReady();
    app.log.info({ signal }, "shutdown requested");
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await app.close();
    clearTimeout(force);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) await start();
