import { describe, expect, it } from "vitest";
import { claimRefFrom } from "../src/phone/routes.ts";

describe("claimRefFrom", () => {
  it("reads claim numbers the way callers say them", () => {
    expect(claimRefFrom("CLM-1047")).toBe("CLM-1047");
    expect(claimRefFrom("clm 1047")).toBe("CLM-1047");
    expect(claimRefFrom("1047")).toBe("CLM-1047");
    expect(claimRefFrom("we are from autoshop for claim 1047. the damages are quoted for $152131")).toBe("CLM-1047");
    expect(claimRefFrom("about claim number 1047")).toBe("CLM-1047");
  });
  it("does not take an amount or a phone number for a claim", () => {
    expect(claimRefFrom("the damages are quoted for $152131")).toBe("");
    expect(claimRefFrom("call me back at 416 555 1002")).toBe("");
    expect(claimRefFrom("")).toBe("");
  });
});
