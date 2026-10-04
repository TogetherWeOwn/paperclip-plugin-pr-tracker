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
