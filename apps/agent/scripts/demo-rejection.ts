/** Bonus scene — Rejection: the insurer refuses a medical invoice ("missing treatment code"). Never retried; a fact task gets the code from the clinic; a NEW key supersedes the old action. */
import { actions, api, banner, check, fileClaim, freshWorld, MOCKS, printHistory, printTasks, run, step, tasks, waitFor } from "./lib.ts";

run("demo-rejection", async () => {
  banner("Bonus · Rejection: insurer rejects a medical invoice");
  await freshWorld({ claimDayMs: 6_000 });
  step("Chaos: POST /chaos/insurer-reject-next-invoice {reason: 'missing treatment code'}");
  await api("POST", `${MOCKS}/chaos/insurer-reject-next-invoice`, { reason: "missing treatment code" });
  const id = await fileClaim({ injuries: true });
  const t13 = await waitFor("first clinic invoice -> T13 copy", async () => (await tasks.listTasks(id)).find((t) => t.taskId.startsWith("T13#") && !t.taskId.includes(":")), 90_000);
  await waitFor(`${t13.taskId} confirmed after the corrected resubmission`, async () => (await tasks.getTask(id, t13.taskId))?.status === "confirmed", 90_000);
  const list = (await actions.listActions(id, { taskId: t13.taskId })).filter((a) => a.kind === "submit_medical_invoice");
  check(list.length === 2, `two submissions for ${t13.taskId}`);
  const [first, second] = list;
  check(first!.status === "rejected" && first!.history.filter((h) => h.status === "sent").length === 1, "the rejected action was never retried");
  check(second!.idempotencyKey !== first!.idempotencyKey && second!.idempotencyKey.endsWith(":2"), `new key ${second!.idempotencyKey}`);
  check(String(second!.supersedes?.actionId) === String(first!._id), "the corrected action supersedes the rejected one");
  check(typeof second!.payload.treatmentCode === "string", `corrected payload includes treatmentCode ${second!.payload.treatmentCode}`);
  const fact = await tasks.getTask(id, `${t13.taskId}:fact`);
  check(fact?.status === "confirmed", `fact-gathering task ${fact?.taskId} confirmed by a clinic read-back`);
  await printTasks(id);
  await printHistory(id, (a) => a.taskId.startsWith(t13.taskId));
});
