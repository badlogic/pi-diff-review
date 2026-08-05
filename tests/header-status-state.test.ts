import assert from "node:assert/strict";
import test from "node:test";
import { buildHeaderStatusState, githubThreadLabel } from "../web/header-status-state.js";

test("compact header keeps progress readable at narrow desktop widths", () => {
  assert.deepEqual(buildHeaderStatusState({
    detail: "AI analysis complete · 0 findings",
    aiStatus: "done",
    reviewed: 0,
    total: 18,
    staged: 0,
  }), {
    compact: "AI done · 0/18 reviewed · 0 staged",
    accessibleLabel: "AI analysis complete · 0 findings · 0/18 reviewed · 0 staged",
  });
});

test("GitHub thread count hides zero and names nonzero counts", () => {
  assert.equal(githubThreadLabel(0), null);
  assert.equal(githubThreadLabel(1), "1 thread");
  assert.equal(githubThreadLabel(3), "3 threads");
});
