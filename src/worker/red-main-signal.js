// Red-main-signal worker adapter.
//
// Thin glue between the host scheduler and the pure decision core
// (`../decision-core/red-main-signal.js`). All side effects go through
// injected fns, so the offline suite drives every path with fakes: no
// network, no credentials. Alert-only: routes evidence to the open owner
// card or opens one; never reverts, merges, pauses or cancels anything.

import { JOB_KEYS } from "../manifest.js";
import { baseSignal, decide } from "../decision-core/red-main-signal.js";

/**
 * One red-main tick.
 * - `signals`: baseSignal() outputs for the watched repos (host-collected
 *   from the latest completed main-branch runs).
 * - `ownersFor`: `(signal) => owners[]` — candidate DEPLOY RED cards.
 * - `ledger`: already-actioned rows.
 * - `appendEvidence`: `async ({ ownerId, signal }) => void`.
 * - `openCard`: `async (signal) => cardRef`.
 *
 * Green/unknown signals are reported and left alone. Returns `{ outcomes }`.
 */
export async function runRedMainTick({ signals, ownersFor, ledger, appendEvidence, openCard }) {
  if (!Array.isArray(signals)) throw new Error("runRedMainTick: signals must be an array");
  if (typeof ownersFor !== "function") throw new Error("runRedMainTick: ownersFor() is required");
  if (typeof appendEvidence !== "function") throw new Error("runRedMainTick: appendEvidence() is required");
  if (typeof openCard !== "function") throw new Error("runRedMainTick: openCard() is required");
  const outcomes = [];
  for (const signal of signals) {
    if (!signal || signal.status !== "red") {
      outcomes.push({ status: signal?.status ?? "unknown", action: "none" });
      continue;
    }
    const routed = decide({
      observation: {
        repo: signal.repo,
        workflowPath: signal.workflowPath ?? "",
        workflowName: signal.workflowName ?? "",
        runId: signal.runId,
      },
      owners: ownersFor(signal),
      ledger: ledger ?? [],
    });
    if (routed.action === "append") {
      await appendEvidence({ ownerId: routed.ownerId, signal });
      outcomes.push({ status: "red", action: "append", ownerId: routed.ownerId, runId: signal.runId });
    } else if (routed.action === "create") {
      const cardRef = await openCard(signal);
      outcomes.push({ status: "red", action: "create", cardRef, runId: signal.runId });
    } else {
      outcomes.push({ status: "red", action: routed.action, reason: routed.reason, runId: signal.runId });
    }
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}

/** Re-export for hosts that collect the base signal inline. */
export { baseSignal };

/** Register the host-scheduled job. `makeTick` builds the zero-arg tick. */
export function registerRedMainSignalJob(ctx, makeTick) {
  if (!ctx?.jobs?.register) throw new Error("registerRedMainSignalJob: ctx.jobs.register is required");
  if (typeof makeTick !== "function") throw new Error("registerRedMainSignalJob: makeTick() is required");
  ctx.jobs.register(JOB_KEYS.redMainSignal, makeTick);
}
