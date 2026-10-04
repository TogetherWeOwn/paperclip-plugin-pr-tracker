/**
 * Render one writer-compatible proposal for a digest. The mutation is the
 * existing `operator_decision` verb: the writer posts the digest to the
 * canonical tracking task, which updates/wakes it. Fixed words plus the
 * validated repository, number and change kinds only — never upstream text.
 */
export function renderWriterProposal(digest) {
  requireValue(digest && digest.action === 'digest', 'digest is required')
  requireValue(typeof digest.issueId === 'string' && digest.issueId.length > 0, 'digest issueId is required')
  requireValue(typeof digest.identifier === 'string' && digest.identifier.length > 0, 'digest identifier is required')
  requireValue(typeof digest.dedupeKey === 'string' && digest.dedupeKey.length > 0, 'digest dedupeKey is required')
  requireValue(Array.isArray(digest.changes) && digest.changes.length > 0, 'digest changes are required')
  for (const change of digest.changes) {
    requireValue(change && CHANGE_KINDS.includes(change.kind), 'digest change kind is unknown')
    requireValue(typeof change.detail === 'string' && change.detail.length > 0, 'digest change detail is required')
  }
  const kinds = digest.changes.map((change) => change.kind).join(',')
  return Object.freeze({
    detector: 'watcher/upstream',
    reason: 'upstream-change',
    mutation: WRITER_MUTATION,
    issueId: digest.issueId,
    identifier: digest.identifier,
    sourceId: digest.dedupeKey,
    before: Object.freeze({ repository: digest.repository, number: digest.number }),
    after: Object.freeze({ repository: digest.repository, number: digest.number, changes: kinds }),
    note: `Upstream ${digest.repository}#${digest.number} changed (${kinds}).`
      + (digest.reopen ? ' Tracking card is closed while the PR is open: reconcile, do not duplicate.' : ''),
  })
}

/**
 * Render one watchdog snapshot section row per tracked PR: open count, age,
 * response latency, unresolved threads and red CI. Watchdog detectors
 * threshold these rows; this function only measures, in fixed
 * vocabulary, from already-validated snapshots.
 */
export function renderWatchdogSection(entries, nowMs) {
  requireValue(isMs(nowMs), 'nowMs is invalid')
  requireValue(Array.isArray(entries), 'entries must be an array')
  return Object.freeze(entries.map((entry) => {
    const { snapshot } = normalizeSnapshot(entry.snapshot)
    const openedMs = entry.openedMs
    requireValue(isMs(openedMs) && openedMs <= nowMs, 'entry openedMs is invalid')
    const awaitingSinceMs = snapshot.threads
      .filter((thread) => snapshot.lastOurResponseAtMs === null || snapshot.lastOurResponseAtMs < thread.createdAtMs)
      .map((thread) => thread.createdAtMs)
      .sort((a, b) => a - b)[0] ?? null
    return Object.freeze({
      repo: snapshot.repository,
      number: snapshot.number,
      state: snapshot.state,
      merged: snapshot.merged,
      ageMin: Math.round((nowMs - openedMs) / 60_000),
      ciRollup: snapshot.ci.rollup,
      redCiMin: snapshot.ci.rollup === 'red' && snapshot.ci.sinceMs !== null
        ? Math.round((nowMs - snapshot.ci.sinceMs) / 60_000) : null,
      reviewDecision: snapshot.reviewDecision,
      unresolvedThreads: snapshot.threads.length,
      awaitingResponseMin: awaitingSinceMs !== null ? Math.round((nowMs - awaitingSinceMs) / 60_000) : null,
      pingSent: entry.pingSent === true,
    })
  }))
}
