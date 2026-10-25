// Worker-adapter suite for the two new jobs (offline: fakes only).
//
// Proves the tick wiring applies labels and routes evidence exactly when
// the core says so, registers under the manifest job keys, and never
// invents a block/revert/merge action.

import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_KEYS } from "../src/manifest.js";
import {
  runQuarantineTick,
  registerFlakyQuarantineJob,
} from "../src/worker/flake-quarantine.js";
import {
  runRedMainTick,
  registerRedMainSignalJob,
} from "../src/worker/red-main-signal.js";

const LEDGER = {
  flakes: {
    "two-web-next|ci|e2e|cart::checkout": { observations: 7, flips: 2 },
    "two-web-next|ci|e2e|cart::guest": { observations: 2, flips: 2 },
  },
};

test("quarantine tick labels proven flakes and skips unproven ones", async () => {
  const labeled = [];
  const out = await runQuarantineTick({
    ledger: LEDGER,
    failures: [
      {
        repo: "two-web-next",
        workflow: "ci",
        job: "e2e",
        tests: ["cart::checkout", "cart::guest"],
        evidenceUrl: "https://ci.example.invalid/runs/9",
      },
    ],
    applyLabel: async (d) => {
      labeled.push(d);
      return "DEMO-7";
    },
  });
  assert.equal(labeled.length, 1);
  assert.equal(labeled[0].label, "flaky-quarantine");
  assert.equal(out.applied[0].cardRef, "DEMO-7");
  assert.equal(out.decisions.filter((d) => d.action === "none").length, 1);
  for (const d of out.decisions) assert.notEqual(d.action, "block");
});

test("quarantine tick validates its inputs", async () => {
  await assert.rejects(() => runQuarantineTick({ failures: [], applyLabel: async () => {} }), /ledger/);
  await assert.rejects(() => runQuarantineTick({ ledger: LEDGER, applyLabel: async () => {} }), /failures/);
});

test("red-main tick appends to the open owner and opens only when needed", async () => {
  const appended = [];
  const opened = [];
  const owners = [
    {
      id: "owner-1",
      title: "DEPLOY RED: two-web-next/ci failing on main",
      status: "todo",
      createdAt: "2026-10-20T03:05:00Z",
      hidden: false,
      evidenceRunIds: [],
    },
  ];
  const out = await runRedMainTick({
    signals: [
      { repo: "acme/two-web-next", branch: "main", status: "red", runId: 301, workflowPath: ".github/workflows/ci.yml" },
      { repo: "acme/two-web-next", branch: "main", status: "green", runId: 302 },
      { repo: "acme/other", branch: "main", status: "red", runId: 303, workflowPath: ".github/workflows/ci.yml" },
    ],
    ownersFor: (s) => (s.repo === "acme/two-web-next" ? owners : []),
    ledger: [],
    appendEvidence: async (e) => void appended.push(e),
    openCard: async (s) => {
      opened.push(s);
      return "DEMO-11";
    },
  });
  assert.deepEqual(out.outcomes[0], { status: "red", action: "append", ownerId: "owner-1", runId: 301 });
  assert.deepEqual(out.outcomes[1], { status: "green", action: "none" });
  assert.equal(out.outcomes[2].action, "create");
  assert.equal(opened.length, 1);
  assert.equal(appended.length, 1);
  for (const o of out.outcomes) {
    assert.ok(!["revert", "merge", "block", "pause"].includes(o.action), `forbidden ${o.action}`);
  }
});

test("jobs register under the manifest keys", () => {
  const seen = {};
  const ctx = { jobs: { register: (k, fn) => void (seen[k] = fn) } };
  const tick = async () => ({ ok: true });
  registerFlakyQuarantineJob(ctx, tick);
  registerRedMainSignalJob(ctx, tick);
  assert.equal(seen[JOB_KEYS.flakyQuarantine], tick);
  assert.equal(seen[JOB_KEYS.redMainSignal], tick);
});
