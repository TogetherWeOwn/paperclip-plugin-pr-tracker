// Acceptance suite (offline: no network, no credentials).
//
// Two spec invariants the shipped cores must hold:
//
// 1. The authoritative base signal stays unknown on no-evidence. A completed
//    run that did not exercise the code ("neutral" or "skipped", e.g. a
//    path-filter skip) proves nothing about the branch: like a cancelled run
//    it can neither assert green on its own nor clear an earlier completed
//    red. Only a completed success asserts green.
// 2. A rate with a zero denominator is unmeasured, never 0. The weekly
//    report carries every denominator so improvement claims stay honest:
//    with no merged pull requests (or no main-branch runs) in the window,
//    the value is null while the denominator is still reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { baseSignal } from "../src/decision-core/red-main-signal.js";
import { weeklyReport } from "../src/decision-core/flake-quarantine.js";

const RUN = (over = {}) => ({
  id: 101,
  path: ".github/workflows/ci.yml",
  workflow: "CI",
  headSha: "abc123def456",
  updatedAt: "2026-10-20T03:00:00Z",
  url: "https://ci.example.invalid/runs/101",
  status: "completed",
  ...over,
});

for (const conclusion of ["neutral", "skipped"]) {
  test(`baseSignal stays unknown when the only completed run is ${conclusion}`, () => {
    const sig = baseSignal({
      repo: "two-web-next",
      branch: "main",
      runs: [RUN({ conclusion })],
    });
    assert.equal(sig.status, "unknown");
  });

  test(`baseSignal does not let a newer ${conclusion} run clear an earlier red`, () => {
    const sig = baseSignal({
      repo: "two-web-next",
      branch: "main",
      runs: [
        RUN({
          id: 100,
          conclusion: "failure",
          headSha: "redsha000001",
          updatedAt: "2026-10-20T02:00:00Z",
        }),
        RUN({ conclusion }),
      ],
    });
    assert.equal(sig.status, "red");
    assert.equal(sig.runId, 100);
    assert.equal(sig.firstRedSha, "redsha000001");
  });
}

test("weeklyReport reports reruns per merged PR as unmeasured when no PR merged", () => {
  const report = weeklyReport({
    ledger: { flakes: {} },
    reruns: 5,
    mergedPRs: 0,
    redRate: { red: 1, total: 40, windowDays: 7 },
  });
  assert.equal(report.rerunsPerMergedPR.n, 0);
  assert.equal(report.rerunsPerMergedPR.value, null);
});

test("weeklyReport reports the red rate as unmeasured when no main runs were seen", () => {
  const report = weeklyReport({
    ledger: { flakes: {} },
    reruns: 0,
    mergedPRs: 3,
    redRate: { red: 0, total: 0, windowDays: 7 },
  });
  assert.equal(report.redRate.total, 0);
  assert.equal(report.redRate.value, null);
});
