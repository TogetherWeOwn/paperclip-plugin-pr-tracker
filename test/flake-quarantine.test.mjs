// Flaky-quarantine decision-core suite (offline: no network, no credentials).
//
// Ports the pure contract of the host flake ledger: log parsing across the
// five runner dialects, the flip-rate ladder (rate > 0.2 over >= 5 runs),
// quarantine-and-label with an evidence link, and the hard fence that an
// unproven label never blocks a PR. Ends in a 7-day backfill pass proving
// label precision on the committed fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  flipRate,
  isFlaky,
  ledgerKey,
  parseFailedTests,
  decideQuarantine,
  weeklyReport,
} from "../src/decision-core/flake-quarantine.js";

const BACKFILL = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/flake-backfill-7d.json", import.meta.url)), "utf8"),
);

test("parseFailedTests reads the cargo dialect", () => {
  const log = "test suites::web::renders_home ... FAILED\ntest ok_one ... ok\n";
  assert.deepEqual(parseFailedTests(log), ["suites::web::renders_home"]);
});

test("parseFailedTests reads the vitest dialect with ANSI and timestamps", () => {
  const log =
    "2026-10-20T03:11:22Z \u001b[31mFAIL  src/auth/login.spec.ts > rejects expired sessions 42ms\u001b[0m\n";
  assert.deepEqual(parseFailedTests(log), ["src/auth/login.spec.ts > rejects expired sessions"]);
});

test("parseFailedTests reads TAP, unittest and nextest, caps at 20", () => {
  const tap = "not ok 7 - renders the sidebar\n";
  assert.deepEqual(parseFailedTests(tap), ["renders the sidebar"]);
  const unit = "FAIL: test_retry (sync.worker.SyncTest)\n";
  assert.deepEqual(parseFailedTests(unit), ["sync.worker.SyncTest.test_retry"]);
  const nextest = "    FAIL [   0.312s] (3/9) net::flaky_handshake\n";
  assert.deepEqual(parseFailedTests(nextest), ["net::flaky_handshake"]);
  const many = Array.from({ length: 25 }, (_, i) => `not ok ${i + 1} - case_${i}`).join("\n");
  assert.equal(parseFailedTests(many).length, 20);
});

test("parseFailedTests returns [] when no test name can be parsed", () => {
  assert.deepEqual(parseFailedTests("error: linker failed with code 1\n"), []);
});

test("flipRate is flips over observations, 0 on empty", () => {
  assert.equal(flipRate({ observations: 8, flips: 3 }), 0.375);
  assert.equal(flipRate({ observations: 0, flips: 0 }), 0);
});

test("ledgerKey joins repo|workflow|job|test", () => {
  assert.equal(
    ledgerKey({ repo: "two-bot-next", workflow: "check", job: "unit", test: "net::x" }),
    "two-bot-next|check|unit|net::x",
  );
});

function ledger(entries) {
  return { flakes: Object.fromEntries(entries) };
}

test("isFlaky says yes only at rate > 0.2 over >= 5 runs", () => {
  const proven = ledger([["two-bot-next|check|unit|net::x", { observations: 8, flips: 3 }]]);
  const ok = isFlaky(proven, "two-bot-next", "net::x");
  assert.equal(ok.flaky, true);
  assert.equal(ok.detail.observations, 8);
  const thin = ledger([["two-bot-next|check|unit|net::x", { observations: 4, flips: 4 }]]);
  assert.equal(isFlaky(thin, "two-bot-next", "net::x").flaky, false);
  const steady = ledger([["two-bot-next|check|unit|net::x", { observations: 10, flips: 2 }]]);
  assert.equal(isFlaky(steady, "two-bot-next", "net::x").flaky, false);
});

test("isFlaky answers for any repo and matches job-or-test substrings", () => {
  const state = ledger([["some-new-repo|ci|build|job compile", { observations: 6, flips: 2 }]]);
  assert.equal(isFlaky(state, "some-new-repo", "compile").flaky, true);
  assert.equal(isFlaky(state, "some-new-repo", "nope").flaky, false);
  assert.match(isFlaky(state, "some-new-repo", "nope").detail.reason, /not in ledger/);
});

test("decideQuarantine labels a proven flake with the evidence link", () => {
  const state = ledger([["two-web-next|ci|e2e|cart::checkout", { observations: 7, flips: 2 }]]);
  const out = decideQuarantine({
    ledger: state,
    repo: "two-web-next",
    workflow: "ci",
    job: "e2e",
    tests: ["cart::checkout"],
    evidenceUrl: "https://ci.example.invalid/runs/123",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].action, "label");
  assert.equal(out[0].label, "flaky-quarantine");
  assert.equal(out[0].evidenceUrl, "https://ci.example.invalid/runs/123");
  assert.match(out[0].note, /7 obs/);
});

test("decideQuarantine never blocks on an unproven label", () => {
  const state = ledger([["two-web-next|ci|e2e|cart::guest", { observations: 2, flips: 2 }]]);
  const out = decideQuarantine({
    ledger: state,
    repo: "two-web-next",
    workflow: "ci",
    job: "e2e",
    tests: ["cart::guest"],
    evidenceUrl: "https://ci.example.invalid/runs/124",
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].action, "none");
  for (const d of out) assert.notEqual(d.action, "block");
  const empty = decideQuarantine({
    ledger: { flakes: {} },
    repo: "two-web-next",
    workflow: "ci",
    job: "e2e",
    tests: ["cart::fresh"],
    evidenceUrl: "https://ci.example.invalid/runs/125",
  });
  assert.equal(empty[0].action, "none");
  assert.notEqual(empty[0].action, "block");
});

test("weeklyReport carries denominators and reruns per merged PR with n", () => {
  const state = ledger([
    ["a|ci|u|t1", { observations: 8, flips: 3, card: "DEMO-1" }],
    ["a|ci|u|t2", { observations: 6, flips: 0 }],
  ]);
  const report = weeklyReport({
    ledger: state,
    reruns: 5,
    mergedPRs: 20,
    redRate: { red: 1, total: 40, windowDays: 7 },
  });
  assert.equal(report.keys, 2);
  assert.equal(report.rerunsPerMergedPR.n, 20);
  assert.equal(report.rerunsPerMergedPR.value, 0.25);
  assert.equal(report.redRate.windowDays, 7);
  assert.equal(report.entries[0].observations, 8);
  assert.equal(report.entries[0].rate, 0.375);
});

test("7-day backfill: labels land only on proven flakes (precision 1.0)", () => {
  let labels = 0;
  let provenLabeled = 0;
  for (const day of BACKFILL.days) {
    for (const key of Object.keys(day.flakes)) {
      const [repo, workflow, job, testName] = key.split("|");
      const [out] = decideQuarantine({
        ledger: { flakes: day.flakes },
        repo,
        workflow,
        job,
        tests: [testName],
        evidenceUrl: `https://ci.example.invalid/backfill/${day.date}`,
      });
      const proven = BACKFILL.proven.includes(key);
      if (out.action === "label") {
        labels += 1;
        if (proven) provenLabeled += 1;
        assert.ok(proven, `${key} labeled without proof on ${day.date}`);
        assert.ok(out.evidenceUrl.length > 0, "label carries evidence");
      } else {
        assert.ok(!proven, `${key} proven but unlabeled on ${day.date}`);
      }
    }
  }
  assert.ok(labels > 0, "backfill labels at least one proven flake");
  assert.equal(provenLabeled / labels, 1);
});
