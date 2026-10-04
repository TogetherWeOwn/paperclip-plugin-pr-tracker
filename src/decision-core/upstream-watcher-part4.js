function validateAck(ack) {
  requireValue(ack && typeof ack === 'object' && !Array.isArray(ack), 'ack is required')
  requireValue(typeof ack.signature === 'string' && HEX.test(ack.signature), 'ack signature is invalid')
  requireValue(ack.snapshot && typeof ack.snapshot === 'object', 'ack snapshot is required')
  const sla = ack.sla
  requireValue(sla && typeof sla === 'object' && !Array.isArray(sla), 'ack sla is required')
  requireValue(['ok', 'breached'].includes(sla.response), 'ack sla.response is invalid')
  requireValue(['ok', 'breached'].includes(sla.redCi), 'ack sla.redCi is invalid')
  requireValue(['pending', 'sent'].includes(sla.ping), 'ack sla.ping is invalid')
  requireValue(typeof ack.closedSeen === 'boolean', 'ack closedSeen is required')
  // Latched one-shot state: once delivered, the next tick must not re-emit
  // the same transition. An ack that predates a latched digest (lost persist
  // racing a writer-applied delivery) still converges: the live card carries
  // the writer marker, and the latch below refuses the duplicate.
  requireValue(typeof ack.reopenReported === 'boolean', 'ack reopenReported is required')
  requireValue(isMs(ack.firstSeenMs), 'ack firstSeenMs is invalid')
}

/**
 * The writer marker a delivered digest leaves on the tracking task. The
 * writer posts `Recovery decision `recovery-writer:<fp>` per applied
 * `operator_decision` proposal, where fp mirrors
 * recovery_writer.Decision.fingerprint: sha256 over the canonical
 * {issueId, reason, mutation, targetAgentId, sourceId} JSON, first 24 hex.
 * renderWriterProposal binds every field from the digest, so the marker is
 * a pure function of the digest. If the writer scheme ever changes, the
 * pinned cross-language vector in the suite fails loudly.
 */
export function writerMarkerForDigest(digest) {
  requireValue(digest && digest.action === 'digest', 'digest is required')
  const proposal = renderWriterProposal(digest)
  const material = stable({
    issueId: proposal.issueId,
    reason: proposal.reason,
    mutation: proposal.mutation,
    targetAgentId: null,
    sourceId: proposal.sourceId,
  })
  return `recovery-writer:${createHash('sha256').update(material).digest('hex').slice(0, 24)}`
}

/**
 * Live-card guard against ack-loss duplicates. The caller passes the writer
 * markers already on the tracking task (`recovery-writer:<fp>` strings from
 * its comments); a hit on this digest's expected marker means the delivery
 * already landed and the lost ack must latch forward, not re-emit.
 *
 * @param {string[]} cardMarkers  writer markers already on the tracking task.
 * @param {object} digest  the digest that would be emitted.
 */
export function duplicateDelivered(cardMarkers, digest) {
  requireValue(Array.isArray(cardMarkers), 'cardMarkers must be an array')
  requireValue(digest && digest.action === 'digest', 'digest is required')
  const expected = writerMarkerForDigest(digest)
  return cardMarkers.some((marker) => typeof marker === 'string' && marker.includes(expected))
}

function diffSnapshots(prev, next) {
  const changes = []
  if (next.state !== prev.state || next.merged !== prev.merged) {
    changes.push({ kind: next.state === 'closed' ? 'closed' : 'reopened', detail: `state:${prev.state}->${next.state}` })
    // A close is one change, not a cascade: head/CI/review deltas on a
    // closed PR are retirement bookkeeping, already covered by `closed`.
    if (next.state === 'closed') return { changes, closed: true }
  }
  if (next.headSha !== prev.headSha) changes.push({ kind: 'head', detail: `head:${prev.headSha.slice(0, 12)}->${next.headSha.slice(0, 12)}` })
  if (next.ci.rollup !== prev.ci.rollup) {
    changes.push({ kind: 'ci', detail: `ci:${prev.ci.rollup}->${next.ci.rollup}` })
  }
  if (next.mergeable !== prev.mergeable) {
    changes.push({ kind: 'mergeable', detail: `mergeable:${prev.mergeable}->${next.mergeable}` })
  }
  if (next.reviewDecision !== prev.reviewDecision) {
    changes.push({ kind: 'review', detail: `review:${prev.reviewDecision}->${next.reviewDecision}` })
  }
  const prevThreads = new Map(prev.threads.map((thread) => [thread.id, thread]))
  const nextThreads = new Map(next.threads.map((thread) => [thread.id, thread]))
  for (const [id, thread] of nextThreads) {
    const before = prevThreads.get(id)
    if (!before) changes.push({ kind: 'thread-opened', detail: `thread:${id}` })
    else if (before.bodyHash !== thread.bodyHash || before.updatedAtMs !== thread.updatedAtMs) {
      changes.push({ kind: 'thread-updated', detail: `thread:${id}` })
    }
  }
  for (const id of prevThreads.keys()) {
    if (!nextThreads.has(id)) changes.push({ kind: 'thread-resolved', detail: `thread:${id}` })
  }
  const prevComments = new Map(prev.comments.map((comment) => [comment.id, comment]))
  const nextComments = new Map(next.comments.map((comment) => [comment.id, comment]))
  for (const [id, comment] of nextComments) {
    const before = prevComments.get(id)
    if (!before) changes.push({ kind: 'comment', detail: `comment:${id}` })
    else if (before.bodyHash !== comment.bodyHash || before.updatedAtMs !== comment.updatedAtMs) {
      changes.push({ kind: 'comment-edited', detail: `comment:${id}` })
    }
  }
  for (const change of changes) {
    requireValue(CHANGE_KINDS.includes(change.kind), 'change kind is unknown')
  }
  return { changes, closed: false }
}

function slaTransitions(prevAck, next, policy, nowMs) {
  const transitions = []
  const answeredAfter = (atMs) => next.lastOurResponseAtMs !== null && next.lastOurResponseAtMs >= atMs
  const oldestUnanswered = next.threads
    .filter((thread) => !answeredAfter(thread.createdAtMs))
    .map((thread) => thread.createdAtMs)
    .sort((a, b) => a - b)[0]
  if (oldestUnanswered !== undefined
    && nowMs - oldestUnanswered > policy.responseSlaMs
    && prevAck.sla.response !== 'breached') {
    transitions.push({ kind: 'sla-response-breach', detail: `unanswered-since:${oldestUnanswered}` })
  }
  if (next.ci.rollup === 'red' && next.ci.sinceMs !== null
    && nowMs - next.ci.sinceMs > policy.redCiSlaMs
    && prevAck.sla.redCi !== 'breached') {
    transitions.push({ kind: 'sla-redci-breach', detail: `red-since:${next.ci.sinceMs}` })
  }
  if (next.lastMaintainerAtMs !== null
    && nowMs - next.lastMaintainerAtMs > policy.silencePingMs
    && prevAck.sla.ping !== 'sent') {
    transitions.push({ kind: 'sla-ping-eligible', detail: `silent-since:${next.lastMaintainerAtMs}` })
  }
  return transitions
}
