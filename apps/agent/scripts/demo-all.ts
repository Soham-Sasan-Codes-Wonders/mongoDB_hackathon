/** Runs every scene in sequence (each in its own process). */
import { spawnSync } from "node:child_process";
const scenes = ["demo-day0", "demo-ghost-booking", "demo-crash", "demo-drift", "demo-day30-close", "demo-phone", "demo-rejection"];
const results: [string, boolean][] = [];
for (const s of scenes) {
  const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/${s}.ts`], { stdio: "inherit" });
  results.push([s, r.status === 0]);
}
console.log("\nSummary");
for (const [s, ok] of results) console.log(`  ${ok ? "PASS" : "FAIL"} ${s}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
