// Typed-ref lifecycle and ledger retirement. Pure: no I/O.
//
// Three things stay separate: the upstream lifecycle (what GitHub says now),
// ledger retirement (whether the fork's reference row may retire), and patch
// removal (never automatic, and never decided here). Retirement is a pure
// function of lifecycle, retire policy and equivalence evidence; history only
// grows.

import { createHash } from "node:crypto";
import { duplicateDelivered } from "./upstream-watcher.js";

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Pull request lifecycle. Only an explicit `merged === true` proves a merge;
 * a merge_commit_sha on a closed, unmerged PR is not evidence of anything.
 */
export function pullLifecycle({ state, merged }) {
  requireValue(state === "open" || state === "closed", "pull state is invalid");
  requireValue(typeof merged === "boolean", "pull merged flag is required");
  const terminal = state === "open" ? "open" : merged ? "merged" : "closed";
  return Object.freeze({ kind: "pull_request", state, merged, terminal });
}

export function issueLifecycle({ state, stateReason = null }) {
  requireValue(state === "open" || state === "closed", "issue state is invalid");
  return Object.freeze({
    kind: "issue",
    state,
    stateReason,
    terminal: state === "open" ? "open" : "closed",
  });
}

/**
 * `merged_or_closed` retires on any terminal lifecycle. `equivalent_fix_verified`
 * never retires on lifecycle: closure alone is not equivalence, so only recorded
 * reviewed-code or rebase evidence can retire it.
 */
export function retirementFor({ policy, lifecycle, equivalence = null }) {
  if (policy === "equivalent_fix_verified") {
    return equivalence
      ? Object.freeze({ retired: true, by: "equivalence" })
      : Object.freeze({ retired: false, by: null });
  }
  requireValue(policy === "merged_or_closed", "retire policy is invalid");
  if (lifecycle.terminal === "open") return Object.freeze({ retired: false, by: null });
  return Object.freeze({ retired: true, by: lifecycle.terminal });
}

/**
 * Next ledger record for one typed ref. A history entry is appended whenever
 * the retirement state or the terminal lifecycle changes; entries never drop.
 */
export function decideLedger({ policy, equivalence = null, prev = null, lifecycle, atMs }) {
  requireValue(Number.isInteger(atMs) && atMs >= 0, "atMs is invalid");
  const retirement = retirementFor({ policy, lifecycle, equivalence });
  const state = retirement.retired ? "retired" : "active";
  const previousState = prev ? prev.state : null;
  const previousTerminal = prev ? prev.lifecycle.terminal : null;
  const history = prev ? [...prev.history] : [];
  if (previousState !== state || previousTerminal !== lifecycle.terminal) {
    history.push(Object.freeze({
      atMs,
      from: previousState,
      to: state,
      terminal: lifecycle.terminal,
      by: retirement.by,
    }));
  }
  return Object.freeze({
    policy,
    state,
    retiredBy: retirement.by,
    lifecycle,
    equivalence,
    history: Object.freeze(history),
  });
}

/**
 * One digest per issue lifecycle transition. Same dedupe and writer-marker
 * contract as the PR watcher, so delivery and retries converge identically.
 * `untracked` and `baseline` never wake; `latched` means the writer marker
 * already landed on the tracking task.
 */
export function decideIssueLifecycle({ prevLedger, nextLedger, tracking, repository, number, cardMarkers = [] }) {
  requireValue(Array.isArray(cardMarkers), "cardMarkers must be an array");
  if (!tracking) return Object.freeze({ action: "untracked", repository, number, nextLedger });
  if (!prevLedger) return Object.freeze({ action: "baseline", repository, number, nextLedger });
  const from = prevLedger.lifecycle.terminal;
  const to = nextLedger.lifecycle.terminal;
  if (from === to) return Object.freeze({ action: "silent", repository, number, nextLedger });
  // The transition count separates a re-closure from an earlier closure with the
  // same reason; retries of one transition reuse the same count.
  const signature = createHash("sha256")
    .update(`${repository}#${number}|${to}|${nextLedger.lifecycle.stateReason ?? ""}|${nextLedger.history.length}`)
    .digest("hex");
  const digest = Object.freeze({
    action: "digest",
    dedupeKey: `upstream-digest:${repository}#${number}:${signature.slice(0, 16)}`,
    repository,
    number,
    issueId: tracking.issueId,
    identifier: tracking.identifier,
    changes: Object.freeze([Object.freeze({
      kind: to === "open" ? "reopened" : "closed",
      detail: `state:${from}->${to}`,
    })]),
    reopen: false,
    nextLedger,
  });
  if (duplicateDelivered(cardMarkers, digest)) {
    return Object.freeze({ action: "latched", repository, number, swallowed: digest.dedupeKey, nextLedger });
  }
  return digest;
}
