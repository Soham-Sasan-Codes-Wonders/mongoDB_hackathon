import { join } from "node:path";
import { clock } from "../db.ts";
import { config } from "../config.ts";
import { errMsg, log } from "../log.ts";
import { createMockServer } from "./server.ts";

/** Starts the four mock outside systems + chaos endpoints on :4000, advancing on the simulated clock. */
export async function startMocks() {
  await clock.initClock();
  const statePath = process.env.MOCK_STATE_PATH ?? join(process.cwd(), ".data", "mocks.json");
  const mocks = createMockServer({
    now: () => clock.nowMs(),
    statePath,
    webhook: async (system, payload) => {
      try {
        await fetch(`${config.controlUrl}/webhooks/${system}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        log("mocks", `webhook ${system}.${payload.event} undeliverable: ${errMsg(e)}`);
      }
    },
  });
  await mocks.app.listen({ port: config.mocksPort, host: "0.0.0.0" });
  setInterval(() => {
    try {
      mocks.tick();
    } catch (e) {
      log("mocks", `tick failed: ${errMsg(e)}`);
    }
  }, 500).unref();
  setInterval(() => mocks.flush(), 1000).unref();
  log("mocks", `insurer / body_shop / rental / clinic + chaos listening on :${config.mocksPort} (state ${statePath})`);
  return mocks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMocks().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
