// Red-main-signal decision core. Pure: no I/O.
//
// Ports the deterministic contract of the host red-main watch: the
// authoritative base signal comes from the latest completed run on the
// default branch (never from PR checks), incidents route once (append to the
// open owner card with evidence, never a second card), and the core is
// alert-only. The only routing actions are `create`, `append`, `noop` and
// `skip`: there is no revert, no merge, and no queue action anywhere here.

const TITLE_RE = /^DEPLOY RED:\s*([^/\s]+)\/(.+?)\s+failing on main\b/i;
const TERMINAL = new Set(["done", "cancelled"]);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeRepo(value) {
  const text = String(value ?? "").trim().replace(/\/+$/, "");
  const noSuffix = text.toLowerCase().endsWith(".git") ? text.slice(0, -4) : text;
  return noSuffix.split("/").pop().toLowerCase();
}

export function normalizeWorkflow(value) {
  const text = String(value ?? "").trim().replace(/`+/g, "").split("/").pop();
  const low = text.toLowerCase();
  for (const ext of [".yml", ".yaml"]) {
    if (low.endsWith(ext)) return text.slice(0, -ext.length).toLowerCase();
  }
  return low;
}

/**
 * A workflow path wins over the display name; spaces are never turned into
 * hyphens. Returns [repo, workflow].
 */
export function observationIdentity(obs) {
  requireValue(obs && typeof obs === "object", "observation is required");
  const repo = normalizeRepo(obs.repo ?? "");
  const path = String(obs.workflowPath ?? obs.workflow_file ?? "").trim();
  const name = String(obs.workflowName ?? obs.workflow_display ?? "").trim();
  const workflow = path ? normalizeWorkflow(path) : name ? normalizeWorkflow(name) : "";
  return Object.freeze([repo, workflow]);
}

function ownerIdentity(issue) {
  const m = TITLE_RE.exec(String(issue?.title ?? "").trim());
  if (!m) return null;
  const repo = normalizeRepo(m[1]);
  const key = normalizeWorkflow(m[2]);
  if (!repo || !key) return null;
  return Object.freeze([repo, new Set([key])]);
}

function ledgerHit(ledger, repo, workflow, runId) {
  return (ledger ?? []).some(
    (e) =>
      normalizeRepo(e.repo) === repo &&
      normalizeWorkflow(e.workflow) === workflow &&
      String(e.run_id ?? e.runId ?? "") === String(runId),
  );
}

function sortKey(issue) {
  return `${issue.created_at ?? ""}|${String(issue.id ?? "")}`;
}

/**
 * Route one red observation. `owners` are candidate DEPLOY RED cards with
 * `evidenceRunIds`; `ledger` holds already-actioned (repo, workflow, run_id)
 * rows. Never creates without a full workflow identity: a signal that cannot
 * be matched to exactly one (repo, workflow) returns `skip` so callers open
 * nothing; callers also pass `skip` through when the owner read failed.
 */
export function decide({ observation, owners, ledger }) {
  requireValue(observation && typeof observation === "object", "observation is required");
  const [repo, workflow] = observationIdentity(observation);
  const runId = String(observation.runId ?? observation.run_id ?? "");
  if (!repo || !workflow || !runId) {
    return Object.freeze({ action: "skip", ownerId: null, reason: "no-workflow-identity" });
  }
  if (ledgerHit(ledger ?? [], repo, workflow, runId)) {
    return Object.freeze({ action: "noop", ownerId: null, reason: "run-already-actioned" });
  }
  const matches = [];
  for (const issue of owners ?? []) {
    if (issue?.hidden) continue;
    const ident = ownerIdentity(issue);
    if (ident && ident[0] === repo && ident[1].has(workflow)) matches.push(issue);
  }
  const marked = matches.filter((i) => new Set((i.evidenceRunIds ?? []).map(String)).has(runId));
  if (marked.length) {
    const first = [...marked].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))[0];
    return Object.freeze({ action: "noop", ownerId: first.id, reason: "evidence-already-on-owner" });
  }
  const open = matches.filter((i) => !TERMINAL.has(String(i.status ?? "").trim().toLowerCase()));
  if (open.length) {
    const first = [...open].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))[0];
    return Object.freeze({ action: "append", ownerId: first.id, reason: "open-deploy-red" });
  }
  return Object.freeze({ action: "create", ownerId: null, reason: "no-open-owner" });
}

function runWorkflowPath(run) {
  return String(run.workflowPath ?? run.workflow_path ?? run.path ?? "").trim();
}

function runWorkflowName(run) {
  return String(run.workflowName ?? run.workflow_display ?? run.workflow ?? run.name ?? "").trim();
}

function isUsableRun(r) {
  if (!r) return false;
  // Only finished runs decide: queued/in_progress (conclusion null) must not
  // shadow an older completed red/green. Runs without a status field (offline
  // fixtures) are treated as completed.
  if (r.status != null && r.status !== "completed") return false;
  if (r.conclusion == null || r.conclusion === "cancelled") return false;
  return true;
}

/**
 * Authoritative base signal from main-branch runs: the newest completed,
 * non-cancelled run decides. Cancelled (concurrency-superseded) runs,
 * still-running runs, and an empty set are not a signal (`unknown`), never
 * green and never red. The signal carries the deciding run's workflow
 * identity (`workflowPath`/`workflowName`) so `decide()` can route it to the
 * one matching owner card instead of opening a duplicate.
 */
export function baseSignal({ repo, branch, runs }) {
  requireValue(typeof repo === "string" && repo.length > 0, "repo is required");
  requireValue(typeof branch === "string" && branch.length > 0, "branch is required");
  requireValue(Array.isArray(runs), "runs must be an array");
  const usable = runs.filter(isUsableRun);
  if (!usable.length) {
    return Object.freeze({ repo, branch, status: "unknown", reason: "no-completed-runs" });
  }
  const latest = usable.reduce((a, b) => (String(b.updatedAt ?? b.updated_at ?? "") > String(a.updatedAt ?? a.updated_at ?? "") ? b : a));
  const conclusion = latest.conclusion;
  const workflowPath = runWorkflowPath(latest);
  const workflowName = runWorkflowName(latest);
  if (conclusion === "success" || conclusion === "skipped" || conclusion === "neutral") {
    return Object.freeze({ repo, branch, status: "green", runId: latest.id ?? null, workflowPath, workflowName });
  }
  // Startup failures and stale runs also failed to establish a healthy main.
  if (["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(conclusion)) {
    return Object.freeze({
      repo,
      branch,
      status: "red",
      runId: latest.id ?? null,
      workflowPath,
      workflowName,
      firstRedSha: latest.headSha ?? latest.head_sha ?? null,
      firstRedAt: latest.updatedAt ?? latest.updated_at ?? null,
      runUrl: latest.url ?? latest.html_url ?? null,
    });
  }
  return Object.freeze({ repo, branch, status: "unknown", reason: `conclusion:${conclusion}` });
}

/** Minutes from first red to now; -1 when the timestamp is unusable. */
export function timeToGreenMin({ firstRedAt, nowMs }) {
  requireValue(Number.isInteger(nowMs) && nowMs >= 0, "nowMs is invalid");
  const t0 = Date.parse(String(firstRedAt ?? ""));
  if (Number.isNaN(t0)) return -1;
  return Math.round((nowMs - t0) / 60000 * 10) / 10;
}
