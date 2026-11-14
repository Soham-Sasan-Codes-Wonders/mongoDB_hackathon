import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../log.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_MAIN = join(here, "..", "worker", "main.ts");

/** Runs workers as child processes so "Kill agent" is a real SIGKILL (kill -9) of the worker. */
export class Supervisor {
  private children = new Map<string, { proc: ChildProcess; startedAt: Date }>();
  private history: { workerId: string; event: string; at: Date; pid?: number; code?: number | null; signal?: string | null }[] = [];

  constructor(public readonly count: number) {}

  ids(): string[] {
    return Array.from({ length: this.count }, (_, i) => `worker-${i + 1}`);
  }

  start(workerId?: string): string[] {
    const started: string[] = [];
    for (const id of workerId ? [workerId] : this.ids()) {
      if (this.children.has(id)) continue;
      const proc = spawn(process.execPath, ["--import", "tsx", WORKER_MAIN], {
        env: { ...process.env, WORKER_ID: id },
        stdio: ["ignore", "inherit", "inherit"],
      });
      this.children.set(id, { proc, startedAt: new Date() });
      this.history.push({ workerId: id, event: "started", at: new Date(), pid: proc.pid });
      log("supervisor", `started ${id} (pid ${proc.pid})`);
      proc.on("exit", (code, signal) => {
        this.children.delete(id);
        this.history.push({ workerId: id, event: "exited", at: new Date(), code, signal });
        log("supervisor", `${id} exited (code ${code}, signal ${signal}); not restarting automatically`);
      });
      started.push(id);
    }
    return started;
  }

  /** SIGKILL: the worker gets no chance to clean up, release leases or flush anything. */
  kill(workerId?: string): { workerId: string; pid: number | undefined }[] {
    const out: { workerId: string; pid: number | undefined }[] = [];
    for (const [id, c] of this.children) {
      if (workerId && id !== workerId) continue;
      c.proc.kill("SIGKILL");
      this.history.push({ workerId: id, event: "killed (SIGKILL)", at: new Date(), pid: c.proc.pid });
      log("supervisor", `killed ${id} (pid ${c.proc.pid}) with SIGKILL`);
      out.push({ workerId: id, pid: c.proc.pid });
    }
    return out;
  }

  status() {
    return {
      configured: this.ids(),
      running: [...this.children.entries()].map(([id, c]) => ({ workerId: id, pid: c.proc.pid, startedAt: c.startedAt })),
      history: this.history.slice(-20),
    };
  }

  stopAll() {
    for (const c of this.children.values()) c.proc.kill("SIGTERM");
  }
}
