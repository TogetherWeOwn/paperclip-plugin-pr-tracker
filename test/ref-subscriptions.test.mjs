// ref-subscriptions offline suite. Pure contract checks against the validated
// registry fixture: no network, no credentials.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  normalizeSubscriptions,
  discoveryFilter,
  isExcluded,
  refKey,
} from "../src/worker/ref-subscriptions.js";

const registry = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/typed-refs-registry.json", import.meta.url)), "utf8"),
);

test("all ten validated typed refs normalize with their kind and retire policy", () => {
  const subs = normalizeSubscriptions(registry);
  assert.equal(subs.refs.length, 10);
  assert.deepEqual(
    subs.refs.map((ref) => ref.number),
    [13113, 10317, 11199, 12611, 11910, 12835, 13024, 13069, 13663, 12775],
  );
  const issue = subs.refs.find((ref) => ref.number === 11199);
  assert.equal(issue.kind, "issue");
  assert.equal(issue.retireLedgerWhen, "equivalent_fix_verified");
  assert.equal(subs.refs.filter((ref) => ref.kind === "pull_request").length, 9);
  assert.equal(subs.refs.find((ref) => ref.number === 10317).retireLedgerWhen, "merged_or_closed");
  assert.equal(new Set(subs.refs.map((ref) => ref.key)).size, 10);
});

test("the eleven exclusions stay excluded from both explicit and discovered intake", () => {
  const subs = normalizeSubscriptions(registry);
  assert.equal(subs.excludedNumbers.length, 11);
  const keep = discoveryFilter(subs);
  for (const number of registry.excludedNumbers) {
    assert.equal(isExcluded(subs, "paperclipai/paperclip", number), true, `excluded ${number}`);
    assert.equal(keep("paperclipai/paperclip", number), false, `discovery drops ${number}`);
  }
  for (const ref of subs.refs) {
    assert.equal(keep(ref.repository, ref.number), false, `explicit ${ref.number} is not rediscovered`);
  }
  assert.equal(keep("paperclipai/paperclip", 99999), true);
  assert.equal(keep("other/repo", 13113), true);
  assert.equal(keep("PaperclipAI/Paperclip", 13113), false, "a case variant of an explicit ref is not rediscovered");
  assert.equal(keep("PaperclipAI/Paperclip", 9743), false, "a case variant of an exclusion stays excluded");
});

test("refKey mirrors the state key format used by the collector", () => {
  assert.equal(refKey("paperclipai/paperclip", 13113), "paperclipai/paperclip#13113");
});

test("malformed registries fail loudly instead of dropping refs", () => {
  const base = JSON.parse(JSON.stringify(registry));
  assert.throws(() => normalizeSubscriptions({ ...base, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => normalizeSubscriptions({ ...base, repository: "not a repo" }), /repository/);
  assert.throws(
    () => normalizeSubscriptions({ ...base, refs: [...base.refs, base.refs[0]] }),
    /duplicate subscription ref/,
  );
  assert.throws(
    () => normalizeSubscriptions({
      ...base,
      refs: [...base.refs, { number: 9743, kind: "pull_request", role: "candidate", retireLedgerWhen: "merged_or_closed" }],
    }),
    /exclusion list/,
  );
  assert.throws(
    () => normalizeSubscriptions({
      ...base,
      refs: [{ number: 1, kind: "discussion", role: "candidate", retireLedgerWhen: "merged_or_closed" }],
    }),
    /kind is invalid/,
  );
  assert.throws(
    () => normalizeSubscriptions({
      ...base,
      refs: [{ number: 2, kind: "pull_request", role: "candidate", retireLedgerWhen: "merged_or_closed", equivalence: { kind: "rebase", sha: "xyz" } }],
    }),
    /equivalence sha/,
  );
});
