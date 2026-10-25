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
 * Returns `{ decisions, applied, errors }`. Unproven tests return `none`
 * and are never passed to `applyLabel`. Validation and label failures are
 * recorded by failureIndex (and decision key for label failures). A failed
 * label is not recorded as applied and never prevents later tests/entries.
 */
export async function runQuarantineTick({ ledger, failures, applyLabel }) {
  if (!ledger || typeof ledger !== "object") throw new Error("runQuarantineTick: ledger is required");
  if (!Array.isArray(failures)) throw new Error("runQuarantineTick: failures must be an array");
  if (typeof applyLabel !== "function") throw new Error("runQuarantineTick: applyLabel() is required");
  const decisions = [];
  const applied = [];
  const errors = [];
  for (const [failureIndex, f] of failures.entries()) {
    let decided;
    try {
      decided = decideQuarantine({
        ledger,
        repo: f.repo,
        workflow: f.workflow,
        job: f.job,
        tests: f.tests ?? [],
        evidenceUrl: f.evidenceUrl,
      });
    } catch (error) {
      errors.push({ failureIndex, stage: "decision", error: String(error?.message ?? error) });
      continue;
    }
    for (const d of decided) {
      decisions.push(d);
      if (d.action === "label") {
        try {
          const cardRef = await applyLabel(d);
          applied.push({ key: d.key, cardRef });
        } catch (error) {
          errors.push({ failureIndex, stage: "apply-label", key: d.key, error: String(error?.message ?? error) });
        }
      }
    }
  }
  return Object.freeze({
    decisions: Object.freeze(decisions),
    applied: Object.freeze(applied),
    errors: Object.freeze(errors),
  });
}

/** Register the host-scheduled job. `makeTick` builds the zero-arg tick. */
export function registerFlakyQuarantineJob(ctx, makeTick) {
  if (!ctx?.jobs?.register) throw new Error("registerFlakyQuarantineJob: ctx.jobs.register is required");
  if (typeof makeTick !== "function") throw new Error("registerFlakyQuarantineJob: makeTick() is required");
  ctx.jobs.register(JOB_KEYS.flakyQuarantine, makeTick);
}
