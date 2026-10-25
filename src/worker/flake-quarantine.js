// Flaky-quarantine worker adapter.
//
// Thin glue between the host scheduler and the pure decision core
// (`../decision-core/flake-quarantine.js`). All side effects go through
// injected fns, so the offline suite drives every path with fakes: no
// network, no credentials. The host owns the schedule (manifest `jobs[]`)
// and persistence; this module never blocks a PR — the core has no `block`
// action and nothing here invents one.

import { JOB_KEYS } from "../manifest.js";
import { decideQuarantine } from "../decision-core/flake-quarantine.js";

/**
 * One quarantine tick.
 * - `ledger`: `{ flakes }` ledger object (host-loaded).
 * - `failures`: `[{ repo, workflow, job, tests, evidenceUrl }]` from the
 *   attempt-1 failure reads.
 * - `applyLabel`: `async (decision) => cardRef` — host labels the flaky
 *   test / opens-or-updates the quarantine card with the evidence link.
 *
 * Returns `{ decisions, applied }`. Unproven tests return `none` and are
 * never passed to `applyLabel`.
 */
export async function runQuarantineTick({ ledger, failures, applyLabel }) {
  if (!ledger || typeof ledger !== "object") throw new Error("runQuarantineTick: ledger is required");
  if (!Array.isArray(failures)) throw new Error("runQuarantineTick: failures must be an array");
  if (typeof applyLabel !== "function") throw new Error("runQuarantineTick: applyLabel() is required");
  const decisions = [];
  const applied = [];
  for (const f of failures) {
    const decided = decideQuarantine({
      ledger,
      repo: f.repo,
      workflow: f.workflow,
      job: f.job,
      tests: f.tests ?? [],
      evidenceUrl: f.evidenceUrl,
    });
    for (const d of decided) {
      decisions.push(d);
      if (d.action === "label") {
        const cardRef = await applyLabel(d);
        applied.push({ key: d.key, cardRef });
      }
    }
  }
  return Object.freeze({ decisions: Object.freeze(decisions), applied: Object.freeze(applied) });
}

/** Register the host-scheduled job. `makeTick` builds the zero-arg tick. */
export function registerFlakyQuarantineJob(ctx, makeTick) {
  if (!ctx?.jobs?.register) throw new Error("registerFlakyQuarantineJob: ctx.jobs.register is required");
  if (typeof makeTick !== "function") throw new Error("registerFlakyQuarantineJob: makeTick() is required");
  ctx.jobs.register(JOB_KEYS.flakyQuarantine, makeTick);
}
