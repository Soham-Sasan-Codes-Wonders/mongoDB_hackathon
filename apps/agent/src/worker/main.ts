import { clock, closeDb, leases } from "@claims/db";
import { config } from "../config.ts";
import { log } from "../log.ts";
import type { WorkerState } from "./loop.ts";
import { Waker } from "./wake.ts";

const workerId = process.env.WORKER_ID ?? "worker-1";

async function main() {
  await clock.initClock();
  const w: WorkerState = { workerId, recovered: new Set(), held: new Set(), takenOver: new Set() };
  log(workerId, `starting (pid ${process.pid}, LLM ${config.llmMode}, sim now ${clock.now().toISOString()})`);
  const waker = new Waker(w);
  waker.startHeartbeat();
  await waker.startChangeStream();
  waker.startTimerLoop();
  waker.startSweeper();
  await waker.wakeAllActive();

  const shutdown = async (sig: string) => {
    log(workerId, `${sig}: releasing ${w.held.size} lease(s)`);
    await waker.stop();
    for (const id of w.held) await leases.releaseLease(id, workerId);
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
