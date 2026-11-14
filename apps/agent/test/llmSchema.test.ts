import { describe, expect, it } from "vitest";
import { toOutputSchema } from "../src/llm/client.ts";
import { AccidentDetails, CallInterpretation, MappingProposal, RejectionClassification } from "../src/llm/jobs.ts";
import { diffProfile } from "../src/subflows/drift.ts";
import { V1_SYSTEM_SPECS, specToProfileFields } from "../src/db.ts";

const walkObjects = (n: unknown, f: (o: Record<string, unknown>) => void) => {
  if (Array.isArray(n)) return n.forEach((x) => walkObjects(x, f));
  if (n && typeof n === "object") {
    const o = n as Record<string, unknown>;
    if (o.type === "object") f(o);
    Object.values(o).forEach((x) => walkObjects(x, f));
  }
};

describe("structured-output schemas", () => {
  for (const [name, s] of Object.entries({ AccidentDetails, CallInterpretation, MappingProposal, RejectionClassification })) {
    it(`${name}: closed objects, every property required, no unsupported constraints`, () => {
      const js = toOutputSchema(s);
      expect(JSON.stringify(js)).not.toMatch(/"(minimum|maximum|\$schema)"/);
      walkObjects(js, (o) => {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      });
    });
  }
  it("zod still enforces the confidence range the JSON schema can't express", () => {
    expect(MappingProposal.safeParse({ mappings: [], newTasks: [], confidence: 1.4 }).success).toBe(false);
  });
});

describe("drift diff", () => {
  it("detects a rename as removed + added on the same endpoint, and a new workflow step", () => {
    const spec = structuredClone(V1_SYSTEM_SPECS.insurer);
    for (const e of spec.endpoints) for (const f of e.fields) if (f.name === "policyNumber") f.name = "policy_ref";
    spec.workflowSteps.splice(3, 0, "photos");
    const d = diffProfile({ fields: specToProfileFields(V1_SYSTEM_SPECS.insurer), workflowSteps: V1_SYSTEM_SPECS.insurer.workflowSteps }, spec);
    expect(d.added.map((f) => `${f.endpoint}.${f.name}`)).toContain("submit_estimate.policy_ref");
    expect(d.removed.map((f) => `${f.endpoint}.${f.name}`)).toContain("submit_estimate.policyNumber");
    expect(d.newSteps).toEqual(["photos"]);
  });
  it("no change -> empty diff", () => {
    const d = diffProfile({ fields: specToProfileFields(V1_SYSTEM_SPECS.rental), workflowSteps: V1_SYSTEM_SPECS.rental.workflowSteps }, V1_SYSTEM_SPECS.rental);
    expect(d).toEqual({ added: [], removed: [], newSteps: [] });
  });
});
