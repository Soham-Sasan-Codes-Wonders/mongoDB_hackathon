import { claims, clock, leases, observations, timers } from "../db.ts";
import type { ResumeToken } from "mongodb";
import { config } from "../config.ts";
import { errMsg, log } from "../log.ts";
import { runClaim, type WorkerState } from "./loop.ts";

/**
 * The worker never polls outside systems. It wakes on:
 *  1. a change stream on `observations` (resume token saved after each event),
 *  2. a timer loop checking dueTimers(clock.now()) every 2 s,
 *  3. a lease sweeper that takes over claims whose lease expired.
 * Each wake-up runs the same agent loop for that claim; runs per claim are serialised.
 */
export class Waker {
  private running = new Map<string, Promise<void>>();
  private again = new Set<string>();
  private stopped = false;
  private startedWall = Date.now();
  replayed = 0;

  constructor(private w: WorkerState) {}

  wake(claimId: string, why: string) {
    if (this.stopped || !/^CLM-\d+$/.test(claimId)) return;
    if (this.running.has(claimId)) {
      this.again.add(claimId);
      return;
    }
    const p = (async () => {
      try {
        do {
          this.again.delete(claimId);
          await runClaim(claimId, this.w);
        } while (this.again.has(claimId) && !this.stopped);
      } catch (e) {
        log(claimId, `loop crashed (${why}): ${errMsg(e)}`);
        if (process.env.DEBUG) console.error(e);
      } finally {
        this.running.delete(claimId);
      }
    })();
    this.running.set(claimId, p);
  }

  /** 1. change stream on observations, resumed from the saved token. */
  async startChangeStream() {
    let token: ResumeToken | null = await observations.loadResumeToken(this.w.workerId);
    const open = async () => {
      try {
        const stream = await observations.watchObservations(token);
        log(this.w.workerId, token ? "change stream resumed from saved resume token (delivers everything that arrived while down)" : "change stream opened (no saved token)");
        for await (const ev of stream) {
          token = ev._id as ResumeToken;
          await observations.saveResumeToken(this.w.workerId, token);
          if (ev.operationType !== "insert") continue; // only new observations wake the loop
          const o = ev.fullDocument as unknown as { claimId: string; source: string; kind: string; processedAt?: Date; receivedWallAt?: Date };
          if (!o || o.processedAt) continue; // outbound agent messages are inserted pre-processed
          const missed = (o.receivedWallAt?.getTime() ?? Date.now()) < this.startedWall;
          if (missed) this.replayed++;
          log(this.w.workerId, `change stream: ${o.source}.${o.kind} for ${o.claimId}${missed ? " (arrived while this worker was down; replayed from resume token)" : ""}`);
          this.wake(o.claimId, "observation");
        }
      } catch (e) {
        if (this.stopped) return;
        const msg = errMsg(e);
        log(this.w.workerId, `change stream error: ${msg}; reopening`);
        if (/resume|ChangeStreamHistoryLost|token/i.test(msg)) {
          token = null; // token fell off the oplog: rescan unprocessed observations instead
          for (const id of await observations.claimsWithUnprocessed()) this.wake(id, "rescan");
        }
        setTimeout(open, 1000);
      }
    };
    void open();
  }

  /** 2. timer loop (sim clock), every 2 s. */
  startTimerLoop() {
    setInterval(async () => {
      try {
        const due = await timers.dueTimers(clock.now());
        for (const id of new Set(due.map((t) => t.claimId))) this.wake(id, "timer");
      } catch (e) {
        log(this.w.workerId, `timer loop: ${errMsg(e)}`);
      }
    }, config.timerPollMs).unref();
  }

  /** 3. lease sweeper: an expired lease means its worker stopped renewing. */
  startSweeper() {
    setInterval(async () => {
      try {
        for (const l of await leases.expiredLeases()) {
          if (l.workerId === this.w.workerId) continue;
          log(this.w.workerId, `sweeper: lease on ${l._id} held by ${l.workerId} expired ${Math.round((Date.now() - l.expiresAt.getTime()) / 1000)}s ago; taking over`);
          this.wake(l._id, "lease_sweep");
        }
      } catch (e) {
        log(this.w.workerId, `sweeper: ${errMsg(e)}`);
      }
    }, config.sweeperMs).unref();
  }

  /** Lease heartbeat for every claim this worker holds. */
  startHeartbeat() {
    setInterval(async () => {
      try {
        for (const id of [...this.w.held]) if (!(await leases.renewLease(id, this.w.workerId, config.leaseTtlMs))) this.w.held.delete(id);
        await observations.saveWorkerHeartbeat(this.w.workerId, { pid: process.pid, held: [...this.w.held], replayed: this.replayed, startedAt: new Date(this.startedWall) });
      } catch (e) {
        log(this.w.workerId, `heartbeat: ${errMsg(e)}`);
      }
    }, config.heartbeatMs).unref();
  }

  /** Startup: every active claim gets a first wake-up (crash recovery runs on it). */
  async wakeAllActive() {
    for (const id of await claims.listActiveClaimIds()) this.wake(id, "startup");
  }

  async stop() {
    this.stopped = true;
    await Promise.allSettled([...this.running.values()]);
  }
}
