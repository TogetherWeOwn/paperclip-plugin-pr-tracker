// setup + entries offline suite. Fake host ctx, fake REST collect: no
// network, no board credentials. Pins the wiring contract: disabled ticks
// do nothing, 304s stay silent, digests wake exactly once with an
// idempotency marker, and ack/ETag state persists only after delivery.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../src/worker/setup.js";
import { JOB_KEYS } from "../src/manifest.js";
import {
  PrSidebarPage,
  PrDetailTab,
  PrCountsWidget,
  checklistFor,
} from "../src/ui/entries.js";

const T0 = 1_758_000_000_000;
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const KEY = "org/repo#7";

const TRACKING = Object.freeze({
  repository: "org/repo",
  number: 7,
  issueId: "issue-7",
  identifier: "DEMO-7",
  cardOpen: true,
  title: "Fix the thing",
  prUrl: "https://example.invalid/org/repo/pull/7",
  kind: "org",
  uiStatus: "ours-to-do",
  owner: "agent-a",
  openedAtMs: T0 - 86_400_000,
});

function snapshot(headSha) {
  return {
    repository: "org/repo",
    number: 7,
    state: "open",
    merged: false,
    headSha,
    ci: { rollup: "green", sinceMs: null },
    mergeable: "mergeable",
    reviewDecision: "review_required",
    threads: [],
    comments: [],
    lastOurResponseAtMs: null,
    lastMaintainerAtMs: T0 - 3_600_000,
    fetchedAtMs: T0,
    readOk: true,
  };
}

function fakeCtx(over = {}) {
  const store = {};
  const wakes = [];
  return {
    ctx: {
      jobs: {
        registered: {},
        register(k, fn) {
          this.registered[k] = fn;
        },
      },
      issues: {
        wakes,
        async requestWakeup(issueId, companyId, opts) {
          wakes.push({ issueId, companyId, opts });
          return over.wakeupResult ?? { queued: true, runId: null };
        },
      },
      secrets: {
        async resolve() {
          return "test-token";
        },
      },
      state: {
        store,
        async get() {
          return store.state ?? null;
        },
        async set(addr) {
          store.state = addr.state;
        },
      },
    },
    wakes,
    store,
  };
}

const OPTS = {
  companyId: "company-1",
  configPath: "plugins/pr-tracker",
  secretRef: { type: "secret_ref", secretId: "github-org-app", version: "latest" },
  scope: { upstream: [], org: ["org/repo"] },
};

function collectWith(headSha, status = 200) {
  return async () => [
    {
      key: KEY,
      status,
      etag: "etag-1",
      input: { prev: null, next: snapshot(headSha), tracking: TRACKING, nowMs: T0 },
    },
  ];
}

test("setup registers pollPrs and requires its options", () => {
  const { ctx } = fakeCtx();
  const api = setup(ctx, { ...OPTS, collect: collectWith(HEAD_A) });
  assert.equal(typeof ctx.jobs.registered[JOB_KEYS.pollPrs], "function");
  assert.equal(typeof api.tick, "function");
  assert.throws(() => setup(ctx, {}), /companyId/);
  assert.throws(() => setup(ctx, { ...OPTS }), /collect/);
});

test("disabled probe stops the tick with zero reads and zero wakes", async () => {
  const { ctx, wakes, store } = fakeCtx();
  let collected = 0;
  const api = setup(ctx, {
    ...OPTS,
    enabledProbe: async () => false,
    collect: async () => {
      collected += 1;
      return [];
    },
  });
  const out = await api.tick();
  assert.equal(out.outcome, "stopped-disabled");
  assert.equal(collected, 0);
  assert.equal(wakes.length, 0);
  assert.equal(store.state, undefined);
});

test("first sight baselines with no wake; head push digests with one idempotent wake", async () => {
  const { ctx, wakes, store } = fakeCtx();
  let head = HEAD_A;
  const api = setup(ctx, { ...OPTS, collect: () => collectWith(head)() });
  const first = await api.tick();
  assert.equal(first.results[0].outcome, "baseline");
  assert.equal(wakes.length, 0);
  assert.ok(store.state.acks[KEY]);
  assert.equal(store.state.etags[KEY], "etag-1");

  head = HEAD_B;
  const second = await api.tick();
  assert.equal(second.results[0].outcome, "digest");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].issueId, "issue-7");
  assert.equal(wakes[0].opts.reason, "pr-change");
  assert.match(wakes[0].opts.idempotencyKey, /^[0-9a-f]{24}$|recovery-writer:/);
});

test("304 stays silent and performs no wake", async () => {
  const { ctx, wakes } = fakeCtx();
  const api = setup(ctx, { ...OPTS, collect: collectWith(HEAD_A, 304) });
  const out = await api.tick();
  assert.equal(out.results[0].outcome, "silent");
  assert.equal(out.wakes, 0);
  assert.equal(wakes.length, 0);
});

test("failed delivery withholds the ack advance", async () => {
  const { ctx, wakes, store } = fakeCtx({ wakeupResult: { queued: false, runId: null } });
  let head = HEAD_A;
  const api = setup(ctx, { ...OPTS, collect: () => collectWith(head)() });
  await api.tick();
  head = HEAD_B;
  const out = await api.tick();
  assert.equal(out.results[0].delivered, false);
  assert.equal(wakes.length, 1);
  assert.equal(store.state.acks[KEY].snapshot.headSha, HEAD_A);
});

test("getData projects rows, counts, and totals", async () => {
  const { ctx } = fakeCtx();
  const api = setup(ctx, { ...OPTS, collect: collectWith(HEAD_A) });
  await api.tick();
  const data = await api.getData({ nowMs: T0 });
  assert.equal(data.totalCount, 1);
  assert.equal(data.rows[0].repo, "org/repo");
  assert.equal(data.rows[0].badge, "warning");
  assert.deepEqual(data.counts, { needsUs: 1, waiting: 0, redCi: 0 });
  const empty = await api.getData({ filter: { status: "merged" }, nowMs: T0 });
  assert.equal(empty.totalCount, 0);
});

test("performAction wakes one known PR and rejects unknown keys", async () => {
  const { ctx, wakes } = fakeCtx();
  const api = setup(ctx, { ...OPTS, collect: collectWith(HEAD_A) });
  await api.tick();
  const res = await api.performAction({ action: "wake", key: KEY });
  assert.deepEqual(res, { ok: true });
  assert.equal(wakes.length, 1);
  await assert.rejects(api.performAction({ action: "wake", key: "nope" }), /unknown PR key/);
  await assert.rejects(api.performAction({ action: "merge" }), /unknown action/);
});

test("F1: untracked reads persist no null and getData never throws", async () => {
  const { ctx, wakes, store } = fakeCtx();
  const validNext = {
    repository: "org/repo",
    number: 9,
    state: "open",
    merged: false,
    headSha: HEAD_A,
    ci: { rollup: "green", sinceMs: null },
    mergeable: "mergeable",
    reviewDecision: "review_required",
    threads: [],
    comments: [],
    lastOurResponseAtMs: null,
    lastMaintainerAtMs: null,
    fetchedAtMs: T0,
    readOk: true,
  };
  const api = setup(ctx, {
    ...OPTS,
    collect: async () => [
      { key: "org/repo#9", status: 200, input: { prev: null, next: validNext, tracking: null, nowMs: T0 } },
    ],
  });
  const out = await api.tick();
  assert.equal(out.results[0].outcome, "untracked");
  assert.equal(wakes.length, 0);
  assert.ok(!("org/repo#9" in store.state.tracking));
  const data = await api.getData({ nowMs: T0 });
  assert.equal(data.totalCount, 0);
  // Legacy null entries are skipped, not dereferenced.
  store.state.tracking["org/repo#9"] = null;
  const data2 = await api.getData({ nowMs: T0 });
  assert.equal(data2.totalCount, 0);
});

test("F2: collector-mutated list ETags persist across ticks", async () => {
  const { ctx, store } = fakeCtx();
  const api = setup(ctx, {
    ...OPTS,
    collect: async ({ etags }) => {
      etags["https://example.invalid/list"] = "list-etag-2";
      return [];
    },
  });
  await api.tick();
  assert.equal(store.state.etags["https://example.invalid/list"], "list-etag-2");
});

test("an untracked read never overwrites stored tracking", async () => {
  const { ctx, store } = fakeCtx();
  let tracked = true;
  const api = setup(ctx, {
    ...OPTS,
    collect: async () => [
      {
        key: KEY,
        status: 200,
        input: { prev: null, next: snapshot(HEAD_A), tracking: tracked ? TRACKING : null, nowMs: T0 },
      },
    ],
  });
  await api.tick();
  assert.equal(store.state.tracking[KEY].issueId, "issue-7");
  tracked = false;
  await api.tick();
  assert.equal(store.state.tracking[KEY].issueId, "issue-7");
});

test("entries: sidebar page, detail tab, widget, checklist", () => {
  const records = [
    {
      repo: "org/repo", number: 7, title: "Fix", prUrl: "u", kind: "org",
      status: "ci-red", taskId: "issue-7", owner: "a", openedAtMs: T0 - 10,
    },
    {
      repo: "org/repo", number: 8, title: "Feat", prUrl: "u", kind: "org",
      status: "waiting-maintainer", taskId: "issue-8", owner: "b", openedAtMs: T0 - 20,
    },
  ];
  const page = PrSidebarPage({ records, nowMs: T0 });
  assert.equal(page.columns.length, 12);
  assert.equal(page.totalCount, 1); // saved default is needs-us
  const all = PrSidebarPage({ records, filter: {}, nowMs: T0 });
  assert.equal(all.totalCount, 2);
  assert.deepEqual(page.counts, { needsUs: 1, waiting: 1, redCi: 1 });
  const filtered = PrSidebarPage({ records, filter: { needsUs: true }, nowMs: T0 });
  assert.equal(filtered.totalCount, 1);

  const snaps = { "org/repo#7": snapshot(HEAD_A) };
  const tab = PrDetailTab({ records, snapshots: snaps, taskId: "issue-7", nowMs: T0 });
  assert.equal(tab.length, 1);
  assert.equal(tab[0].statusLabel, "CI red");
  const keys = Object.fromEntries(tab[0].checklist.map((c) => [c.key, c.ok]));
  assert.deepEqual(keys, { open: true, ci: true, mergeable: true, review: false, threads: true });

  assert.deepEqual(PrCountsWidget({ records }), { needsUs: 1, waiting: 1, redCi: 1 });
  assert.deepEqual(checklistFor({}), [
    { key: "open", label: "PR is open", ok: false },
    { key: "ci", label: "CI is green", ok: false },
    { key: "mergeable", label: "Mergeable (no conflicts)", ok: false },
    { key: "review", label: "Review approved", ok: false },
    { key: "threads", label: "No unresolved threads", ok: true },
  ]);
});
