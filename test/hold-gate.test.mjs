// Hold-gate offline suite. Pure decision core only: no network, no board
// credentials, no tracker IDs (DEMO-* placeholders).
//
// Failing-first: a PR linked to a card with an open CISO hold or an
// unresolved blocker must resolve to `fail` before any fix path is trusted.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HOLD_GATE_CONTEXT,
  decideHoldGate,
} from '../src/decision-core/hold-gate.js'

const card = (over = {}) => ({
  issueId: 'issue-demo-1',
  identifier: 'DEMO-1',
  hasOpenCisoHold: false,
  unresolvedBlockerCount: 0,
  readOk: true,
  ...over,
})

test('gate context name is pinned', () => {
  assert.equal(HOLD_GATE_CONTEXT, 'hold-gate / Paperclip')
})

test('failing-first: open CISO hold resolves to fail', () => {
  const out = decideHoldGate({
    repository: 'org/repo',
    number: 1,
    headSha: 'a'.repeat(40),
    linkedCards: [card({ hasOpenCisoHold: true })],
  })
  assert.equal(out.state, 'fail')
  assert.equal(out.reason, 'ciso-hold')
})

test('failing-first: unresolved blocker resolves to fail', () => {
  const out = decideHoldGate({
    repository: 'org/repo',
    number: 1,
    headSha: 'a'.repeat(40),
    linkedCards: [card({ unresolvedBlockerCount: 2 })],
  })
  assert.equal(out.state, 'fail')
  assert.equal(out.reason, 'blocker')
})

test('clear cards resolve to pass', () => {
  const out = decideHoldGate({
    repository: 'org/repo',
    number: 1,
    headSha: 'a'.repeat(40),
    linkedCards: [card(), card({ issueId: 'issue-demo-2', identifier: 'DEMO-2' })],
  })
  assert.equal(out.state, 'pass')
})

test('fail-closed: unreadable board resolves to fail, never pass', () => {
  for (const linkedCards of [
    [card({ readOk: false })],
    [card({ hasOpenCisoHold: null })],
    [card({ unresolvedBlockerCount: null })],
  ]) {
    const out = decideHoldGate({
      repository: 'org/repo',
      number: 1,
      headSha: 'a'.repeat(40),
      linkedCards,
    })
    assert.equal(out.state, 'fail', JSON.stringify(linkedCards))
  }
})

test('untracked PR (no linked cards) resolves to pass with no-linked-card', () => {
  const out = decideHoldGate({
    repository: 'org/repo',
    number: 1,
    headSha: 'a'.repeat(40),
    linkedCards: [],
  })
  assert.equal(out.state, 'pass')
  assert.equal(out.reason, 'no-linked-card')
})

test('CISO hold takes precedence over blocker in the reason', () => {
  const out = decideHoldGate({
    repository: 'org/repo',
    number: 1,
    headSha: 'a'.repeat(40),
    linkedCards: [card({ hasOpenCisoHold: true, unresolvedBlockerCount: 3 })],
  })
  assert.equal(out.state, 'fail')
  assert.equal(out.reason, 'ciso-hold')
})

test('malformed input throws, never resolves to silent pass', () => {
  assert.throws(() => decideHoldGate({ repository: 'bad', number: 1, headSha: 'a'.repeat(40), linkedCards: [] }))
  assert.throws(() => decideHoldGate({ repository: 'org/repo', number: 0, headSha: 'a'.repeat(40), linkedCards: [] }))
  assert.throws(() => decideHoldGate({ repository: 'org/repo', number: 1, headSha: 'short', linkedCards: [] }))
})
