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

function validateThread(thread) {
  requireValue(thread && typeof thread === 'object' && !Array.isArray(thread), 'thread is required')
  requireValue(typeof thread.id === 'string' && OPAQUE_ID.test(thread.id), 'thread id is invalid')
  requireValue(isMs(thread.createdAtMs), 'thread createdAtMs is invalid')
  requireValue(isMs(thread.updatedAtMs) && thread.updatedAtMs >= thread.createdAtMs, 'thread updatedAtMs is invalid')
  requireValue(typeof thread.bodyHash === 'string' && HEX.test(thread.bodyHash), 'thread bodyHash is invalid')
  requireValue(thread.resolved === false, 'only unresolved threads belong in the snapshot')
}

function validateComment(comment) {
  requireValue(comment && typeof comment === 'object' && !Array.isArray(comment), 'comment is required')
  requireValue(typeof comment.id === 'string' && OPAQUE_ID.test(comment.id), 'comment id is invalid')
  requireValue(typeof comment.authorKind === 'string' && AUTHOR_KINDS.includes(comment.authorKind),
    'comment authorKind is invalid')
  requireValue(isMs(comment.createdAtMs), 'comment createdAtMs is invalid')
  requireValue(isMs(comment.updatedAtMs) && comment.updatedAtMs >= comment.createdAtMs, 'comment updatedAtMs is invalid')
  requireValue(typeof comment.bodyHash === 'string' && HEX.test(comment.bodyHash), 'comment bodyHash is invalid')
}

function validateTracking(tracking) {
  requireValue(tracking && typeof tracking === 'object' && !Array.isArray(tracking), 'tracking entry is required')
  requireValue(typeof tracking.repository === 'string' && REPOSITORY.test(tracking.repository),
    'tracking repository is invalid')
  requireValue(Number.isSafeInteger(tracking.number) && tracking.number > 0, 'tracking PR number is invalid')
  requireValue(typeof tracking.issueId === 'string' && tracking.issueId.length > 0, 'tracking issueId is required')
  requireValue(typeof tracking.identifier === 'string' && tracking.identifier.length > 0,
    'tracking identifier is required')
  requireValue(typeof tracking.cardOpen === 'boolean', 'tracking cardOpen is required')
}
