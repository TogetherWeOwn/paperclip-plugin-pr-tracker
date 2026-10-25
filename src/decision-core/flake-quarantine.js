// Flaky-quarantine decision core. Pure: no I/O.
//
// Ports the deterministic contract of the host flake ledger: parse failed
// test names from an attempt-1 job log, keep a flip-rate ledger per
// `repo|workflow|job|test` key, and quarantine-and-label only proven flakes.
// The triage ladder is unchanged: a red check reruns once only when the
// ledger says flaky (flip-rate > 0.2 over >= 5 runs); anything else is real
// and gets fixed. An unproven label never blocks a PR: the only actions this
// core returns are `label` (proven, with an evidence link for the doer) and
// `none` (unproven, with the reason). There is no `block` action.

const ANSI = /\u001b\[[0-9;]*m/g;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const MAX_TESTS = 20;

const TEST_PATTERNS = [
  /^test (\S+) \.\.\. FAILED$/, // cargo test
  /^\s*FAIL \[\s*[\d.]+s\]\s+(?:\(\d+\/\d+\)\s+)?(\S+(?: \S+)?)$/, // cargo nextest
  /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx? > .+?)\s*(?:\d+ms)?$/, // vitest
  /^(?:FAIL|ERROR): (test\w+) \(([\w.]+)\)/, // python unittest
  /^\s*not ok \d+ - (.+)$/, // node --test (TAP)
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Test names that failed in a job log (ANSI and timestamps stripped).
 * Empty when no test name can be parsed; callers then fall back to the job
 * name. At most 20 names.
 */
export function parseFailedTests(logText) {
  requireValue(typeof logText === "string", "logText is required");
  const found = [];
  for (const raw of logText.split("\n")) {
    const line = raw.replace(ANSI, "").replace(STAMP, "").trimEnd();
    for (const pattern of TEST_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        const name = m.length === 3 ? `${m[2]}.${m[1]}` : m[1];
        if (!found.includes(name.trim())) found.push(name.trim());
        break;
      }
    }
    if (found.length >= MAX_TESTS) break;
  }
  return Object.freeze(found.slice(0, MAX_TESTS));
}

/** Ledger key for one run's attempt-1 failures: repo|workflow|job|test. */
export function ledgerKey({ repo, workflow, job, test }) {
  requireValue(repo && workflow && job !== undefined && test, "repo, workflow, job and test are required");
  return `${repo}|${workflow}|${job}|${test}`;
}

export function flipRate(flake) {
  const obs = flake?.observations ?? 0;
  if (!obs) return 0;
  return (flake?.flips ?? 0) / obs;
}

function normRepoShort(repo) {
  return String(repo ?? "").trim().toLowerCase().split("/").pop();
}

/**
 * Deterministic yes/no for the triage ladder: is <job/test> for <repo> in
 * the ledger with flip-rate > 0.2 over >= 5 runs? Reads the ledger object
 * directly, so it answers for ANY repo. Returns { flaky, detail }.
 */
export function isFlaky(ledger, repo, needle) {
  requireValue(ledger && typeof ledger === "object", "ledger is required");
  const repoL = normRepoShort(repo);
  const needleL = String(needle ?? "").toLowerCase();
  const cands = [];
  for (const [fkey, flake] of Object.entries(ledger.flakes ?? {})) {
    const parts = fkey.split("|");
    if (parts.length !== 4 || parts[0].toLowerCase() !== repoL) continue;
    if (needleL !== fkey.toLowerCase() && !`${parts[2]}\n${parts[3]}`.toLowerCase().includes(needleL)) continue;
    const obs = flake.observations ?? 0;
    cands.push({
      key: fkey,
      observations: obs,
      flips: flake.flips ?? 0,
      rate: Math.round(flipRate(flake) * 1000) / 1000,
      card: flake.card ?? null,
      flaky: obs >= 5 && flipRate(flake) > 0.2,
    });
  }
  if (!cands.length) {
    return Object.freeze({
      flaky: false,
      detail: Object.freeze({ repo: repoL, query: needle, match: null, reason: "not in ledger: treat red as real and fix it" }),
    });
  }
  const best = cands.reduce((a, b) => (b.observations > a.observations ? b : a));
  return Object.freeze({
    flaky: best.flaky,
    detail: Object.freeze({ repo: repoL, query: needle, alternatives: cands.length - 1, ...best }),
  });
}

export const QUARANTINE_LABEL = "flaky-quarantine";

/**
 * One decision per failing test: `label` when the ledger proves the flake
 * (with the evidence URL the doer needs), otherwise `none`. Never `block`:
 * no PR is held up by an unproven label.
 */
export function decideQuarantine({ ledger, repo, workflow, job, tests, evidenceUrl }) {
  requireValue(ledger && typeof ledger === "object", "ledger is required");
  requireValue(repo && workflow && job, "repo, workflow and job are required");
  requireValue(Array.isArray(tests), "tests must be an array");
  requireValue(typeof evidenceUrl === "string" && evidenceUrl.length > 0, "evidenceUrl is required");
  return Object.freeze(
    tests.map((name) => {
      // Fuzzy isFlaky() queries are for human triage, never label authority.
      const key = ledgerKey({ repo: normRepoShort(repo), workflow, job, test: name });
      const flakes = ledger.flakes ?? {};
      const proof = Object.hasOwn(flakes, key) ? flakes[key] : null;
      const observations = proof?.observations ?? 0;
      const rate = flipRate(proof);
      if (observations >= 5 && rate > 0.2) {
        return Object.freeze({
          action: "label",
          label: QUARANTINE_LABEL,
          key,
          evidenceUrl,
          note: `proven flake: ${observations} obs, flip-rate ${Math.round(rate * 1000) / 1000}`,
        });
      }
      return Object.freeze({
        action: "none",
        key,
        evidenceUrl,
        reason: proof == null ? "not in ledger: treat red as real and fix it" : "unproven: below the ladder bar",
      });
    }),
  );
}

/**
 * Weekly report with denominators. Inputs are caller-supplied counts; the
 * report commits every denominator so the trend (reruns per merged PR with
 * n, red rate with window) is auditable.
 */
export function weeklyReport({ ledger, reruns, mergedPRs, redRate }) {
  requireValue(ledger && typeof ledger === "object", "ledger is required");
  requireValue(Number.isInteger(reruns) && reruns >= 0, "reruns is invalid");
  requireValue(Number.isInteger(mergedPRs) && mergedPRs >= 0, "mergedPRs is invalid");
  requireValue(redRate && Number.isInteger(redRate.red) && Number.isInteger(redRate.total), "redRate is invalid");
  const entries = Object.entries(ledger.flakes ?? {}).map(([key, flake]) => {
    const obs = flake.observations ?? 0;
    return Object.freeze({
      key,
      observations: obs,
      flips: flake.flips ?? 0,
      rate: Math.round(flipRate(flake) * 1000) / 1000,
      card: flake.card ?? null,
    });
  });
  entries.sort((a, b) => b.observations - a.observations);
  return Object.freeze({
    keys: entries.length,
    entries: Object.freeze(entries),
    rerunsPerMergedPR: Object.freeze({
      value: mergedPRs === 0 ? 0 : Math.round((reruns / mergedPRs) * 1000) / 1000,
      reruns,
      n: mergedPRs,
    }),
    redRate: Object.freeze({
      value: redRate.total === 0 ? 0 : Math.round((redRate.red / redRate.total) * 1000) / 1000,
      red: redRate.red,
      total: redRate.total,
      windowDays: redRate.windowDays ?? 7,
    }),
  });
}
