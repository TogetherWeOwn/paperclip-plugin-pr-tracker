/**
 * @param {object|null} prev  persisted ack for this PR, or null on first sight.
 * @param {object} nextRaw  one compact collector read.
 * @param {object} tracking  canonical tracking task ({ repository, number,
 *   issueId, identifier, cardOpen }). No tracking entry means the orphan
 *   intake owns creation — the watcher never mints a task.
 * @param {object} policy  watcherPolicy() value.
 * @param {number} nowMs  collector clock.
 * @param {string[]} cardMarkers  writer markers already on the tracking
 *   task (default []). Consulted only for latched one-shots; a hit means
 *   the delivery already landed and the digest is swallowed to a latch
 *   advance (zero wakes), never re-emitted.
 * @returns exactly one of:
 *   { action:'silent' } — unchanged: zero wakes, ack untouched.
 *   { action:'baseline', nextAck } — first sight: persist, zero wakes.
 *   { action:'unknown', detail } — failed/rate-limited/partial read: zero
 *     wakes, ack untouched, back off and retry; never a close.
 *   { action:'untracked', repository, number } — no canonical task:
 *     diagnostic for the orphan intake; zero wakes.
 *   { action:'digest', dedupeKey, repository, number, issueId, identifier,
 *     changes, reopen, nextAck } — exactly one digest. Persist nextAck only
 *     after durable delivery to the writer; a retry with the same prev
 *     yields the identical digest.
 *   { action:'latched', nextAck } — the digest already landed on the card
 *     (marker hit): zero wakes, persist nextAck to converge the lost ack.
 */
export function decideUpstreamWatch({ prev, next: nextRaw, tracking, policy, nowMs, cardMarkers = [] }) {
  requireValue(Array.isArray(cardMarkers), 'cardMarkers must be an array')
  requireValue(isMs(nowMs), 'nowMs is invalid')
  const p = watcherPolicy(policy ?? {})
  const { snapshot: next, signature: nextSignature } = normalizeSnapshot(nextRaw)

  if (next.readOk !== true || next.rateLimited || next.partial
    || (next.pages !== null && next.pages.total !== null && next.pages.fetched < next.pages.total)) {
    return {
      action: 'unknown',
      repository: next.repository,
      number: next.number,
      detail: next.rateLimited ? 'rate-limited'
        : !next.readOk ? 'read-failed'
          : 'partial-page',
    }
  }

  if (tracking === null || tracking === undefined) {
    return { action: 'untracked', repository: next.repository, number: next.number }
  }
  validateTracking(tracking)
  requireValue(tracking.repository === next.repository && tracking.number === next.number,
    'tracking entry does not match the snapshot PR')

  if (prev === null || prev === undefined) {
    return {
      action: 'baseline',
      repository: next.repository,
      number: next.number,
      nextAck: Object.freeze({
        signature: nextSignature,
        snapshot: next,
        sla: Object.freeze({ response: 'ok', redCi: 'ok', ping: 'pending' }),
        closedSeen: next.state === 'closed',
        reopenReported: false,
        firstSeenMs: nowMs,
      }),
    }
  }
  validateAck(prev)

  const { changes, closed } = diffSnapshots(prev.snapshot, next)
  const transitions = next.state === 'open' ? slaTransitions(prev, next, p, nowMs) : []
  // Latched one-shot: a reopen-mismatch reports once. While the card stays
  // closed the digest would otherwise re-emit byte-identically every tick,
  // and the writer posts one comment per proposal — a second identical
  // board comment for zero new information.
  const reopen = tracking.cardOpen === false && next.state === 'open' && !prev.reopenReported
  if (reopen) changes.push({ kind: 'reopen-mismatch', detail: 'closed-card-open-pr' })

  // A retired close stays silent: the merge already produced its digest,
  // and downstream retirement owns what follows.
  if (changes.length === 0 && transitions.length === 0) return { action: 'silent' }
  if (closed && prev.closedSeen) return { action: 'silent' }

  const allChanges = [...changes, ...transitions]
  const sla = {
    response: prev.sla.response === 'breached' || transitions.some((change) => change.kind === 'sla-response-breach')
      ? 'breached' : 'ok',
    redCi: prev.sla.redCi === 'breached' || transitions.some((change) => change.kind === 'sla-redci-breach')
      ? 'breached' : 'ok',
    ping: prev.sla.ping === 'sent' || transitions.some((change) => change.kind === 'sla-ping-eligible')
      ? 'sent' : 'pending',
  }
  // The digest identity folds the one-shot outcomes in: an SLA-only tick
  // after ack-loss can no longer re-emit the same digest, because the
  // latched sla markers distinguish "about to breach" from "breached".
  const digestSignature = signatureOf({
    next: nextSignature,
    changes: allChanges.map((change) => change.kind),
    sla,
    reopenReported: prev.reopenReported || reopen,
  })
  const digest = {
    action: 'digest',
    // Stable per resulting state: a duplicate retry yields the identical
    // digest, so the writer claim dedupes it to one wake.
    dedupeKey: `upstream-digest:${next.repository}#${next.number}:${digestSignature.slice(0, 16)}`,
    repository: next.repository,
    number: next.number,
    issueId: tracking.issueId,
    identifier: tracking.identifier,
    changes: Object.freeze(allChanges.map((change) => Object.freeze({ ...change }))),
    reopen,
    nextAck: Object.freeze({
      signature: nextSignature,
      snapshot: next,
      sla: Object.freeze(sla),
      closedSeen: prev.closedSeen || closed,
      reopenReported: prev.reopenReported || reopen,
      firstSeenMs: prev.firstSeenMs,
    }),
  }
  // Ack-loss convergence: the ack persist raced a delivered writer comment.
  // The card already carries this digest's marker, so re-emitting would post
  // a second identical comment. Swallow to a latch advance: zero wakes, and
  // persisting nextAck converges the lost ack so the tick after stays silent.
  if (duplicateDelivered(cardMarkers, digest)) {
    return {
      action: 'latched',
      repository: next.repository,
      number: next.number,
      swallowed: digest.dedupeKey,
      nextAck: digest.nextAck,
    }
  }
  return digest
}
