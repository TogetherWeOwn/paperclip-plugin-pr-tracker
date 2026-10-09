// collect-rest offline suite. Fake transport keyed by URL: no network, no
// credentials. Pins the mapper vocabulary, ETag/304 and rate-limit paths,
// and the fail-loud contract (bad reads are `unknown`, never `silent`).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ciRollupFromChecks,
  mergeableFromPr,
  reviewDecisionFromReviews,
  fetchJson,
  fetchAllPages,
  snapshotFromRest,
  createRestCollector,
} from "../src/worker/collect-rest.js";
import { normalizeSnapshot } from "../src/decision-core/upstream-watcher.js";

const T0 = 1_758_000_000_000;
const HEAD_A = "a".repeat(40);
const ISO = new Date(T0 - 3_600_000).toISOString();

function headers(map = {}) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => lower[String(k).toLowerCase()] ?? null };
}

function prBody(over = {}) {
  return {
    number: 7,
    state: "open",
    merged: false,
    merged_at: null,
    title: "Fix the thing",
    html_url: "https://example.invalid/org/repo/pull/7",
    user: { login: "owner-x", type: "User" },
    head: { sha: HEAD_A },
    mergeable: true,
    mergeable_state: "clean",
    created_at: ISO,
    updated_at: ISO,
    ...over,
  };
}

test("ci rollup: red wins with earliest start, then pending, green, unknown", () => {
  assert.deepEqual(ciRollupFromChecks([]), { rollup: "unknown", sinceMs: null });
  assert.deepEqual(
    ciRollupFromChecks([{ status: "completed", conclusion: "success" }]),
    { rollup: "green", sinceMs: null },
  );
  assert.deepEqual(
    ciRollupFromChecks([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]),
    { rollup: "pending", sinceMs: null },
  );
  const red = ciRollupFromChecks([
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "failure", started_at: ISO },
  ]);
  assert.equal(red.rollup, "red");
  assert.equal(red.sinceMs, Date.parse(ISO));
});

test("mergeable and review vocabularies", () => {
  assert.equal(mergeableFromPr({ mergeable: true }), "mergeable");
  assert.equal(mergeableFromPr({ mergeable: false }), "conflicting");
  assert.equal(mergeableFromPr({ mergeable: null, mergeable_state: "behind" }), "behind");
  assert.equal(mergeableFromPr({}), "unknown");
  assert.equal(reviewDecisionFromReviews([]), "review_required");
  assert.equal(reviewDecisionFromReviews([{ state: "COMMENTED" }]), "review_required");
  assert.equal(reviewDecisionFromReviews([{ state: "APPROVED" }]), "approved");
  assert.equal(
    reviewDecisionFromReviews([{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }]),
    "changes_requested",
  );
  assert.equal(
    reviewDecisionFromReviews([{ state: "CHANGES_REQUESTED" }, { state: "DISMISSED" }]),
    "changes_requested",
  );
  assert.equal(reviewDecisionFromReviews([{ state: "DISMISSED" }]), "review_required");
});

test("fetchJson sends ETag + token and normalizes exhausted 403 to 429", async () => {
  const seen = {};
  const fake = async (url, { headers: h }) => {
    seen.url = url;
    seen.headers = h;
    return {
      status: 403,
      headers: headers({ "x-ratelimit-remaining": "0" }),
      json: async () => ({ message: "rate limited" }),
    };
  };
  const res = await fetchJson(fake, "https://example.invalid/x", {
    token: "tok",
    etag: "e1",
  });
  assert.equal(res.status, 429);
  assert.equal(seen.headers["If-None-Match"], "e1");
  assert.equal(seen.headers.Authorization, "Bearer tok");
});

test("fetchAllPages follows Link and reports 304 for an ETag hit", async () => {
  const p1 = async () => ({
    status: 200,
    headers: headers({ link: '<https://example.invalid/p2>; rel="next"', etag: "e2" }),
    json: async () => [{ id: 1 }],
  });
  const p2 = async () => ({
    status: 200,
    headers: headers({}),
    json: async () => [{ id: 2 }],
  });
  const fake = async (url) => (url.includes("p2") ? p2() : p1());
  const out = await fetchAllPages(fake, "https://example.invalid/p1", {});
  assert.deepEqual(out.items, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(out.pages, { fetched: 2, total: null });

  const cached = async () => ({
    status: 304,
    headers: headers({}),
    json: async () => {
      throw new Error("no body on 304");
    },
  });
  const hit = await fetchAllPages(cached, "https://example.invalid/p1", { etag: "e1" });
  assert.equal(hit.notModified, true);
});

test("snapshotFromRest builds a core-valid snapshot", () => {
  const snap = snapshotFromRest({
    repository: "org/repo",
    pr: prBody(),
    issueComments: [
      {
        id: 11, user: { login: "owner-x", type: "User" },
        created_at: ISO, updated_at: ISO, body: "ack",
      },
    ],
    reviewComments: [
      {
        id: 22, user: { login: "greptile[bot]", type: "Bot" },
        created_at: ISO, updated_at: ISO, body: "score 4/5",
      },
    ],
    reviews: [{ state: "COMMENTED" }],
    checkRuns: [{ status: "completed", conclusion: "success" }],
    ourLogins: ["owner-x"],
    nowMs: T0,
  });
  const { snapshot } = normalizeSnapshot(snap);
  assert.equal(snapshot.ci.rollup, "green");
  assert.equal(snapshot.threads.length, 1);
  assert.equal(snapshot.threads[0].resolved, false);
  assert.equal(snapshot.comments.length, 1);
  assert.equal(snapshot.comments[0].authorKind, "human");
  assert.equal(snapshot.lastOurResponseAtMs, Date.parse(ISO));
  assert.equal(snapshot.lastMaintainerAtMs, Date.parse(ISO));
});

function routeFetch(routes) {
  return async (url) => {
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
}

const TRACK = {
  repository: "org/repo",
  number: 7,
  issueId: "issue-7",
  identifier: "DEMO-7",
  cardOpen: true,
};

function detailRoutes(prOver = {}, reviewBody = "looks good") {
  return [
    ["/pulls/7/comments", { body: [{ id: 22, user: { login: "greptile[bot]", type: "Bot" }, created_at: ISO, updated_at: ISO, body: reviewBody }] }],
    ["/pulls/7/reviews", { body: [] }],
    ["/pulls/7", { body: prBody(prOver) }],
    ["/issues/7/comments", { body: [] }],
    ["/check-runs", { body: { check_runs: [{ status: "completed", conclusion: "success" }] } }],
    ["/pulls?state=open", { body: [{ number: 7, head: { sha: HEAD_A }, updated_at: ISO }] }],
  ];
}

test("collector emits a fresh valid read, then skips on unchanged head", async () => {
  const collect = createRestCollector({
    fetchImpl: routeFetch(detailRoutes()),
    ourLogins: ["owner-x"],
    resolveTracking: () => TRACK,
  });
  const scope = { upstream: [], org: ["org/repo"] };
  const etags = {};
  const first = await collect({ scope, etags, token: "tok" });
  assert.equal(first.length, 1);
  assert.equal(first[0].key, "org/repo#7");
  assert.equal(first[0].status, 200);
  normalizeSnapshot(first[0].input.next);

  const prevAcks = {
    "org/repo#7": { snapshot: { headSha: HEAD_A, fetchedAtMs: T0 } },
  };
  const second = await collect({ scope, etags, token: "tok", prevAcks });
  assert.deepEqual(second, [{ key: "org/repo#7", status: 304 }]);
});

test("an org PR updated in the second its last read began is re-read, not skipped", async () => {
  const scope = { upstream: [], org: ["org/repo"] };
  const prevAcks = { "org/repo#7": { snapshot: { headSha: HEAD_A, fetchedAtMs: T0 + 500 } } };
  const sameSecond = createRestCollector({
    fetchImpl: routeFetch([
      ["/pulls?state=open", { body: [{ number: 7, head: { sha: HEAD_A }, updated_at: new Date(T0).toISOString() }] }],
      ...detailRoutes(),
    ]),
    ourLogins: ["owner-x"],
    resolveTracking: () => TRACK,
  });
  const reread = await sameSecond({ scope, etags: {}, token: "tok", prevAcks });
  assert.equal(reread[0].status, 200);

  const earlier = createRestCollector({
    fetchImpl: routeFetch([
      ["/pulls?state=open", { body: [{ number: 7, head: { sha: HEAD_A }, updated_at: new Date(T0 - 1000).toISOString() }] }],
    ]),
    resolveTracking: () => TRACK,
  });
  assert.deepEqual(await earlier({ scope, etags: {}, token: "tok", prevAcks }), [{ key: "org/repo#7", status: 304 }]);
});

test("malformed detail maps to 422, never a crashing fresh read", async () => {
  const bad = detailRoutes({ head: {} });
  const collect = createRestCollector({
    fetchImpl: routeFetch(bad),
    resolveTracking: () => TRACK,
  });
  const out = await collect({ scope: { upstream: [], org: ["org/repo"] }, token: "tok" });
  assert.equal(out[0].status, 422);
});

test("upstream scope without an author resolves to a loud unknown", async () => {
  const collect = createRestCollector({
    fetchImpl: routeFetch([]),
    resolveTracking: () => TRACK,
  });
  const out = await collect({ scope: { upstream: ["other/repo"], org: [] }, token: "tok" });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "scope:other/repo");
  assert.equal(out[0].status, 0);
});
