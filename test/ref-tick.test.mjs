// Typed-ref tick suite. Drives setup() with the real REST collector over a
// mutable fake GitHub: no network, no credentials. Pins one wake per terminal
// transition, zero wakes when unchanged, delivery-gated state, loud unknowns,
// and the authorization halt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setup } from "../src/worker/setup.js";
import { createRestCollector } from "../src/worker/collect-rest.js";

const registry = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/typed-refs-registry.json", import.meta.url)), "utf8"),
);
const REPO = "paperclipai/paperclip";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ISO = "2026-09-10T18:07:39Z";
const KEY = (n) => `${REPO}#${n}`;

let world = { pulls: {}, issues: {} };

function headers(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => lower[String(k).toLowerCase()] ?? null };
}

function prJson(number, spec) {
  return {
    number,
    state: spec.state ?? "open",
    merged: spec.merged ?? false,
    merged_at: spec.merged_at ?? null,
    merge_commit_sha: spec.merge_commit_sha ?? null,
    title: "fixture",
    html_url: `https://example.invalid/${REPO}/pull/${number}`,
    user: { login: "owner-x", type: "User" },
    head: { sha: spec.head ?? SHA_A },
    mergeable: null,
    mergeable_state: "unknown",
    created_at: ISO,
    updated_at: ISO,
  };
}

function routes() {
  const out = [];
  for (const [n, spec] of Object.entries(world.pulls)) {
    const number = Number(n);
    if (spec.rateLimited) {
      out.push([`/pulls/${number}`, { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: {} }]);
    } else if (spec.unauthorized) {
      out.push([`/pulls/${number}`, { status: 401, body: {} }]);
    } else {
      out.push(
        [`/pulls/${number}/comments`, { body: [] }],
        [`/pulls/${number}/reviews`, { body: [] }],
        [`/pulls/${number}`, { body: prJson(number, spec) }],
        [`/issues/${number}/comments`, { body: [] }],
        ["/check-runs", { body: { check_runs: [] } }],
      );
    }
  }
  for (const [n, body] of Object.entries(world.issues)) {
    out.push([`/repos/${REPO}/issues/${n}`, { body, headers: { etag: `"${JSON.stringify(body)}"` } }]);
  }
  return out;
}

const fetchImpl = async (url, { headers: sent = {} } = {}) => {
  for (const [match, res] of routes()) {
    if (url.includes(match)) {
      if (res.headers?.etag && sent["If-None-Match"] === res.headers.etag) {
        return { status: 304, headers: headers({}), json: async () => { throw new Error("no body on 304"); } };
      }
      return { status: res.status ?? 200, headers: headers(res.headers ?? {}), json: async () => res.body };
    }
  }
  throw new Error(`unexpected url ${url}`);
};

const TRACKS = {
  [KEY(10317)]: { repository: REPO, number: 10317, issueId: "issue-10317", identifier: "DEMO-10317", cardOpen: true },
  [KEY(13113)]: { repository: REPO, number: 13113, issueId: "issue-13113", identifier: "DEMO-13113", cardOpen: true },
  [KEY(13663)]: { repository: REPO, number: 13663, issueId: "issue-13663", identifier: "DEMO-13663", cardOpen: true },
  [KEY(11199)]: { repository: REPO, number: 11199, issueId: "issue-11199", identifier: "DEMO-11199", cardOpen: true },
};

const collect = createRestCollector({
  fetchImpl,
  resolveTracking: (repo, number) => TRACKS[`${repo}#${number}`] ?? null,
});

function subset(numbers) {
  return { ...registry, refs: registry.refs.filter((ref) => numbers.includes(ref.number)) };
}

function makeHost({ failures = 0 } = {}) {
  const store = {};
  const wakes = [];
  let remaining = failures;
  return {
    wakes,
    store,
    ctx: {
      jobs: { register() {} },
      issues: {
        async requestWakeup(issueId, companyId, opts) {
          wakes.push({ issueId, opts });
          if (remaining > 0) {
            remaining -= 1;
            return false;
          }
          return { ok: true };
        },
      },
      secrets: { async resolve() { return "test-token"; } },
      state: {
        async get() { return store.state ?? null; },
        async set(addr) { store.state = addr.state; },
      },
    },
  };
}

function api(host, numbers, equivalenceByNumber = {}) {
  const base = subset(numbers);
  const refs = base.refs.map((ref) => (equivalenceByNumber[ref.number]
    ? { ...ref, equivalence: equivalenceByNumber[ref.number] }
    : ref));
  return setup(host.ctx, {
    companyId: "company-1",
    configPath: "plugins/pr-tracker",
    secretRef: { type: "secret_ref", secretId: "github-org-app", version: "latest" },
    scope: { upstream: [], org: [] },
    subscriptions: { ...base, refs },
    collect,
  });
}

test("issue closure wakes once, stays silent while unchanged, and wakes again on reopen", async () => {
  world = { pulls: {}, issues: { 11199: { number: 11199, state: "open", state_reason: null, updated_at: ISO } } };
  const host = makeHost();
  const tick = api(host, [11199]).tick;

  const first = await tick();
  assert.equal(first.results[0].outcome, "baseline");
  assert.equal(host.wakes.length, 0);

  world.issues[11199] = { number: 11199, state: "closed", state_reason: "completed", updated_at: ISO };
  const closed = await tick();
  assert.equal(closed.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 1);
  assert.match(host.wakes[0].opts.idempotencyKey, /^recovery-writer:/);

  const unchanged = await tick();
  assert.equal(unchanged.results[0].outcome, "silent");
  assert.equal(host.wakes.length, 1);

  world.issues[11199] = { number: 11199, state: "open", state_reason: null, updated_at: ISO };
  const reopened = await tick();
  assert.equal(reopened.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 2);

  world.issues[11199] = { number: 11199, state: "closed", state_reason: "completed", updated_at: ISO };
  const reclosed = await tick();
  assert.equal(reclosed.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 3);
  assert.notEqual(host.wakes[2].opts.idempotencyKey, host.wakes[0].opts.idempotencyKey, "a re-closure is a new transition");

  const ledger = host.store.state.ledger[KEY(11199)];
  assert.equal(ledger.state, "active", "closure never retires an equivalence-policy ref");
  assert.equal(ledger.history.length, 4);
  assert.equal(host.store.state.tracking[KEY(11199)], undefined, "issue tracking is never stored as a PR row");
});

test("a merged PR retires its ref once; later changes on the retired ref stay silent", async () => {
  world = { pulls: { 10317: { state: "open" } }, issues: {} };
  const host = makeHost();
  const tick = api(host, [10317]).tick;

  await tick();
  world.pulls[10317] = { state: "closed", merged: true, merged_at: ISO, merge_commit_sha: "c".repeat(40) };
  const merged = await tick();
  assert.equal(merged.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 1);
  assert.equal(host.store.state.ledger[KEY(10317)].state, "retired");
  assert.equal(host.store.state.ledger[KEY(10317)].retiredBy, "merged");

  world.pulls[10317] = { state: "closed", merged: true, merged_at: ISO, head: SHA_B };
  const after = await tick();
  assert.equal(after.results[0].outcome, "silent");
  assert.equal(host.wakes.length, 1);
});

test("failed delivery withholds the ledger and ack; the retry reuses the idempotency key", async () => {
  world = { pulls: { 10317: { state: "open" } }, issues: {} };
  const host = makeHost({ failures: 1 });
  const tick = api(host, [10317]).tick;

  await tick();
  world.pulls[10317] = { state: "closed", merged: true, merged_at: ISO };
  const failed = await tick();
  assert.equal(failed.results[0].delivered, false);
  assert.equal(host.store.state.ledger[KEY(10317)].state, "active");
  assert.equal(host.store.state.acks[KEY(10317)].snapshot.state, "open");

  const retried = await tick();
  assert.equal(retried.results[0].delivered, true);
  assert.equal(host.wakes.length, 2);
  assert.equal(host.wakes[0].opts.idempotencyKey, host.wakes[1].opts.idempotencyKey);
  assert.equal(host.store.state.ledger[KEY(10317)].state, "retired");
});

test("an unknown rate-limited read never retires; the later closure does", async () => {
  world = { pulls: { 13663: { state: "open" } }, issues: {} };
  const host = makeHost();
  const tick = api(host, [13663]).tick;

  await tick();
  world.pulls[13663] = { rateLimited: true };
  const limited = await tick();
  assert.equal(limited.results[0].outcome, "unknown");
  assert.equal(host.store.state.ledger[KEY(13663)].state, "active");
  assert.equal(host.wakes.length, 0);

  world.pulls[13663] = { state: "closed", merged: false };
  await tick();
  assert.equal(host.store.state.ledger[KEY(13663)].state, "retired");
  assert.equal(host.store.state.ledger[KEY(13663)].retiredBy, "closed");
  assert.equal(host.wakes.length, 1);
});

test("an equivalence-policy PR closes with one digest and stays active", async () => {
  world = { pulls: { 13113: { state: "open" } }, issues: {} };
  const host = makeHost();
  const tick = api(host, [13113]).tick;

  await tick();
  world.pulls[13113] = { state: "closed", merged: false, merge_commit_sha: "8".repeat(40) };
  const closed = await tick();
  assert.equal(closed.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 1);
  assert.equal(host.store.state.ledger[KEY(13113)].state, "active");
  assert.equal(host.store.state.ledger[KEY(13113)].lifecycle.terminal, "closed");

  const again = await tick();
  assert.equal(again.results[0].outcome, "silent");
  assert.equal(host.wakes.length, 1);
});

test("a candidate already closed unmerged at first sight retires with zero wakes", async () => {
  world = { pulls: { 13663: { state: "closed", merged: false } }, issues: {} };
  const host = makeHost();
  const first = await api(host, [13663]).tick();
  assert.equal(first.results[0].outcome, "baseline");
  assert.equal(host.wakes.length, 0);
  const ledger = host.store.state.ledger[KEY(13663)];
  assert.equal(ledger.state, "retired");
  assert.equal(ledger.retiredBy, "closed");
  assert.equal(ledger.history.length, 1);
});

test("an untracked explicit issue persists its ledger and produces zero wakes", async () => {
  world = { pulls: {}, issues: { 11199: { number: 11199, state: "closed", state_reason: "not_planned", updated_at: ISO } } };
  const host = makeHost();
  const untrackedApi = setup(host.ctx, {
    companyId: "company-1",
    configPath: "plugins/pr-tracker",
    secretRef: { type: "secret_ref", secretId: "github-org-app", version: "latest" },
    scope: { upstream: [], org: [] },
    subscriptions: subset([11199]),
    collect: createRestCollector({ fetchImpl, resolveTracking: () => null }),
  });
  const out = await untrackedApi.tick();
  assert.equal(out.results[0].outcome, "untracked");
  assert.equal(host.wakes.length, 0);
  assert.equal(host.store.state.ledger[KEY(11199)].lifecycle.terminal, "closed");
});

test("an authorization failure stops the tick before any other ref is read", async () => {
  world = { pulls: { 13113: { unauthorized: true }, 10317: { state: "open" } }, issues: {} };
  const host = makeHost();
  const out = await api(host, [10317, 13113]).tick();
  assert.deepEqual(out.results, [{ key: KEY(13113), outcome: "unknown", via: "stop-source" }]);
  assert.equal(host.wakes.length, 0);
  assert.equal(host.store.state.ledger[KEY(13113)], undefined);
  assert.equal(host.store.state.acks[KEY(10317)], undefined);
});

test("a failed issue closure is retried, never masked by an unchanged ETag", async () => {
  world = { pulls: {}, issues: { 11199: { number: 11199, state: "open", state_reason: null, updated_at: ISO } } };
  const host = makeHost({ failures: 1 });
  const tick = api(host, [11199]).tick;

  await tick();
  world.issues[11199] = { number: 11199, state: "closed", state_reason: "completed", updated_at: ISO };
  const failed = await tick();
  assert.equal(failed.results[0].delivered, false);

  const retried = await tick();
  assert.equal(retried.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 2);
  assert.equal(host.wakes[0].opts.idempotencyKey, host.wakes[1].opts.idempotencyKey);
  assert.equal(host.store.state.ledger[KEY(11199)].lifecycle.terminal, "closed");
});

test("equivalence evidence retires an issue at first sight; its closure is still one digest", async () => {
  world = { pulls: {}, issues: { 11199: { number: 11199, state: "open", state_reason: null, updated_at: ISO } } };
  const host = makeHost();
  const tick = api(host, [11199], { 11199: { kind: "rebase", sha: "c".repeat(40) } }).tick;

  const first = await tick();
  assert.equal(first.results[0].outcome, "baseline");
  world.issues[11199] = { number: 11199, state: "closed", state_reason: "completed", updated_at: ISO };
  const closed = await tick();
  assert.equal(closed.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 1);
  const ledger = host.store.state.ledger[KEY(11199)];
  assert.equal(ledger.state, "retired");
  assert.equal(ledger.retiredBy, "equivalence");
  assert.equal(ledger.lifecycle.terminal, "closed");
});

test("a reopened merged ref wakes once and reactivates its ledger", async () => {
  world = { pulls: { 10317: { state: "open" } }, issues: {} };
  const host = makeHost();
  const tick = api(host, [10317]).tick;

  await tick();
  world.pulls[10317] = { state: "closed", merged: true, merged_at: ISO };
  await tick();
  assert.equal(host.store.state.ledger[KEY(10317)].state, "retired");

  world.pulls[10317] = { state: "open" };
  const reopened = await tick();
  assert.equal(reopened.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 2);
  assert.equal(host.store.state.ledger[KEY(10317)].state, "active");
});

test("a PR closed again after a reopen digests the second closure and retires again", async () => {
  world = { pulls: { 10317: { state: "open" } }, issues: {} };
  const host = makeHost();
  const tick = api(host, [10317]).tick;

  await tick();
  world.pulls[10317] = { state: "closed", merged: false };
  const closed = await tick();
  assert.equal(closed.results[0].outcome, "digest");

  world.pulls[10317] = { state: "open", merged: false };
  const reopened = await tick();
  assert.equal(reopened.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 2);

  world.pulls[10317] = { state: "closed", merged: false };
  const reclosed = await tick();
  assert.equal(reclosed.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 3);
  assert.notEqual(host.wakes[2].opts.idempotencyKey, host.wakes[0].opts.idempotencyKey);
  assert.equal(host.store.state.ledger[KEY(10317)].state, "retired");
});

test("an equivalence-retired PR digests its closure once, stays silent on later noise, and wakes on reopen", async () => {
  world = { pulls: { 13113: { state: "open" } }, issues: {} };
  const host = makeHost();
  const tick = api(host, [13113], { 13113: { kind: "reviewed_code", sha: "d".repeat(40) } }).tick;

  await tick();
  world.pulls[13113] = { state: "closed", merged: false };
  const closed = await tick();
  assert.equal(closed.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 1);

  world.pulls[13113] = { state: "closed", merged: false, head: SHA_B };
  const noise = await tick();
  assert.equal(noise.results[0].outcome, "silent");
  assert.equal(host.wakes.length, 1);

  world.pulls[13113] = { state: "open", merged: false, head: SHA_B };
  const reopened = await tick();
  assert.equal(reopened.results[0].outcome, "digest");
  assert.equal(host.wakes.length, 2);
  assert.equal(host.store.state.ledger[KEY(13113)].state, "retired", "equivalence retirement is not undone by a reopen");
});

test("an issue tracking row without an identity is an unknown read, never a wake", async () => {
  world = { pulls: {}, issues: { 11199: { number: 11199, state: "open", state_reason: null, updated_at: ISO } } };
  const host = makeHost();
  const brokenCollect = createRestCollector({
    fetchImpl,
    resolveTracking: () => ({ issueId: "issue-11199", cardOpen: true }),
  });
  const out = await setup(host.ctx, {
    companyId: "company-1",
    configPath: "plugins/pr-tracker",
    secretRef: { type: "secret_ref", secretId: "github-org-app", version: "latest" },
    scope: { upstream: [], org: [] },
    subscriptions: subset([11199]),
    collect: brokenCollect,
  }).tick();
  assert.deepEqual(out.results, [{ key: KEY(11199), outcome: "unknown", via: "invalid-tracking" }]);
  assert.equal(host.wakes.length, 0);
  assert.equal(host.store.state.ledger[KEY(11199)], undefined);
});
