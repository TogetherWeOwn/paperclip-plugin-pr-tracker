# PR Tracker plugin

A Paperclip plugin that watches open pull requests every 2 minutes and wakes
the owning task with a precise change digest, plus repeating compliance checks
so nothing is forgotten.

## What lives here

- `src/decision-core/upstream-watcher.js` — pure decision core. No I/O:
  snapshot + ack in, at most one digest out
  (`silent`/`baseline`/`unknown`/`untracked`/`digest`/`latched`).
- `test/upstream-watcher.test.mjs` — offline suite for the core (28 tests,
  `node --test`). No network, no credentials. Fixture identifiers are
  `DEMO-*` placeholders.
- `src/manifest.js` — plugin manifest: worker capabilities plus the `pollPrs`
  job at `*/2 * * * *`, plus the three UI slots (`sidebar` "Pull Requests",
  `detailTab` on issues, `dashboardWidget` counts) with `entrypoints.ui`.
  Slot shapes verified against the live SDK.
- `src/ui/view-model.js` — pure sidebar view-model: 7-status vocabulary,
  `StatusBadge` mapping, `needs-us` filter set (saved default), combined
  status/repo/kind/owner/text filters, widget counts, and `DataTable` row
  projection. No rendering; the host SDK owns that.
- `src/worker/setup.js` — thin host adapter: `setup(ctx, options)` registers
  the `pollPrs` job, resolves the read-only secret ref, loads/saves
  ack+ETag+tracking state, delivers digests via task wakes, and
  exposes `getData`/`performAction` for the UI bridges. REST collection
  stays injected and fail-loud (`unknown`, never `silent`).
- `src/ui/entries.js` — UI bundle entry models behind the manifest
  `exportName`s: sidebar page, task tab with per-PR compliance checklist,
  and widget counts. The host prebuilds this to `./dist/ui.js`.
- `src/worker/collect-rest.js` — REST collector factory: ETag list polling
  with head-SHA skip, per-PR detail mapping (CI rollup, mergeable, review
  verdict, threads/comments as hashes, response times) to core snapshots.
  Rate-limited 403s normalize to 429; malformed reads map to `unknown`.
- `src/worker/ref-subscriptions.js` — typed upstream-ref contract: explicit
  `(repository, kind, number)` refs with a retire policy and optional
  equivalence evidence. Duplicates, excluded numbers and malformed input are
  refused; discovery drops refs the registry already covers or excludes.
- `src/decision-core/ref-ledger.js` — pure typed-ref lifecycle. Only an
  explicit `merged === true` proves a merge. `merged_or_closed` retires on a
  terminal state; `equivalent_fix_verified` retires only on recorded
  equivalence evidence, never on closure. Post-terminal noise on a retired ref
  stays silent; each lifecycle transition, including a reopen, digests once.
  Issue digests reuse the writer marker.
- `test/ref-subscriptions.test.mjs`, `test/ref-ledger.test.mjs`,
  `test/collect-subscriptions.test.mjs`, `test/ref-tick.test.mjs` — offline
  suites over `test/fixtures/`: all ten refs covered, exclusions held, PR and
  issue routing, unknown reads never retire, delivery-gated ledger, auth halt.
- `scripts/pack.sh` — mirrors dependency-free ESM into `dist/` with the two
  manifest entrypoints (`npm run build` wiring rides the export).
- `src/decision-core/flake-quarantine.js` — pure flake-triage core. No I/O:
  five-dialect log parsing, `repo|workflow|job|test` ledger keys, the
  flip-rate ladder (rate > 0.2 over >= 5 runs), quarantine-and-label with an
  evidence link, and the hard fence that an unproven label never blocks a PR
  (the only actions are `label` and `none`). `weeklyReport` commits every
  denominator, including reruns per merged PR with n.
- `test/flake-quarantine.test.mjs` + `test/fixtures/flake-backfill-7d.json` —
  offline suite ending in a 7-day backfill pass: labels land only on proven
  flakes (precision 1.0 on the fixture).
- `src/decision-core/red-main-signal.js` — pure red-main core. No I/O: the
  authoritative base signal from the latest completed main-branch run,
  once-per-incident routing (`create`/`append`/`noop`/`skip` against open
  owner cards and the evidence ledger), and time-to-green. Alert-only: no
  revert, merge, block or queue action exists here.
- `test/red-main-signal.test.mjs` — offline suite for the signal core,
  including the alert-only fence.
- `src/worker/flake-quarantine.js` — `flakyQuarantine` adapter: `runQuarantineTick`
  (ledger + attempt-1 failures in, injected `applyLabel` out) plus job
  registration under the manifest key. Unproven tests never reach `applyLabel`.
- `src/worker/red-main-signal.js` — `redMainSignal` adapter: `runRedMainTick`
  (base signals in, injected `appendEvidence`/`openCard` out; green signals
  are reported and left alone) plus job registration.
- `test/worker-quarantine-redmain.test.mjs` — offline suite for both adapters
  over fakes: label/route exactly when the core says so, register under the
  manifest keys, never invent a block/revert/merge.
- `src/worker/poll-prs.js` — `pollPrs` collector. Pure and dependency-free:
  scope dedup, ETag conditional headers, status classifier (401/403 stops the
  source — never substitute credentials; 429/5xx backs off; anything else
  unexpected is `unknown`, never `silent`), bounded backoff with jitter,
  disabled-tick guard (zero reads, zero wakes), and `runPollTick` wiring the
  decision core with the 4h/4h/7d worker policy. Ack persists only after
  durable delivery; failed delivery withholds the advance so the retry
  converges.
- `test/collect-rest.test.mjs` — offline suite for the REST collector
  (9 tests, `node --test`). No network, no credentials.
- `test/poll-prs.test.mjs` — offline suite for the collector (12 tests),
  ending in a real-core integration pass: baseline first sight, digest a head
  push, deliver exactly once.
- `test/view-model.test.mjs` — offline suite for the view-model plus manifest
  UI-slot assertions (8 tests, `node --test`). No network, no credentials.
- `test/setup.test.mjs` — offline suite for the worker setup + UI entries
  (11 tests, `node --test`). No network, no credentials.

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

UI slots declared and verified against the plugin SDK; the sidebar "Pull
Requests" page, task tab, and dashboard widget build on
`src/ui/view-model.js`. Worker setup (`src/worker/setup.js`) and UI bundle
entries (`src/ui/entries.js`) are wired at version 0.4.0; the prebuilt
bundles (`./dist/worker.js`, `./dist/ui.js`) build via `npm run build`
(`scripts/pack.sh`), and REST collection (`src/worker/collect-rest.js`)
feeds the decision core.
