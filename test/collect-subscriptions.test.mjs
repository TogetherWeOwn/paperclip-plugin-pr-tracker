// Typed-ref collection offline suite. Recording fake transport keyed by URL:
// no network, no credentials. Pins explicit-ref routing (PR vs issue),
// discovery dedupe and exclusion, and the auth halt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRestCollector } from "../src/worker/collect-rest.js";
import { normalizeSubscriptions } from "../src/worker/ref-subscriptions.js";

const registry = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/typed-refs-registry.json", import.meta.url)), "utf8"),
);
const REPO = "paperclipai/paperclip";
const SHA = "d".repeat(40);
const ISO = "2026-09-10T18:07:39Z";

function headers(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => lower[String(k).toLowerCase()] ?? null };
}

function routeFetch(routes) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    for (const [match, res] of routes) {
      if (url.includes(match)) {
        return {
          status: res.status ?? 200,
          headers: headers(res.headers ?? {}),
          json: async () => res.body,
        };
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchImpl, urls };
}

function prJson(number, over = {}) {
  return {
    number,
    state: "closed",
    merged: false,
    merged_at: null,
    merge_commit_sha: "e".repeat(40),
    title: "fixture",
    html_url: `https://example.invalid/${REPO}/pull/${number}`,
    user: { login: "owner-x", type: "User" },
    head: { sha: SHA },
    mergeable: null,
    mergeable_state: "unknown",
    created_at: ISO,
    updated_at: ISO,
    ...over,
  };
}

function prRoutes(number, over = {}) {
  return [
    [`/pulls/${number}/comments`, { body: [] }],
    [`/pulls/${number}/reviews`, { body: [] }],
    [`/pulls/${number}`, { body: prJson(number, over) }],
    [`/issues/${number}/comments`, { body: [] }],
    ["/check-runs", { body: { check_runs: [] } }],
  ];
}

function subsFor(refs) {
  return normalizeSubscriptions({
    schemaVersion: 1,
    repository: REPO,
    refs,
    excludedNumbers: registry.excludedNumbers,
  });
}

const PR_13113 = { number: 13113, kind: "pull_request", role: "partial_patch_source", retireLedgerWhen: "equivalent_fix_verified" };
const PR_10317 = { number: 10317, kind: "pull_request", role: "partial_patch_source", retireLedgerWhen: "merged_or_closed" };
const ISSUE_11199 = { number: 11199, kind: "issue", role: "fork_fixed_replay_bug", retireLedgerWhen: "equivalent_fix_verified" };

test("an explicit closed, unmerged PR is fetched by number; merge_commit_sha does not make it merged", async () => {
  const { fetchImpl, urls } = routeFetch(prRoutes(13113));
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([PR_13113]) });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].key, `${REPO}#13113`);
  assert.equal(reads[0].status, 200);
  assert.equal(reads[0].lifecycle.terminal, "closed");
  assert.equal(reads[0].lifecycle.merged, false);
  assert.ok(urls.includes(`https://api.github.com/repos/${REPO}/pulls/13113`));
  assert.ok(!urls.some((url) => url.includes("state=open")), "explicit refs skip the open-intake list");
});

test("an explicit PR with merged=true is a merge; the closure without it is not", async () => {
  const merged = routeFetch(prRoutes(10317, { state: "closed", merged: true, merged_at: ISO }));
  const collect = createRestCollector({ fetchImpl: merged.fetchImpl, resolveTracking: () => null });
  const reads = await collect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([PR_10317]) });
  assert.equal(reads[0].lifecycle.terminal, "merged");
});

test("an explicit issue routes to the issue endpoint only, never PR reviews, checks or head", async () => {
  const { fetchImpl, urls } = routeFetch([
    [`/repos/${REPO}/issues/11199`, {
      body: { number: 11199, state: "closed", state_reason: "completed", closed_at: ISO, updated_at: ISO },
    }],
  ]);
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([ISSUE_11199]) });
  assert.equal(reads[0].status, 200);
  assert.deepEqual(reads[0].lifecycle, {
    kind: "issue", state: "closed", stateReason: "completed", terminal: "closed",
  });
  assert.deepEqual(urls, [`https://api.github.com/repos/${REPO}/issues/11199`]);
});

test("an issue ref that resolves to a pull request is a loud 409, never a closure", async () => {
  const { fetchImpl } = routeFetch([
    [`/repos/${REPO}/issues/11199`, { body: { number: 11199, state: "closed", pull_request: {} } }],
  ]);
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([ISSUE_11199]) });
  assert.equal(reads[0].status, 409);
  assert.equal(reads[0].lifecycle, undefined);
});

test("discovery drops explicit refs and excluded numbers, so each ref is read once", async () => {
  const { fetchImpl, urls } = routeFetch([
    ["/search/issues", { body: { items: [{ number: 13113 }, { number: 9743 }, { number: 12611 }] } }],
    ...prRoutes(13113),
    ...prRoutes(12611, { state: "open", merged: false, merged_at: null }),
  ]);
  const collect = createRestCollector({ fetchImpl, upstreamAuthor: "owner-x", resolveTracking: () => null });
  const reads = await collect({
    scope: { upstream: [REPO], org: [] },
    token: "t",
    subscriptions: subsFor([PR_13113]),
  });
  assert.deepEqual(reads.map((r) => r.key), [`${REPO}#12611`, `${REPO}#13113`]);
  assert.ok(!urls.some((url) => url.includes("/pulls/9743")), "excluded number is never fetched");
});

test("an authorization failure halts further explicit reads and never substitutes a credential", async () => {
  const { fetchImpl, urls } = routeFetch([
    [`/pulls/13113`, { status: 401, body: { message: "Bad credentials" } }],
    ...prRoutes(10317, { state: "open", merged: false, merged_at: null }),
  ]);
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({
    scope: { upstream: [], org: [] },
    token: "t",
    subscriptions: subsFor([PR_13113, PR_10317]),
  });
  assert.deepEqual(reads.map((r) => [r.key, r.status]), [[`${REPO}#13113`, 401]]);
  assert.ok(!urls.some((url) => url.includes("/pulls/10317")));
});

test("a rate-limited explicit read is retained as 429 and does not halt the other refs", async () => {
  const { fetchImpl } = routeFetch([
    [`/pulls/13113`, { status: 403, headers: { "x-ratelimit-remaining": "0" }, body: {} }],
    ...prRoutes(10317, { state: "open", merged: false, merged_at: null }),
  ]);
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({
    scope: { upstream: [], org: [] },
    token: "t",
    subscriptions: subsFor([PR_13113, PR_10317]),
  });
  assert.deepEqual(reads.map((r) => [r.key, r.status]), [[`${REPO}#13113`, 429], [`${REPO}#10317`, 200]]);
});

test("a 403 on check runs halts the source like any other authorization failure", async () => {
  const CHECK_SHA = "e".repeat(40);
  const { fetchImpl, urls } = routeFetch([
    [`/commits/${CHECK_SHA}/check-runs`, { status: 403, body: {} }],
    ...prRoutes(13113, { head: { sha: CHECK_SHA } }),
    ...prRoutes(10317, { state: "open", merged: false, merged_at: null }),
  ]);
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([PR_13113, PR_10317]) });
  assert.deepEqual(reads.map((r) => [r.key, r.status]), [[`${REPO}#13113`, 403]]);
  assert.ok(!urls.some((url) => url.includes("/pulls/10317")));
});

test("a 200 with no readable comments or check-runs body is a retryable read, never a fresh one", async () => {
  const CHECK_SHA = "f".repeat(40);
  const commentsGone = routeFetch([
    ["/pulls/13113/comments", { status: 200, body: undefined }],
    ...prRoutes(13113),
    ...prRoutes(10317, { state: "open", merged: false, merged_at: null }),
  ]);
  const commentsCollect = createRestCollector({ fetchImpl: commentsGone.fetchImpl, resolveTracking: () => null });
  const commentsReads = await commentsCollect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([PR_13113, PR_10317]) });
  assert.deepEqual(commentsReads.map((r) => [r.key, r.status]), [[`${REPO}#13113`, 502], [`${REPO}#10317`, 200]]);

  const checksGone = routeFetch([
    [`/commits/${CHECK_SHA}/check-runs`, { status: 200, body: undefined }],
    ...prRoutes(13113, { head: { sha: CHECK_SHA } }),
    ...prRoutes(10317, { state: "open", merged: false, merged_at: null }),
  ]);
  const checksCollect = createRestCollector({ fetchImpl: checksGone.fetchImpl, resolveTracking: () => null });
  const checksReads = await checksCollect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([PR_13113, PR_10317]) });
  assert.deepEqual(checksReads.map((r) => [r.key, r.status]), [[`${REPO}#13113`, 502], [`${REPO}#10317`, 200]]);
});

test("a 200 with no readable body is a retryable read, never a crashing fresh read", async () => {
  const { fetchImpl } = routeFetch([
    ["/pulls/13113", { status: 200, body: undefined }],
    ...prRoutes(10317, { state: "open", merged: false, merged_at: null }),
  ]);
  const collect = createRestCollector({ fetchImpl, resolveTracking: () => null });
  const reads = await collect({ scope: { upstream: [], org: [] }, token: "t", subscriptions: subsFor([PR_13113, PR_10317]) });
  assert.deepEqual(reads.map((r) => [r.key, r.status]), [[`${REPO}#13113`, 502], [`${REPO}#10317`, 200]]);
});
