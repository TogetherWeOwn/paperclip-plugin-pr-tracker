# PR Tracker plugin

A Paperclip plugin that watches open pull requests every 2 minutes and wakes
the owning task with a precise change digest, plus repeating compliance checks
so nothing is forgotten.

## What lives here

- `src/decision-core/upstream-watcher.js` — pure decision core. No I/O:
  snapshot + ack in, at most one digest out
  (`silent`/`baseline`/`unknown`/`untracked`/`digest`/`latched`).
- `test/upstream-watcher.test.mjs` — offline suite for the core (27 tests,
  `node --test`). No network, no credentials. Fixture identifiers are
  `DEMO-*` placeholders.
- `src/manifest.js` — plugin manifest: worker capabilities plus the `pollPrs`
  job at `*/2 * * * *`. UI slots (`sidebar`/`detailTab`/`dashboardWidget`)
  land with the UI slice.
- `src/worker/poll-prs.js` — `pollPrs` collector. Pure and dependency-free:
  scope dedup, ETag conditional headers, status classifier (401/403 stops the
  source — never substitute credentials; 429/5xx backs off; anything else
  unexpected is `unknown`, never `silent`), bounded backoff with jitter,
  disabled-tick guard (zero reads, zero wakes), and `runPollTick` wiring the
  decision core with the 4h/4h/7d worker policy. Ack persists only after
  durable delivery; failed delivery withholds the advance so the retry
  converges.
- `test/poll-prs.test.mjs` — offline suite for the collector (11 tests),
  ending in a real-core integration pass: baseline first sight, digest a head
  push, deliver exactly once.

## Policy

The core defaults stay 24h/24h/7d. The worker passes
`{ responseSlaMs: 4h, redCiSlaMs: 4h, silencePingMs: 7d }` (`workerPolicy()`);
the 12h re-wake and the 24h compliance-red escalation live in the worker
ladder (`POLICY.rewakeMs` / `POLICY.gatusRedMs`), not the core.

## Verify

```sh
npm test
```

## Status

Worker MVP first; the sidebar "Pull Requests" page, task tab, and dashboard
widget follow once the UI slot shape is verified against the plugin SDK.
