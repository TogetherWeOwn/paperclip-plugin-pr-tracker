// PR Tracker plugin manifest (staging scaffold).
//
// Validated against `pluginManifestV1Schema` at export time in the public
// repo. This staging copy mirrors the shape so the export is mechanical:
// fill in, validate, ship. Rollback for everything under `plugins/pr-tracker/`
// is delete-the-directory: no core patch, no live wiring.
//
// PHASE GATE: UI slots (`sidebar` / `detailTab` / `dashboardWidget`) land
// with the UI slice, after the slot shape is verified against the live
// plugin SDK. Only the worker (`pollPrs`) is declared here.

export const PLUGIN_ID = "togetherweown.pr-tracker";
export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_API_VERSION = "v1";

export const JOB_KEYS = Object.freeze({
  pollPrs: "pollPrs",
});

/**
 * Worker capabilities. Read-only GitHub access via the existing org App
 * secret refs; no new credentials. `issues.create` is bounded to
 * tracking-card reuse (one card per PR, never duplicates).
 */
export const WORKER_CAPABILITIES = Object.freeze([
  "issues.read",
  "issues.create",
  "issues.wakeup",
  "issue.relations.read",
  "plugin.state.read",
  "plugin.state.write",
  "secrets.read-ref",
  "http.outbound",
  "jobs.schedule",
  "database.namespace.read",
  "activity.log.write",
  "metrics.write",
]);

export const manifest = Object.freeze({
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "PR Tracker",
  description:
    "Watches open pull requests every 2 minutes and wakes the owning task with a precise change digest, plus repeating compliance checks so nothing is forgotten.",
  author: "TogetherWeOwn",
  categories: ["automation"],
  capabilities: [...WORKER_CAPABILITIES],
  entrypoints: { worker: "./dist/worker.js" },
  jobs: [
    {
      jobKey: JOB_KEYS.pollPrs,
      displayName: "Poll pull requests",
      description:
        "Read-only REST collection with ETag conditional requests (304s are free) over owner-authored upstream PRs plus all open org PRs, then feed the decision core. Every 2 minutes so event-to-wake stays within 5 minutes.",
      schedule: "*/2 * * * *",
    },
  ],
});
