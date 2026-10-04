// PR Tracker worker setup (staging scaffold).
//
// Thin adapter between the plugin host context and the pure decision stack
// (`poll-prs.js` + `upstream-watcher.js` + UI view-model). All host calls go
// through the injected `ctx`, so the offline suite drives every path with
// fakes: no network, no board credentials.
//
// Verified host surface (from the live SDK spec):
// - `ctx.jobs.register(key, fn)` — schedules come from manifest `jobs[]`.
// - `ctx.issues.requestWakeup(issueId, companyId, { reason?, contextSource?,
//   idempotencyKey? })`.
// - `ctx.secrets.resolve(ref, { companyId, configPath })` — `ref` is
//   `{ type: "secret_ref", secretId, version? }`; the token stays in memory.
// - `ctx.state.get/set({ scopeKind, scopeId, stateKey, namespace? })`.
//   Only new state lives here: per-PR ack signatures + SLA latches, stored
//   ETags, and tracking entries. Review verdicts stay in the native tables.
//
// REST collection (`collect`) is caller-provided and must honor the core
// contract: failed/partial reads resolve to `unknown`, never `silent`.
// Ack and ETag persistence happens ONLY after durable delivery.

import {
  decideUpstreamWatch,
  renderWriterProposal,
  writerMarkerForDigest,
} from "../decision-core/upstream-watcher.js";
import { runPollTick, shouldRunTick } from "./poll-prs.js";
import {
  applyFilters,
  defaultFilter,
  toRow,
  widgetCounts,
} from "../ui/view-model.js";
import { JOB_KEYS, PLUGIN_ID } from "../manifest.js";

export const STATE_KEY = "poll-state";
export const STATE_NAMESPACE = "pr-tracker";
export const WAKE_REASON = "pr-change";

/**
 * Wire the worker. Options:
 * - `companyId`, `configPath`: host scoping for secrets/wakeups.
 * - `secretRef`: `{ type: "secret_ref", secretId, version? }` for the
 *   read-only org GitHub App. The token is used as a Bearer header only.
 * - `scope`: result of `scopeTargets()` (repos to watch).
 * - `collect`: `async ({ scope, etags, token }) => reads` (REST layer).
 * - `enabledProbe`: `async () => boolean`; false stops the tick silently.
 * - `namespace`, `stateKey`: state addressing overrides (tests).
 */
export function setup(ctx, options = {}) {
  const {
    companyId,
    configPath,
    secretRef,
    scope,
    collect,
    enabledProbe = async () => true,
    namespace = STATE_NAMESPACE,
    stateKey = STATE_KEY,
  } = options;
  if (!companyId) throw new Error("setup: companyId is required");
  if (!secretRef) throw new Error("setup: secretRef is required");
  if (typeof collect !== "function") throw new Error("setup: collect() is required");

  const stateAddr = {
    scopeKind: "plugin",
    scopeId: PLUGIN_ID,
    stateKey,
    namespace,
  };

  async function loadPollState() {
    const stored = await ctx.state.get(stateAddr);
    if (!stored || typeof stored !== "object") {
      return { etags: {}, acks: {}, tracking: {} };
    }
    return {
      etags: stored.etags ?? {},
      acks: stored.acks ?? {},
      tracking: stored.tracking ?? {},
    };
  }

  async function savePollState(next) {
    await ctx.state.set({ ...stateAddr, state: next });
  }

  /** Deliver one digest: wake the tracking task, exactly once. */
  async function deliver(decided) {
    const proposal = renderWriterProposal(decided);
    const marker = writerMarkerForDigest(decided);
    const res = await ctx.issues.requestWakeup(proposal.issueId, companyId, {
      reason: WAKE_REASON,
      contextSource: proposal.sourceId,
      idempotencyKey: marker,
    });
    return { delivered: res !== false };
  }

  async function tick() {
    if (!(await enabledProbe())) {
      return { outcome: "stopped-disabled", reads: 0, wakes: 0, results: [] };
    }
    const { etags, acks, tracking } = await loadPollState();
    const freshEtags = { ...etags };
    const wrappedCollect = async (args) => {
      const reads = await collect({ ...args, token: tick.token });
      for (const read of reads) {
        if (read.etag !== undefined) freshEtags[read.key] = read.etag;
        if (read.input?.tracking !== undefined) {
          tracking[read.key] = read.input.tracking;
        }
      }
      return reads;
    };
    if (!tick.token) {
      tick.token = await ctx.secrets.resolve(secretRef, { companyId, configPath });
    }
    const out = await runPollTick({
      pluginEnabled: shouldRunTick({ pluginEnabled: true }),
      scope,
      etags,
      acks,
      collect: wrappedCollect,
      deliver,
      decide: decideUpstreamWatch,
    });
    const nextAcks = { ...acks };
    for (const r of out.results) {
      if (r.ack !== undefined && r.delivered !== false) nextAcks[r.key] = r.ack;
    }
    await savePollState({ etags: freshEtags, acks: nextAcks, tracking });
    return out;
  }

  /** Sidebar/table reads: rows + counts for the current filter. */
  async function getData({ filter = defaultFilter(), nowMs = Date.now() } = {}) {
    const { acks, tracking } = await loadPollState();
    const records = Object.keys(tracking).map((key) => ({
      repo: tracking[key].repository,
      number: tracking[key].number,
      title: tracking[key].title ?? `#${tracking[key].number}`,
      prUrl: tracking[key].prUrl ?? null,
      kind: tracking[key].kind ?? "org",
      status: tracking[key].uiStatus ?? "ours-to-do",
      greptile: tracking[key].greptile ?? null,
      ciSummary: tracking[key].ciSummary ?? "",
      openThreads: tracking[key].openThreads ?? 0,
      uncheckedBoxes: tracking[key].uncheckedBoxes ?? 0,
      lastActivityMs: acks[key]?.snapshot?.fetchedAtMs ?? null,
      taskId: tracking[key].issueId ?? null,
      owner: tracking[key].owner ?? null,
      openedAtMs: tracking[key].openedAtMs ?? nowMs,
    }));
    const rows = applyFilters(records, filter).map((r) => toRow(r, nowMs));
    return { rows, counts: widgetCounts(records), totalCount: rows.length };
  }

  /** Manual "wake now" from the UI for one tracked PR. */
  async function performAction({ action, key, reason = "manual-wake" } = {}) {
    if (action !== "wake") throw new Error(`performAction: unknown action ${action}`);
    const { tracking } = await loadPollState();
    const entry = tracking[key];
    if (!entry) throw new Error(`performAction: unknown PR key ${key}`);
    await ctx.issues.requestWakeup(entry.issueId, companyId, {
      reason,
      contextSource: key,
      idempotencyKey: `manual:${key}:${reason}`,
    });
    return { ok: true };
  }

  ctx.jobs.register(JOB_KEYS.pollPrs, tick);
  return { tick, getData, performAction, deliver };
}
