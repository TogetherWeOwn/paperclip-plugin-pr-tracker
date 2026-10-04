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

/**
 * Validate one compact collector read and freeze its normalized form. Throws
 * on malformed shape; transport problems travel as readOk:false (or partial /
 * rateLimited / short pages), which decide() maps to `unknown`, not silence.
 */
export function normalizeSnapshot(snapshot) {
  requireValue(snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot), 'snapshot is required')
  requireValue(typeof snapshot.repository === 'string' && REPOSITORY.test(snapshot.repository),
    'snapshot repository is invalid')
  requireValue(Number.isSafeInteger(snapshot.number) && snapshot.number > 0, 'snapshot PR number is invalid')
  requireValue(typeof snapshot.state === 'string' && STATES.includes(snapshot.state), 'snapshot state is invalid')
  requireValue(typeof snapshot.merged === 'boolean', 'snapshot merged is required')
  requireValue(typeof snapshot.headSha === 'string' && SHA40.test(snapshot.headSha), 'snapshot headSha is invalid')
  const ci = snapshot.ci
  requireValue(ci && typeof ci === 'object' && !Array.isArray(ci), 'snapshot ci is required')
  requireValue(typeof ci.rollup === 'string' && CI_ROLLUPS.includes(ci.rollup), 'snapshot ci.rollup is invalid')
  requireValue(isMsOrNull(ci.sinceMs), 'snapshot ci.sinceMs is invalid')
  requireValue(typeof snapshot.mergeable === 'string' && MERGEABLES.includes(snapshot.mergeable),
    'snapshot mergeable is invalid')
  requireValue(typeof snapshot.reviewDecision === 'string' && REVIEWS.includes(snapshot.reviewDecision),
    'snapshot reviewDecision is invalid')
  requireValue(Array.isArray(snapshot.threads), 'snapshot threads must be an array')
  requireValue(Array.isArray(snapshot.comments), 'snapshot comments must be an array')
  snapshot.threads.forEach(validateThread)
  snapshot.comments.forEach(validateComment)
  requireValue(isMsOrNull(snapshot.lastOurResponseAtMs), 'snapshot lastOurResponseAtMs is invalid')
  requireValue(isMsOrNull(snapshot.lastMaintainerAtMs), 'snapshot lastMaintainerAtMs is invalid')
  requireValue(isMs(snapshot.fetchedAtMs), 'snapshot fetchedAtMs is invalid')
  requireValue(typeof snapshot.readOk === 'boolean', 'snapshot readOk is required')
  const partial = snapshot.partial === true
  const rateLimited = snapshot.rateLimited === true
  const pages = snapshot.pages
  if (pages !== undefined) {
    requireValue(pages && typeof pages === 'object' && !Array.isArray(pages), 'snapshot pages is invalid')
    requireValue(Number.isSafeInteger(pages.fetched) && pages.fetched >= 0, 'snapshot pages.fetched is invalid')
    requireValue(pages.total === null || (Number.isSafeInteger(pages.total) && pages.total >= 0),
      'snapshot pages.total is invalid')
  }
  const threads = snapshot.threads
    .map((thread) => Object.freeze({ ...thread }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const comments = snapshot.comments
    .map((comment) => Object.freeze({ ...comment }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const normalized = Object.freeze({
    repository: snapshot.repository,
    number: snapshot.number,
    state: snapshot.state,
    merged: snapshot.merged,
    headSha: snapshot.headSha,
    ci: Object.freeze({ rollup: ci.rollup, sinceMs: ci.sinceMs }),
    mergeable: snapshot.mergeable,
    reviewDecision: snapshot.reviewDecision,
    threads: Object.freeze(threads),
    comments: Object.freeze(comments),
    lastOurResponseAtMs: snapshot.lastOurResponseAtMs,
    lastMaintainerAtMs: snapshot.lastMaintainerAtMs,
    fetchedAtMs: snapshot.fetchedAtMs,
    readOk: snapshot.readOk,
    partial,
    rateLimited,
    pages: pages === undefined ? null : Object.freeze({ fetched: pages.fetched, total: pages.total }),
  })
  // fetchedAtMs is read metadata, not PR state: two reads of an unchanged PR
  // must share one signature, or every 15-minute tick would look like change.
  const { fetchedAtMs: _readAt, ...stablePart } = normalized
  return { snapshot: normalized, signature: signatureOf(stablePart) }
}
