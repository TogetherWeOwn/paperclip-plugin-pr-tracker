// `pollPrs` collector skeleton (staging scaffold).
//
// Pure, dependency-free orchestration around the decision core
// (`../decision-core/upstream-watcher.js`). All I/O enters through injected
// callbacks, so the offline suite drives every path with fakes: no network,
// no board credentials.
//
// COLLECTION CONTRACT. The worker (not this module) performs read-only REST
// conditional requests with ETag (304s are free) for PR/issues/comments/
// check-runs. GraphQL POST has no ETag support — it is not used. Every page
// must be validated before it reaches `decideUpstreamWatch`: a failed,
// rate-limited or partial read resolves to `unknown`, never to `silent`.
//
// ORPHANED-JOB TRAP. The host removes schedules on plugin disable, and the
// worker ALSO self-checks the enabled flag on every tick (`shouldRunTick`):
// a tick that fires while disabled returns `stopped-disabled` and performs
// zero reads and zero wakes.
//
// ESCALATION LADDER (worker-side, outcomes recorded by the caller):
// immediate wake on digest -> 12h re-wake plus CEO desk -> 24h red
// `upstream-pr-compliance` signal plus owner-report line. The decision core
// only reports single-tick outcomes; the ladder state lives in `plugin.state`
// (ack signatures + SLA latches), never in the core.
//
// TYPED REFS. A read for an explicit subscription carries its lifecycle; the
// ledger (`../decision-core/ref-ledger.js`) decides retirement from that
// lifecycle and the ref's policy. `unknown` outcomes never touch the ledger.

import { decideUpstreamWatch } from "../decision-core/upstream-watcher.js";
import { decideIssueLifecycle, decideLedger } from "../decision-core/ref-ledger.js";

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** Compliance policy: 4h response / 4h red-CI / 7d maintainer-silence, 12h re-wake, 24h red signal. */
export const POLICY = Object.freeze({
  pollInterval: "*/2 * * * *",
  responseSlaMs: 4 * HOUR_MS,
  redCiSlaMs: 4 * HOUR_MS,
  silencePingMs: 7 * DAY_MS,
  rewakeMs: 12 * HOUR_MS,
  gatusRedMs: 24 * HOUR_MS,
});

/** Retry bounds for throttled reads: bounded exponential backoff with jitter. */
export const RETRY = Object.freeze({
  baseMs: 1_000,
  maxMs: 60_000,
});

/**
 * Normalize the two intake scopes and drop overlaps: an org repo that also
 * appears in the upstream list is collected once, as org kind.
 */
export function scopeTargets({ upstreamRepos = [], orgRepos = [] } = {}) {
  const org = [...new Set(orgRepos.filter(Boolean))].sort();
  const orgSet = new Set(org);
  const upstream = [...new Set(upstreamRepos.filter(Boolean))]
    .filter((r) => !orgSet.has(r))
    .sort();
  return { upstream, org };
}

/** Build conditional-request headers from a stored ETag. Absent ETag: full read. */
export function etagHeaders({ etag } = {}) {
  if (!etag) return {};
  return { "If-None-Match": etag };
}

/**
 * Classify a collection HTTP status into a fixed vocabulary the tick loop
 * acts on. 401/403 stops the source (never substitute credentials — block
 * and report instead); 429/5xx retries with backoff; everything else
 * unexpected resolves to `unknown` upstream, never to `silent`.
 */
export function classifyHttpStatus(status) {
  if (status === 200) return "fresh";
  if (status === 304) return "not-modified";
  if (status === 401 || status === 403) return "stop-source";
  if (status === 429 || (status >= 500 && status <= 599)) return "retry";
  return "unknown";
}

/** Bounded exponential backoff with jitter. `rand` is injectable for tests. */
export function backoffWithJitter(attempt, rand = Math.random) {
  const safe = Math.max(0, Math.floor(attempt));
  const grown = RETRY.baseMs * 2 ** Math.min(safe, 6);
  const capped = Math.min(grown, RETRY.maxMs);
  return Math.floor(capped * (0.5 + rand() * 0.5));
}

/**
 * Worker SLA overrides. The core defaults stay 24h/24h/7d; the worker passes
 * 4h/4h/7d per the compliance spec. The 12h re-wake and 24h red signal live
 * in the worker ladder, not the core.
 */
/** Orphaned-job guard: a disabled plugin performs zero reads and zero wakes. */
export function shouldRunTick({ pluginEnabled }) {
  return pluginEnabled === true;
}

/**
 * Worker SLA overrides. The core defaults stay 24h/24h/7d; the worker passes
 * 4h/4h/7d per the compliance spec. The 12h re-wake and 24h red signal live
 * in the worker ladder, not the core.
 */
export function workerPolicy() {
  return {
    responseSlaMs: POLICY.responseSlaMs,
    redCiSlaMs: POLICY.redCiSlaMs,
    silencePingMs: POLICY.silencePingMs,
  };
}

function ledgerOf(entry, nextLedger) {
  return nextLedger ? { ...entry, ledger: nextLedger } : entry;
}

function hasTrackingIdentity(tracking) {
  return typeof tracking.issueId === "string" && tracking.issueId.length > 0
    && typeof tracking.identifier === "string" && tracking.identifier.length > 0;
}

/**
 * Run one `pollPrs` tick.
 *
 * @param {object} args
 * @param {boolean} args.pluginEnabled - live enabled flag; false stops everything.
 * @param {object} args.scope - result of `scopeTargets()`.
 * @param {object|null} [args.subscriptions] - normalized typed refs, passed to `collect`.
 * @param {Map|object} [args.etags] - stored per-resource ETags (conditional reads).
 * @param {object} [args.acks] - persisted per-PR ack signatures + SLA latches.
 * @param {object} [args.ledgers] - persisted per-typed-ref ledger records.
 * @param {object} [args.refs] - normalized subscription refs keyed by `repo#number`.
 * @param {object} [args.cardMarkers] - tracking-task writer markers per PR, for ack-loss convergence.
 * @param {number} [args.nowMs] - collector clock for ledger history.
 * @param {Function} args.collect - `async ({scope, etags, subscriptions}) => [{key, status, input?, lifecycle?, tracking?, etag?}]`,
 *   where each fresh read's `input` is the collector-built decision-core input
 *   `{ prev, next, tracking, nowMs }` (policy and cardMarkers are injected here).
 * @param {Function} [args.deliver] - `async (decision) => {delivered: boolean}`;
 *   the caller persists `nextAck` and `ledger` only when delivery is durable.
 * @param {Function} [args.decide] - defaults to `decideUpstreamWatch`; injectable for tests.
 */
export async function runPollTick({
  pluginEnabled,
  scope,
  subscriptions = null,
  etags = {},
  acks = {},
  ledgers = {},
  refs = {},
  cardMarkers = {},
  nowMs = Date.now(),
  collect,
  deliver = async () => ({ delivered: true }),
  decide = decideUpstreamWatch,
}) {
  if (!shouldRunTick({ pluginEnabled })) {
    return { outcome: "stopped-disabled", reads: 0, wakes: 0, results: [] };
  }
  if (typeof collect !== "function") {
    throw new Error("runPollTick: collect() is required");
  }
  const policy = workerPolicy();
  const reads = await collect({ scope, etags, subscriptions });
  const results = [];
  let wakes = 0;
  for (const read of reads) {
    const classification = classifyHttpStatus(read.status);
    if (classification === "not-modified") {
      results.push({ key: read.key, outcome: "silent", via: "etag-304" });
      continue;
    }
    if (classification !== "fresh") {
      results.push({ key: read.key, outcome: "unknown", via: classification });
      continue;
    }
    const ref = refs[read.key] ?? null;
    const prevLedger = ledgers[read.key] ?? null;
    const markers = cardMarkers[read.key] ?? [];
    const lifecycleLedger = (lifecycle) => decideLedger({
      policy: ref.retireLedgerWhen,
      equivalence: ref.equivalence,
      prev: prevLedger,
      lifecycle,
      atMs: nowMs,
    });

    if (read.lifecycle?.kind === "issue") {
      if (!ref) throw new Error(`runPollTick: issue read ${read.key} has no subscription ref`);
      const issueLedger = lifecycleLedger(read.lifecycle);
      const tracking = read.tracking ?? null;
      if (tracking !== null && !hasTrackingIdentity(tracking)) {
        results.push({ key: read.key, outcome: "unknown", via: "invalid-tracking" });
        continue;
      }
      const decided = decideIssueLifecycle({
        prevLedger,
        nextLedger: issueLedger,
        tracking,
        repository: ref.repository,
        number: ref.number,
        cardMarkers: markers,
      });
      if (decided.action === "digest") {
        const delivery = await deliver(decided);
        if (delivery && delivery.delivered === true) {
          wakes += 1;
          results.push(ledgerOf({ key: read.key, outcome: "digest", delivered: true }, issueLedger));
        } else {
          results.push({ key: read.key, outcome: "digest", delivered: false });
        }
        continue;
      }
      results.push(ledgerOf({ key: read.key, outcome: decided.action }, issueLedger));
      continue;
    }

    const nextLedger = ref && read.lifecycle ? lifecycleLedger(read.lifecycle) : null;
    // Post-terminal noise on a retired ref stays silent; a lifecycle transition still digests once.
    const postTerminalNoise = nextLedger !== null
      && prevLedger?.state === "retired"
      && nextLedger.state === "retired"
      && nextLedger.lifecycle.terminal !== "open"
      && prevLedger.lifecycle.terminal === nextLedger.lifecycle.terminal;
    const decided = postTerminalNoise
      ? { action: "silent" }
      : decide({
        ...read.input,
        prev: acks[read.key] ?? read.input.prev ?? null,
        policy,
        cardMarkers: markers,
      });
    const persistedLedger = decided.action === "unknown" ? null : nextLedger;
    if (decided.action === "digest") {
      const delivery = await deliver(decided);
      if (delivery && delivery.delivered === true) {
        wakes += 1;
        const entry = { key: read.key, outcome: "digest", delivered: true };
        if (decided.nextAck !== undefined) entry.ack = decided.nextAck;
        results.push(ledgerOf(entry, persistedLedger));
      } else {
        results.push({ key: read.key, outcome: "digest", delivered: false });
      }
      continue;
    }
    // silent: zero wakes, ack untouched. baseline / latched: zero wakes,
    // persist nextAck. unknown / untracked: diagnostics, zero wakes.
    const entry = { key: read.key, outcome: decided.action };
    if (decided.nextAck !== undefined) entry.ack = decided.nextAck;
    if (decided.detail !== undefined) entry.detail = decided.detail;
    results.push(ledgerOf(entry, persistedLedger));
  }
  return { outcome: "tick-complete", reads: reads.length, wakes, results };
}
