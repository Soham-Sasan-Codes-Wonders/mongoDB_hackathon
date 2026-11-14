import { clock, setup } from "./db.ts";
import { config } from "./config.ts";
import { buildControlServer } from "./control/server.ts";
import { Supervisor } from "./control/supervisor.ts";
import { log } from "./log.ts";
import { startMocks } from "./mocks/main.ts";

/** `pnpm --filter agent dev`: mocks (:4000) + control/webhooks/phone (:4100) + supervised worker(s). */
async function main() {
  // Collections, validators, indexes and the 3 search indexes (idempotent). Seed data comes from `pnpm db:seed`.
  await setup.setupDatabase();
  await clock.initClock();
  await startMocks();
  const sup = new Supervisor(config.workers);
  const app = buildControlServer(sup);
  await app.listen({ port: config.controlPort, host: "0.0.0.0" });
  log("control", `control API + webhooks + phone on :${config.controlPort} (LLM mode: ${config.llmMode}, ${config.workers} worker(s))`);
  sup.start();
  const stop = () => {
    sup.stopAll();
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
