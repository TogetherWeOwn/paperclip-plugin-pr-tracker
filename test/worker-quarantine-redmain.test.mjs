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

for (const asynchronous of [false, true]) {
  test(`quarantine tick records label ${asynchronous ? "rejection" : "throw"} and processes later tests and entries`, async () => {
    const applied = [];
    const failure = (tests) => ({
      repo: "sample", workflow: "ci", job: "unit", tests,
      evidenceUrl: "https://ci.example.invalid/runs/9",
    });
    const out = await runQuarantineTick({
      ledger: { flakes: Object.fromEntries(["t1", "t2", "t3", "t4"].map((name) => [
        `sample|ci|unit|${name}`, { observations: 7, flips: 2 },
      ])) },
      failures: [failure(["t1", "t2", "t3"]), failure(["t4"])],
      applyLabel: (d) => {
        if (d.key.endsWith("|t2")) {
          if (asynchronous) return Promise.reject(new Error("label unavailable"));
          throw new Error("label unavailable");
        }
        applied.push(d.key);
        return `card-${d.key}`;
      },
    });
    assert.deepEqual(applied, ["sample|ci|unit|t1", "sample|ci|unit|t3", "sample|ci|unit|t4"]);
    assert.deepEqual(out.applied.map((d) => d.key), applied);
    assert.equal(out.decisions.length, 4);
    assert.deepEqual(out.errors, [{
      failureIndex: 0, stage: "apply-label", key: "sample|ci|unit|t2", error: "label unavailable",
    }]);
  });
}

for (const malformed of [null, { evidenceUrl: undefined }, { tests: "not-an-array" }]) {
  test(`quarantine tick records malformed entry ${JSON.stringify(malformed)} and continues`, async () => {
    const valid = {
      repo: "two-web-next", workflow: "ci", job: "e2e", tests: ["cart::checkout"],
      evidenceUrl: "https://ci.example.invalid/runs/9",
    };
    const out = await runQuarantineTick({
      ledger: LEDGER,
      failures: [valid, malformed === null ? null : { ...valid, ...malformed }, valid],
      applyLabel: async () => "card-1",
    });
    assert.equal(out.decisions.length, 2);
    assert.equal(out.applied.length, 2);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].failureIndex, 1);
    assert.equal(out.errors[0].stage, "decision");
    assert.ok(out.errors[0].error.length > 0);
  });
}

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

for (const stage of ["owner-lookup", "append-evidence", "open-card", "routing"]) {
  for (const asynchronous of stage === "routing" ? [false] : [false, true]) {
    test(`red-main tick records ${stage} ${asynchronous ? "rejection" : "throw"} and continues`, async () => {
      const signals = [501, 502, 503].map((runId) => ({
        repo: "acme/two-web-next", branch: "main", status: "red", runId,
        workflowPath: ".github/workflows/ci.yml",
      }));
      const owner = { id: "owner-1", title: "DEPLOY RED: two-web-next/ci failing on main", status: "todo" };
      const completed = [];
      const fail = () => {
        if (asynchronous) return Promise.reject(new Error("dependency unavailable"));
        throw new Error("dependency unavailable");
      };
      const out = await runRedMainTick({
        signals,
        ownersFor: (signal) => {
          if (signal.runId === 502 && stage === "owner-lookup") return fail();
          if (signal.runId === 502 && stage === "routing") return {}; // invalid owner response
          return stage === "append-evidence" ? [owner] : [];
        },
        ledger: [],
        appendEvidence: ({ signal }) => {
          if (signal.runId === 502 && stage === "append-evidence") return fail();
          completed.push(signal.runId);
        },
        openCard: (signal) => {
          if (signal.runId === 502 && stage === "open-card") return fail();
          completed.push(signal.runId);
          return `card-${signal.runId}`;
        },
      });
      assert.deepEqual(completed, [501, 503]);
      assert.equal(out.outcomes.length, 3);
      assert.equal(out.outcomes[0].runId, 501);
      assert.equal(out.outcomes[2].runId, 503);
      const failed = out.outcomes[1];
      assert.equal(failed.status, "red");
      assert.equal(failed.runId, 502);
      assert.equal(failed.action, stage === "owner-lookup" ? "skip" : "error");
      assert.equal(failed.reason, `${stage}-failed`);
      assert.ok(failed.error.length > 0);
      if (stage !== "routing") assert.equal(failed.error, "dependency unavailable");
    });
  }
}

test("red-main tick accepts asynchronous owner reads without creating duplicates", async () => {
  const appended = [];
  const out = await runRedMainTick({
    signals: [{ repo: "two-web-next", status: "red", runId: 504, workflowPath: ".github/workflows/ci.yml" }],
    ownersFor: async () => [{ id: "owner-1", title: "DEPLOY RED: two-web-next/ci failing on main", status: "todo" }],
    ledger: [],
    appendEvidence: async (e) => void appended.push(e.signal.runId),
    openCard: async () => assert.fail("must append to existing owner"),
  });
  assert.deepEqual(appended, [504]);
  assert.equal(out.outcomes[0].action, "append");
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

test("red-main tick never opens a card for a workflow-less red signal", async () => {
  let opened = 0;
  const out = await runRedMainTick({
    signals: [{ repo: "acme/two-web-next", branch: "main", status: "red", runId: 401 }],
    ownersFor: () => [],
    ledger: [],
    appendEvidence: async () => {},
    openCard: async () => {
      opened += 1;
      return "DEMO-12";
    },
  });
  assert.equal(out.outcomes[0].action, "skip");
  assert.equal(opened, 0);
});
