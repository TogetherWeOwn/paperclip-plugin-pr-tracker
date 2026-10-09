// Typed upstream-ref subscriptions: an explicit, validated list of
// (repository, kind, number) refs that the collector fetches by number,
// regardless of author or open-intake filters. Pure: no I/O.

export const REF_KINDS = Object.freeze(["pull_request", "issue"]);
export const RETIRE_POLICIES = Object.freeze(["merged_or_closed", "equivalent_fix_verified"]);

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function refKey(repository, number) {
  return `${repository}#${number}`;
}

function normalizeRef(raw, repository) {
  requireValue(raw && typeof raw === "object" && !Array.isArray(raw), "subscription ref must be an object");
  requireValue(raw.repository === undefined || raw.repository === repository, "subscription ref repository must match the registry");
  requireValue(REF_KINDS.includes(raw.kind), "subscription ref kind is invalid");
  requireValue(Number.isSafeInteger(raw.number) && raw.number > 0, "subscription ref number is invalid");
  requireValue(RETIRE_POLICIES.includes(raw.retireLedgerWhen), "subscription ref retire policy is invalid");
  requireValue(typeof raw.role === "string" && raw.role.length > 0, "subscription ref role is required");
  const equivalence = raw.equivalence ?? null;
  if (equivalence !== null) {
    requireValue(equivalence && typeof equivalence === "object", "subscription ref equivalence is invalid");
    requireValue(["reviewed_code", "rebase"].includes(equivalence.kind), "equivalence kind is invalid");
    requireValue(typeof equivalence.sha === "string" && SHA40.test(equivalence.sha), "equivalence sha is invalid");
  }
  return Object.freeze({
    repository,
    kind: raw.kind,
    number: raw.number,
    role: raw.role,
    retireLedgerWhen: raw.retireLedgerWhen,
    equivalence: equivalence === null ? null : Object.freeze({ ...equivalence }),
    key: refKey(repository, raw.number),
  });
}

/**
 * Validate a typed-ref registry and freeze its normalized form. Throws on any
 * malformed input: a silently dropped ref would look like a clean subscription.
 * Duplicate (repository, kind, number) entries and excluded numbers are refused.
 */
export function normalizeSubscriptions(registry) {
  requireValue(registry && typeof registry === "object" && !Array.isArray(registry), "registry is required");
  requireValue(registry.schemaVersion === 1, "registry schemaVersion must be 1");
  requireValue(typeof registry.repository === "string" && REPOSITORY.test(registry.repository),
    "registry repository is invalid");
  requireValue(Array.isArray(registry.refs), "registry refs must be an array");
  requireValue(Array.isArray(registry.excludedNumbers), "registry excludedNumbers must be an array");
  const excluded = new Set(registry.excludedNumbers.map((n) => {
    requireValue(Number.isSafeInteger(n) && n > 0, "excluded number is invalid");
    return n;
  }));
  const seen = new Set();
  const refs = registry.refs.map((raw) => {
    const ref = normalizeRef(raw, registry.repository);
    requireValue(!excluded.has(ref.number), `ref ${ref.number} is in the exclusion list`);
    requireValue(!seen.has(ref.key), `duplicate subscription ref ${ref.key}`);
    seen.add(ref.key);
    return ref;
  });
  return Object.freeze({
    repository: registry.repository,
    releaseLine: registry.releaseLine ?? null,
    refs: Object.freeze(refs),
    excludedNumbers: Object.freeze([...excluded].sort((a, b) => a - b)),
  });
}

/** True when a discovered PR/issue number is excluded by the registry. */
export function isExcluded(subscriptions, repository, number) {
  return subscriptions.repository.toLowerCase() === repository.toLowerCase()
    && subscriptions.excludedNumbers.includes(number);
}

/**
 * Discovered items that the explicit subscriptions already cover are dropped
 * from discovery so each ref is read exactly once per tick; excluded numbers
 * never reach the collector at all.
 */
export function discoveryFilter(subscriptions) {
  if (!subscriptions) return () => true;
  const explicit = new Set(subscriptions.refs.map((ref) => refKey(ref.repository.toLowerCase(), ref.number)));
  return (repository, number) => !explicit.has(refKey(repository.toLowerCase(), number))
    && !isExcluded(subscriptions, repository, number);
}
