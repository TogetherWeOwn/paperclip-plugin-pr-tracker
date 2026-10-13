// Extracted-gate fixtures for .github/workflows/pr-lint.yml.
// Runs the workflow's embedded python gate directly (no network, no credentials).
// Fixture tokens below are synthetic (AB-123, ZZ-999, ABC-123, localhost URLs and
// the gated host pattern); they exercise the gate, never real references.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let cachedCode = null;
function loadGateCode() {
  if (cachedCode) return cachedCode;
  const yml = readFileSync(
    new URL("../.github/workflows/pr-lint.yml", import.meta.url),
    "utf8",
  );
  const m = yml.match(/python3 - <<'PYEOF'\n([\s\S]*?)\n\s*PYEOF/);
  assert.ok(m, "gate python block found in pr-lint.yml");
  const lines = m[1].split("\n");
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const leading = line.match(/^ */)[0].length;
    if (leading < indent) indent = leading;
  }
  if (!Number.isFinite(indent)) indent = 0;
  cachedCode = lines.map((l) => l.slice(indent)).join("\n");
  return cachedCode;
}

function runGate({ title, body, env = {} }) {
  const code = loadGateCode();
  const baseEnv = {
    EVENT: "pull_request",
    TITLE: title,
    BODY: body,
    AUTHOR: "testuser",
    COMMITS: "[]",
    REQUIRE_CARD_REF: "false",
    INTERNAL_ID_PREFIXES: "",
    INTERNAL_ID_LEVEL: "warning",
    STRICT_INTERNAL_LEVEL: "error",
    PR_STANDARDS_MODE: "warn",
    ...env,
  };
  const res = spawnSync("python3", ["-c", code], {
    env: { ...process.env, ...baseEnv },
    encoding: "utf8",
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`;
  return { status: res.status, output };
}

const TITLE_OK = "fix(ci): close review notes";

function makeBody(extra = "") {
  const base = [
    "Closes the two informational review notes in one small slice.",
    "",
    "## Thinking Path",
    "- first thinking point about the gate",
    "- second thinking point about the gate",
    "- third thinking point about the gate",
    "## Linked Issues or Issue Description",
    "- plain words description without identifiers",
    "## What Changed",
    "- gate change description with enough detail",
    "## Verification",
    "- local extracted gate run passes cleanly",
    "## Risks",
    "- low risk rollout plan with revert path",
    "## Model Used",
    "- test harness run for verification",
  ].join("\n");
  return extra ? `${base}\n\n${extra}` : base;
}

const HOST = "infextion.net";

test("regression: generic id plus host retains exit 1 with empty prefixes", () => {
  const body = makeBody(`Holds AB-123 and ${HOST} reference for the gate.`);
  const { status, output } = runGate({
    title: TITLE_OK,
    body,
    env: {
      INTERNAL_ID_PREFIXES: "",
      INTERNAL_ID_LEVEL: "error",
      STRICT_INTERNAL_LEVEL: "warning",
    },
  });
  assert.equal(status, 1, `expected exit 1, got ${status}: ${output}`);
  assert.match(output, /Internal id in the body/);
});

test("strict host fixture fails on shipped defaults", () => {
  const body = makeBody(`Touches ${HOST} in the body text here.`);
  const { status, output } = runGate({ title: TITLE_OK, body });
  assert.equal(status, 1, `expected exit 1, got ${status}: ${output}`);
  assert.match(output, /Strict internal ref in the body/);
  assert.match(output, /the internal host/);
});

test("clean body passes on shipped defaults", () => {
  const { status, output } = runGate({ title: TITLE_OK, body: makeBody() });
  assert.equal(status, 0, `expected exit 0, got ${status}: ${output}`);
  assert.match(output, /PR conventions OK/);
});

test("advisory generic id warns and exits 0", () => {
  const body = makeBody("Mentions AB-123 as an advisory token here.");
  const { status, output } = runGate({ title: TITLE_OK, body });
  assert.equal(status, 0, `expected exit 0, got ${status}: ${output}`);
  assert.match(output, /Internal id in the body/);
  assert.doesNotMatch(output, /Strict internal ref/);
});

test("localhost-only warns and exits 0 without strict hit", () => {
  const body = makeBody(
    "Uses http://localhost:3000/health plus AB-123 as advisory tokens here.",
  );
  const { status, output } = runGate({ title: TITLE_OK, body });
  assert.equal(status, 0, `expected exit 0, got ${status}: ${output}`);
  assert.doesNotMatch(output, /Strict internal ref/);
});

test("prefix-scoped activation: configured org id fails", () => {
  const body = makeBody("Mentions ABC-123 as a configured token here.");
  const { status, output } = runGate({
    title: TITLE_OK,
    body,
    env: { INTERNAL_ID_PREFIXES: "ABC" },
  });
  assert.equal(status, 1, `expected exit 1, got ${status}: ${output}`);
  assert.match(output, /a tracker id/);
});

test("prefix-scoped activation: unconfigured token stays advisory", () => {
  const body = makeBody("Mentions ZZ-999 as an unconfigured token here.");
  const { status, output } = runGate({
    title: TITLE_OK,
    body,
    env: { INTERNAL_ID_PREFIXES: "ABC" },
  });
  assert.equal(status, 0, `expected exit 0, got ${status}: ${output}`);
  assert.doesNotMatch(output, /Strict internal ref/);
});

test("private card-ref mode stays satisfiable and host still fails", () => {
  const cardBody = makeBody("Refs ABC-123 for the private card link here.");
  const ok = runGate({
    title: TITLE_OK,
    body: cardBody,
    env: { REQUIRE_CARD_REF: "true", INTERNAL_ID_PREFIXES: "ABC" },
  });
  assert.equal(ok.status, 0, `expected exit 0, got ${ok.status}: ${ok.output}`);
  assert.doesNotMatch(ok.output, /Strict internal ref/);

  const missing = runGate({
    title: TITLE_OK,
    body: makeBody(),
    env: { REQUIRE_CARD_REF: "true", INTERNAL_ID_PREFIXES: "ABC" },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /Card reference/);

  const hostBody = makeBody(`Refs ABC-123 and touches ${HOST} here.`);
  const host = runGate({
    title: TITLE_OK,
    body: hostBody,
    env: { REQUIRE_CARD_REF: "true", INTERNAL_ID_PREFIXES: "ABC" },
  });
  assert.equal(host.status, 1, `expected exit 1, got ${host.status}: ${host.output}`);
  assert.match(host.output, /the internal host/);
});

test("strict annotations carry labels only, never values", () => {
  const uiUrl = `https://${HOST}/ABC/issues/123`;
  const body = makeBody(`See ${uiUrl} for the instance link case.`);
  const { status, output } = runGate({ title: TITLE_OK, body });
  assert.equal(status, 1, `expected exit 1, got ${status}: ${output}`);
  assert.match(output, /an instance UI link/);
  assert.match(output, /the internal host/);
  assert.ok(!output.includes(uiUrl), "strict output must not echo the raw URL");
  assert.ok(!output.includes("ABC-123"), "strict output must not echo raw ids");
});
