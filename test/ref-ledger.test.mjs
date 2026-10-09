// ref-ledger offline suite. Lifecycle, retirement and issue digests against
// the read-only lifecycle snapshot fixture: no network, no credentials.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  pullLifecycle,
  issueLifecycle,
  retirementFor,
  decideLedger,
  decideIssueLifecycle,
} from "../src/decision-core/ref-ledger.js";
import { writerMarkerForDigest } from "../src/decision-core/upstream-watcher.js";

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/typed-refs-lifecycle-snapshot.json", import.meta.url)), "utf8"),
);
const byNumber = (n) => snapshot.refs.find((ref) => ref.number === n);
const REPO = "paperclipai/paperclip";
const EQUIVALENCE = Object.freeze({ kind: "rebase", sha: "c".repeat(40) });
const TRACK = Object.freeze({ issueId: "issue-11199", identifier: "DEMO-11199", cardOpen: true });

function lifecycleOf(ref) {
  return ref.kind === "issue"
    ? issueLifecycle({ state: ref.state, stateReason: ref.state_reason ?? null })
    : pullLifecycle({ state: ref.state, merged: ref.merged });
}

test("merge_commit_sha on a closed, unmerged PR never proves a merge", () => {
  const closedUnmerged = byNumber(13113);
  assert.ok(closedUnmerged.merge_commit_sha, "fixture carries a merge_commit_sha");
  assert.equal(lifecycleOf(closedUnmerged).terminal, "closed");
  assert.equal(lifecycleOf(byNumber(13663)).terminal, "closed");
  assert.equal(lifecycleOf(byNumber(10317)).terminal, "open");
  assert.equal(pullLifecycle({ state: "closed", merged: true }).terminal, "merged");
});

test("lifecycle closure alone cannot satisfy equivalence policies", () => {
  const closedIssue = issueLifecycle({ state: "closed", stateReason: "completed" });
  const closedPr = lifecycleOf(byNumber(13113));
  for (const lifecycle of [closedIssue, closedPr]) {
    assert.deepEqual(
      retirementFor({ policy: "equivalent_fix_verified", lifecycle, equivalence: null }),
      { retired: false, by: null },
    );
  }
  assert.deepEqual(
    retirementFor({ policy: "equivalent_fix_verified", lifecycle: closedPr, equivalence: EQUIVALENCE }),
    { retired: true, by: "equivalence" },
  );
});

test("merged_or_closed retires on merge or closure and never on open state", () => {
  assert.deepEqual(
    retirementFor({ policy: "merged_or_closed", lifecycle: pullLifecycle({ state: "closed", merged: true }) }),
    { retired: true, by: "merged" },
  );
  assert.deepEqual(
    retirementFor({ policy: "merged_or_closed", lifecycle: lifecycleOf(byNumber(13663)) }),
    { retired: true, by: "closed" },
  );
  assert.deepEqual(
    retirementFor({ policy: "merged_or_closed", lifecycle: lifecycleOf(byNumber(10317)) }),
    { retired: false, by: null },
  );
});

test("ledger history appends on transitions and never drops prior evidence", () => {
  const open = decideLedger({
    policy: "merged_or_closed",
    lifecycle: lifecycleOf(byNumber(10317)),
    atMs: 1,
  });
  assert.equal(open.state, "active");
  assert.equal(open.history.length, 1);

  const merged = decideLedger({
    policy: "merged_or_closed",
    prev: open,
    lifecycle: pullLifecycle({ state: "closed", merged: true }),
    atMs: 2,
  });
  assert.equal(merged.state, "retired");
  assert.equal(merged.retiredBy, "merged");
  assert.equal(merged.history.length, 2);
  assert.equal(merged.history[0].to, "active");

  const unchanged = decideLedger({
    policy: "merged_or_closed",
    prev: merged,
    lifecycle: pullLifecycle({ state: "closed", merged: true }),
    atMs: 3,
  });
  assert.equal(unchanged.history.length, 2);

  const reopened = decideLedger({
    policy: "merged_or_closed",
    prev: merged,
    lifecycle: lifecycleOf(byNumber(10317)),
    atMs: 4,
  });
  assert.equal(reopened.state, "active");
  assert.equal(reopened.history.length, 3);
  assert.equal(merged.history.length, 2, "prior ledger object is not mutated");
});

test("an equivalence-policy issue stays active after closure, with the closure recorded", () => {
  const closed = decideLedger({
    policy: "equivalent_fix_verified",
    lifecycle: issueLifecycle({ state: "closed", stateReason: "not_planned" }),
    atMs: 10,
  });
  assert.equal(closed.state, "active");
  assert.equal(closed.lifecycle.terminal, "closed");
  assert.equal(closed.lifecycle.stateReason, "not_planned");
});

test("issue lifecycle: untracked and baseline never wake; a closure produces one digest", () => {
  const open = decideLedger({ policy: "equivalent_fix_verified", lifecycle: issueLifecycle({ state: "open" }), atMs: 1 });
  const closed = decideLedger({
    policy: "equivalent_fix_verified",
    prev: open,
    lifecycle: issueLifecycle({ state: "closed", stateReason: "completed" }),
    atMs: 2,
  });

  assert.equal(decideIssueLifecycle({ prevLedger: null, nextLedger: open, tracking: null, repository: REPO, number: 11199 }).action, "untracked");
  assert.equal(decideIssueLifecycle({ prevLedger: null, nextLedger: open, tracking: TRACK, repository: REPO, number: 11199 }).action, "baseline");
  assert.equal(decideIssueLifecycle({ prevLedger: open, nextLedger: open, tracking: TRACK, repository: REPO, number: 11199 }).action, "silent");

  const digest = decideIssueLifecycle({ prevLedger: open, nextLedger: closed, tracking: TRACK, repository: REPO, number: 11199 });
  assert.equal(digest.action, "digest");
  assert.deepEqual(digest.changes.map((c) => c.kind), ["closed"]);
  assert.equal(digest.issueId, TRACK.issueId);
  assert.equal(digest.identifier, TRACK.identifier);
  assert.match(digest.dedupeKey, /^upstream-digest:paperclipai\/paperclip#11199:[0-9a-f]{16}$/);
  assert.equal(digest.nextLedger, closed);
});

test("an already-delivered issue digest latches instead of waking again", () => {
  const open = decideLedger({ policy: "equivalent_fix_verified", lifecycle: issueLifecycle({ state: "open" }), atMs: 1 });
  const closed = decideLedger({
    policy: "equivalent_fix_verified",
    prev: open,
    lifecycle: issueLifecycle({ state: "closed" }),
    atMs: 2,
  });
  const digest = decideIssueLifecycle({ prevLedger: open, nextLedger: closed, tracking: TRACK, repository: REPO, number: 11199 });
  const marker = writerMarkerForDigest(digest);
  const latched = decideIssueLifecycle({
    prevLedger: open,
    nextLedger: closed,
    tracking: TRACK,
    repository: REPO,
    number: 11199,
    cardMarkers: [`Recovery decision \`${marker}\``],
  });
  assert.equal(latched.action, "latched");
  assert.equal(latched.nextLedger, closed);
});
