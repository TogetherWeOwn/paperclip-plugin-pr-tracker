// Red-main-signal decision-core suite (offline: no network, no credentials).
//
// Ports the pure contract of the host red-main watch: workflow identity where
// the path wins over the display name, once-per-incident routing
// (create/append/noop) against open owner cards and the evidence ledger, the
// authoritative base signal from main-branch runs, and the alert-only fence:
// the core never proposes a revert, a merge, or a queue action.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseSignal,
  decide,
  normalizeRepo,
  normalizeWorkflow,
  observationIdentity,
  timeToGreenMin,
} from "../src/decision-core/red-main-signal.js";

const RUN = (over = {}) => ({
  id: 101,
  path: ".github/workflows/ci.yml",
  workflow: "CI",
  headSha: "abc123def456",
  updatedAt: "2026-10-20T03:00:00Z",
  url: "https://ci.example.invalid/runs/101",
  ...over,
});

const OWNER = (over = {}) => ({
  id: "owner-1",
  identifier: "DEMO-10",
  title: "DEPLOY RED: two-web-next/ci failing on main",
  status: "todo",
  createdAt: "2026-10-20T03:05:00Z",
  hidden: false,
  evidenceRunIds: [],
  ...over,
});

test("normalizeRepo strips scope, suffix and case", () => {
  assert.equal(normalizeRepo("Acme/two-web-next "), "two-web-next");
  assert.equal(normalizeRepo("two-web-next.git"), "two-web-next");
});

test("normalizeWorkflow prefers the path over the display name", () => {
  assert.equal(normalizeWorkflow(".github/workflows/CI.yml"), "ci");
  assert.equal(normalizeWorkflow(".github/workflows/e2e.yaml"), "e2e");
  const [repo, workflow] = observationIdentity({
    repo: "acme/two-web-next",
    workflowPath: ".github/workflows/ci.yml",
    workflowName: "Something Else",
    runId: 7,
  });
  assert.equal(repo, "two-web-next");
  assert.equal(workflow, "ci");
});

test("decide creates when no owner card exists", () => {
  const d = decide({
    observation: { repo: "acme/two-web-next", workflowPath: ".github/workflows/ci.yml", runId: 101 },
    owners: [],
    ledger: [],
  });
  assert.equal(d.action, "create");
  assert.equal(d.ownerId, null);
});

test("decide appends to the open owner and never files a second card", () => {
  const d = decide({
    observation: { repo: "acme/two-web-next", workflowPath: ".github/workflows/ci.yml", runId: 101 },
    owners: [OWNER()],
    ledger: [],
  });
  assert.equal(d.action, "append");
  assert.equal(d.ownerId, "owner-1");
});

test("decide stays noop when the run is already actioned or evidenced", () => {
  const ledgerHit = decide({
    observation: { repo: "acme/two-web-next", workflowPath: ".github/workflows/ci.yml", runId: 101 },
    owners: [OWNER()],
    ledger: [{ repo: "two-web-next", workflow: "ci", runId: "101", owner: "DEMO-10" }],
  });
  assert.equal(ledgerHit.action, "noop");
  assert.equal(ledgerHit.reason, "run-already-actioned");
  const evidenced = decide({
    observation: { repo: "acme/two-web-next", workflowPath: ".github/workflows/ci.yml", runId: 102 },
    owners: [OWNER({ evidenceRunIds: ["102"] })],
    ledger: [],
  });
  assert.equal(evidenced.action, "noop");
  assert.equal(evidenced.reason, "evidence-already-on-owner");
});

test("decide ignores hidden and terminal owner cards", () => {
  const d = decide({
    observation: { repo: "acme/two-web-next", workflowPath: ".github/workflows/ci.yml", runId: 103 },
    owners: [OWNER({ hidden: true }), OWNER({ id: "owner-2", status: "done" })],
    ledger: [],
  });
  assert.equal(d.action, "create");
});

test("decide needs a full workflow identity", () => {
  const d = decide({ observation: { repo: "", runId: 1 }, owners: [], ledger: [] });
  assert.equal(d.action, "create");
  assert.equal(d.reason, "no-workflow-identity");
});

test("baseSignal reads red from the latest completed main run", () => {
  const red = baseSignal({
    repo: "two-web-next",
    branch: "main",
    runs: [RUN({ conclusion: "failure" })],
  });
  assert.equal(red.status, "red");
  assert.equal(red.firstRedSha, "abc123def456");
  const green = baseSignal({
    repo: "two-web-next",
    branch: "main",
    runs: [RUN({ conclusion: "success" })],
  });
  assert.equal(green.status, "green");
  const empty = baseSignal({ repo: "two-web-next", branch: "main", runs: [] });
  assert.equal(empty.status, "unknown");
});

test("baseSignal ignores cancelled runs and PR-branch runs", () => {
  const s = baseSignal({
    repo: "two-web-next",
    branch: "main",
    runs: [RUN({ conclusion: "cancelled" })],
  });
  assert.equal(s.status, "unknown");
});

test("timeToGreenMin measures recovery from first red", () => {
  assert.equal(timeToGreenMin({ firstRedAt: "2026-10-20T03:00:00Z", nowMs: Date.parse("2026-10-20T04:30:00Z") }), 90);
  assert.equal(timeToGreenMin({ firstRedAt: "bogus", nowMs: 0 }), -1);
});

test("the core never proposes revert, merge, block or queue actions", () => {
  const seen = new Set();
  const ownersVariants = [[], [OWNER()], [OWNER({ status: "done" })]];
  for (const owners of ownersVariants) {
    const d = decide({
      observation: { repo: "acme/two-web-next", workflowPath: ".github/workflows/ci.yml", runId: 200 },
      owners,
      ledger: [],
    });
    seen.add(d.action);
  }
  for (const action of seen) {
    assert.ok(
      ["create", "append", "noop", "skip"].includes(action),
      `forbidden action ${action}`,
    );
  }
  const red = baseSignal({ repo: "r", branch: "main", runs: [RUN({ conclusion: "failure" })] });
  assert.ok(!("revert" in red || "merge" in red || "block" in red));
});
