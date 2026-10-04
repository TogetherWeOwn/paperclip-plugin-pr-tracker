// Upstream PR watcher, change-only intake.
// Ported into the PR Tracker plugin from ops-tooling PR #539
// (`gh-event-capture/src/upstream-watcher.js`); behavior is verbatim, only
// internal tracker references were removed from comments for public export.
//
// No I/O. This module turns ONE compact read of one pull request (an upstream
// PR or an org PR) plus the persisted acknowledgement for that PR into at
// most one change digest. The caller feeds the digest to the tracking-task
// writer, which updates/wakes the canonical tracking task, and persists the
// returned acknowledgement ONLY after durable delivery.
//
// SILENT UNLESS CHANGED. An unchanged snapshot resolves to `silent`: zero
// wakes, acknowledgement untouched. A malformed snapshot throws: a swallowed
// bad read would look exactly like "nothing to do" and a stall would wait
// forever. A failed, rate-limited or partial read resolves to `unknown` —
// never to `silent` and never to a close: unknown is not zero findings and
// not a closed PR.
//
// ONE-SHOTS LATCH. SLA breaches and the reopen-mismatch report once: the ack
// carries the latched outcomes, so the tick after stays silent. If the ack
// persist races a delivered writer comment (ack-loss), the retry converges
// instead of re-emitting: the collector passes the tracking task's writer
// markers (`recovery-writer:<fp>` comment strings) as `cardMarkers`, a hit
// on this digest's expected marker resolves to `latched` (zero wakes, persist
// the returned ack), and no second identical board comment is ever posted.
//
// READ-ONLY. Nothing here publishes replies, resolves threads, re-requests
// reviews, merges or force-pushes. Upstream text stays with the Steward and
// the approved identity path.
//
// SAFETY. PR titles, bodies, branch names, thread bodies and comment bodies
// from the upstream repo are never accepted here at all: snapshots carry only
// validated SHAs, fixed-vocabulary states, opaque thread/comment ids and
// content hashes. Digests and writer notes carry fixed words plus the
// validated repository, PR number and change kinds.
//
// COLLECTION CONTRACT (caller-owned, plugin worker side). The plugin job
// `pollPrs` runs a read-only collection every 2 minutes: REST conditional
// requests with ETag (304s are free) for PR/issues/comments/check-runs.
// GraphQL POST has no ETag support — do not invent it. Every page must be
// fetched (pages.fetched must equal pages.total or the read is partial).
// Backoff with jitter, bounded scope, and retry are the collector's job;
// this module only classifies what the collector hands it.

import { createHash } from 'node:crypto'

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const SHA40 = /^[0-9a-f]{40}$/
const HEX = /^[0-9a-f]+$/
const OPAQUE_ID = /^[A-Za-z0-9_:\/-]{1,200}$/
const MS_LIMIT = 8.64e15

const STATES = Object.freeze(['open', 'closed'])
const CI_ROLLUPS = Object.freeze(['green', 'red', 'pending', 'unknown'])
const MERGEABLES = Object.freeze(['mergeable', 'conflicting', 'behind', 'unknown'])
const REVIEWS = Object.freeze(['approved', 'changes_requested', 'review_required', 'unknown'])
const AUTHOR_KINDS = Object.freeze(['human', 'bot'])
const CHANGE_KINDS = Object.freeze([
  'head', 'ci', 'mergeable', 'review',
  'thread-opened', 'thread-resolved', 'thread-updated',
  'comment', 'comment-edited',
  'closed', 'reopened', 'reopen-mismatch',
  'sla-response-breach', 'sla-redci-breach', 'sla-ping-eligible',
])
// Must stay within the recovery writer allowlist plus "none": the writer
// refuses anything else, so an incompatible digest would die silently.
const WRITER_MUTATION = 'operator_decision'

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function isMs(value) {
  return Number.isInteger(value) && value >= 0 && value <= MS_LIMIT
}

function isMsOrNull(value) {
  return value === null || isMs(value)
}

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
}

function signatureOf(normalized) {
  return createHash('sha256').update(stable(normalized)).digest('hex')
}

/**
 * Validate and freeze the watcher policy. SLA bounds are positive
 * millisecond counts; the defaults are respond within 24h, fix red CI
 * within 24h, one polite ping after 7 days of maintainer silence.
 * The PR Tracker worker passes a tighter policy (4h response, 4h red CI,
 * 7d ping) with 12h re-wake and 24h escalation handled worker-side.
 */
export function watcherPolicy(policy = {}) {
  requireValue(policy && typeof policy === 'object' && !Array.isArray(policy), 'watcher policy is required')
  const {
    responseSlaMs = 24 * 3_600_000,
    redCiSlaMs = 24 * 3_600_000,
    silencePingMs = 7 * 24 * 3_600_000,
  } = policy
  requireValue(isMs(responseSlaMs) && responseSlaMs > 0, 'responseSlaMs must be a positive millisecond count')
  requireValue(isMs(redCiSlaMs) && redCiSlaMs > 0, 'redCiSlaMs must be a positive millisecond count')
  requireValue(isMs(silencePingMs) && silencePingMs > 0, 'silencePingMs must be a positive millisecond count')
  return Object.freeze({ responseSlaMs, redCiSlaMs, silencePingMs })
}
