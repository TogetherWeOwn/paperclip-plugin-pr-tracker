// Hold-gate decision core (pure, dependency-free).
//
// Decides the required `hold-gate` commit status for one pull request from
// the board state of its linked cards. No I/O: the caller resolves linked
// cards (work-products + tracking entries) and their hold/blocker flags,
// then feeds them here. Offline-testable with placeholders only.
//
// FAIL-CLOSED. Any unreadable card (readOk:false, null hold flag, null
// blocker count) resolves to `fail`, never to `pass`. A malformed input
// throws: a swallowed bad read would look exactly like "nothing to hold".
//
// PUBLIC-TEXT SAFE. The returned `detail` carries fixed words plus counts
// only — never card identifiers, hosts, or agent names — so it is safe to
// publish as a GitHub status description on public repos.
//
// PRECEDENCE. `ciso-hold` > `blocker` > `board-unreadable`: the reason names
// the strongest known cause, but every cause resolves to `fail`.
// The gate never clears a hold: the Director cannot clear a CISO hold;
// only the CISO clears holds, only the owning team clears blockers.

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const SHA40 = /^[0-9a-f]{40}$/

/** Pinned GitHub status context published by the PR controller. */
export const HOLD_GATE_CONTEXT = 'hold-gate / Paperclip'

export const HOLD_GATE_STATES = Object.freeze(['pass', 'fail'])
export const HOLD_GATE_REASONS = Object.freeze([
  'clear',
  'no-linked-card',
  'ciso-hold',
  'blocker',
  'board-unreadable',
])

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function validateCard(card, index) {
  const where = `linkedCards[${index}]`
  requireValue(card && typeof card === 'object' && !Array.isArray(card), `${where} is required`)
  requireValue(typeof card.issueId === 'string' && card.issueId.length > 0, `${where}.issueId is required`)
  requireValue(typeof card.identifier === 'string' && card.identifier.length > 0, `${where}.identifier is required`)
  const hold = card.hasOpenCisoHold
  requireValue(hold === true || hold === false || hold === null, `${where}.hasOpenCisoHold must be boolean or null`)
  const blockers = card.unresolvedBlockerCount
  requireValue(
    blockers === null || (Number.isSafeInteger(blockers) && blockers >= 0),
    `${where}.unresolvedBlockerCount must be a non-negative integer or null`,
  )
  requireValue(typeof card.readOk === 'boolean', `${where}.readOk is required`)
}

/**
 * Decide the hold-gate for one PR.
 *
 * @param {object} args
 * @param {string} args.repository - `owner/repo`.
 * @param {number} args.number - PR number.
 * @param {string} args.headSha - 40-hex head SHA the status applies to.
 * @param {object[]} args.linkedCards - one entry per card linked to the PR
 *   (work-products + tracking entries, unioned by the caller).
 * @returns {{state:'pass'|'fail', reason:string, repository:string, number:number, headSha:string, detail:string}}
 */
export function decideHoldGate({ repository, number, headSha, linkedCards } = {}) {
  requireValue(typeof repository === 'string' && REPOSITORY.test(repository), 'repository is invalid')
  requireValue(Number.isSafeInteger(number) && number > 0, 'number is invalid')
  requireValue(typeof headSha === 'string' && SHA40.test(headSha), 'headSha is invalid')
  requireValue(Array.isArray(linkedCards), 'linkedCards must be an array')

  linkedCards.forEach(validateCard)

  if (linkedCards.length === 0) {
    return Object.freeze({
      state: 'pass',
      reason: 'no-linked-card',
      repository,
      number,
      headSha,
      detail: 'No linked cards: nothing to hold.',
    })
  }

  const holdCount = linkedCards.filter((c) => c.hasOpenCisoHold === true).length
  if (holdCount > 0) {
    return Object.freeze({
      state: 'fail',
      reason: 'ciso-hold',
      repository,
      number,
      headSha,
      detail: `${holdCount} linked card${holdCount === 1 ? '' : 's'} under open hold: merge blocked.`,
    })
  }

  const blockerCards = linkedCards.filter(
    (c) => Number.isSafeInteger(c.unresolvedBlockerCount) && c.unresolvedBlockerCount > 0,
  ).length
  if (blockerCards > 0) {
    return Object.freeze({
      state: 'fail',
      reason: 'blocker',
      repository,
      number,
      headSha,
      detail: `${blockerCards} linked card${blockerCards === 1 ? '' : 's'} with unresolved blockers: merge blocked.`,
    })
  }

  const unreadable = linkedCards.some(
    (c) => c.readOk !== true || c.hasOpenCisoHold === null || c.unresolvedBlockerCount === null,
  )
  if (unreadable) {
    return Object.freeze({
      state: 'fail',
      reason: 'board-unreadable',
      repository,
      number,
      headSha,
      detail: 'Board state unreadable: merge blocked until the board answers (fail-closed).',
    })
  }

  return Object.freeze({
    state: 'pass',
    reason: 'clear',
    repository,
    number,
    headSha,
    detail: `All ${linkedCards.length} linked card${linkedCards.length === 1 ? '' : 's'} clear of holds and blockers.`,
  })
}

/**
 * Map a gate decision to a GitHub commit-status payload.
 * `fail` -> `failure`, `pass` -> `success`. The description is the
 * public-text-safe `detail` above.
 */
export function toCommitStatus(decision) {
  requireValue(decision && typeof decision === 'object', 'decision is required')
  requireValue(decision.state === 'pass' || decision.state === 'fail', 'decision state is invalid')
  requireValue(typeof decision.detail === 'string' && decision.detail.length > 0, 'decision detail is required')
  return Object.freeze({
    state: decision.state === 'pass' ? 'success' : 'failure',
    context: HOLD_GATE_CONTEXT,
    description: decision.detail.slice(0, 140),
  })
}
