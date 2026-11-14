const t = () => new Date().toISOString().slice(11, 23);
export function log(scope: string, msg: string, extra?: unknown) {
  const line = `${t()} [${scope}] ${msg}`;
  if (extra !== undefined) console.log(line, typeof extra === "string" ? extra : JSON.stringify(extra));
  else console.log(line);
}
export function claimLog(claimId: string, step: string, msg: string, extra?: unknown) {
  log(claimId, `${step} ${msg}`, extra);
}
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
