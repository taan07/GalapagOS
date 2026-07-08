// The tripwires leg: every pattern in the threat model, the diff parser,
// and the adapter against a real repo. Each pattern maps to a documented
// production reward hack (docs/research/confidence-engine-evidence.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectTripwires,
  isTestPath,
  parseUnifiedDiff,
  type ChangedFileDiff,
} from "../src/core/legs/tripwires";
import { collectChangedFileDiffs, runTripwires } from "../src/adapters/legs/tripwires";

function file(pathName: string, added: string[] = [], removed: string[] = []): ChangedFileDiff {
  return { path: pathName, addedLines: added, removedLines: removed };
}

function ids(files: ChangedFileDiff[]): string[] {
  return detectTripwires(files).map((finding) => `${finding.severity}:${finding.id}`);
}

test("rewriting the package.json check scripts is an alert", () => {
  assert.deepEqual(ids([file("package.json", ['    "test": "true",'])]), [
    "alert:check-script-modified",
  ]);
  // Unrelated package.json changes (a new dependency) fire nothing.
  assert.deepEqual(ids([file("package.json", ['    "zod": "^3.0.0",'])]), []);
});

test("touching test-runner machinery is an alert", () => {
  assert.deepEqual(ids([file("conftest.py", ["import sys"])]), [
    "alert:check-machinery-modified",
  ]);
  assert.deepEqual(ids([file("jest.config.js", ["module.exports = {}"])]), [
    "alert:check-machinery-modified",
  ]);
});

test("hard exits and always-true equality inside the change set are alerts", () => {
  assert.deepEqual(ids([file("tests/login.test.ts", ["process.exit(0);"])]), [
    "alert:exit-in-tests",
  ]);
  // The AlwaysEqual exploit can live in PRODUCTION code — path-independent.
  assert.deepEqual(
    ids([file("src/models.py", ["    def __eq__(self, other):", "        return True"])]),
    ["alert:always-equal"],
  );
});

test("skips and assertion deletion scale from warn to alert by volume", () => {
  assert.deepEqual(ids([file("tests/a.test.ts", ["it.skip('x', () => {})"])]), [
    "warn:tests-skipped",
  ]);
  assert.deepEqual(
    ids([
      file("tests/a.test.ts", [
        "it.skip('x', () => {})",
        "describe.skip('y', () => {})",
        "test.skip('z', () => {})",
      ]),
    ]),
    ["alert:tests-skipped"],
  );
  assert.deepEqual(
    ids([file("tests/a.test.ts", [], ["expect(result).toBe(3);"])]),
    ["warn:assertions-deleted"],
  );
  assert.deepEqual(
    ids([
      file(
        "tests/a.test.ts",
        [],
        ["assert x == 1", "assert y == 2", "expect(z).toEqual(3)"],
      ),
    ]),
    ["alert:assertions-deleted"],
  );
  // Refactoring assertions (same count in and out) fires nothing.
  assert.deepEqual(
    ids([file("tests/a.test.ts", ["expect(v).toBe(1)"], ["assert v == 1"])]),
    [],
  );
});

test("editing both code and its judging tests is a warn, tests alone are not", () => {
  assert.deepEqual(
    ids([
      file("src/auth/login.ts", ["x"]),
      file("tests/login.test.ts", ["expect(result).toBe(2)"]),
    ]),
    ["warn:judge-tests-edited"],
  );
  assert.deepEqual(ids([file("tests/login.test.ts", ["expect(result).toBe(2)"])]), []);
  assert.deepEqual(ids([file("src/auth/login.ts", ["const x = 1;"])]), []);
});

test("focus markers and junk assertions are caught (adversarial review C3/H4)", () => {
  assert.deepEqual(ids([file("tests/a.test.ts", ["describe.only('x', () => {})"])]), [
    "alert:tests-focused",
  ]);
  assert.deepEqual(ids([file("tests/a.test.ts", ["fit('y', () => {})"])]), [
    "alert:tests-focused",
  ]);
  // Deleting a real assertion while adding literal-equals-itself junk: the
  // net count stays flat, but the junk itself is now flagged.
  assert.deepEqual(
    ids([file("tests/a.test.ts", ["expect(true).toBe(true)"], ["expect(sum(2,2)).toBe(4)"])]),
    ["warn:trivial-assertions"],
  );
});

test("check-script indirection targets are machinery (adversarial review C2)", () => {
  const changed = [file("scripts/run-tests.sh", ["exit 0"])];
  assert.deepEqual(detectTripwires(changed), [], "unknown without context");
  const findings = detectTripwires(changed, {
    checkScriptTargets: ["scripts/run-tests.sh"],
  });
  assert.deepEqual(
    findings.map((f) => `${f.severity}:${f.id}`),
    ["alert:check-script-target-modified"],
  );
  // Makefile-style indirection is machinery outright.
  assert.deepEqual(ids([file("Makefile", ["test:", "\ttrue"])]), [
    "alert:check-machinery-modified",
  ]);
});

test("test-path classification covers the common conventions", () => {
  for (const testPath of [
    "tests/login.test.ts",
    "src/__tests__/a.tsx",
    "spec/models.rb",
    "pkg/thing_test.go",
    "test_models.py",
    "app/test_views.py",
    "src/LoginTest.java",
  ]) {
    assert.ok(isTestPath(testPath), `${testPath} should be a test path`);
  }
  for (const codePath of ["src/auth/login.ts", "docs/testing.md", "src/latest.ts"]) {
    assert.ok(!isTestPath(codePath), `${codePath} should NOT be a test path`);
  }
});

test("parseUnifiedDiff splits added/removed lines per file, handling renames and quotes", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-const x = 1;",
    "+const x = 2;",
    "diff --git a/old.ts b/new.ts",
    "similarity index 90%",
    "--- a/old.ts",
    "+++ b/new.ts",
    "@@ -5 +5 @@",
    "+renamed content",
    'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
    '--- "a/caf\\303\\251.ts"',
    '+++ "b/caf\\303\\251.ts"',
    "@@ -0,0 +1 @@",
    "+accent",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 3);
  assert.deepEqual(files[0], {
    path: "src/a.ts",
    addedLines: ["const x = 2;"],
    removedLines: ["const x = 1;"],
  });
  assert.equal(files[1]?.path, "new.ts");
  assert.deepEqual(files[1]?.addedLines, ["renamed content"]);
  assert.ok(files[2]?.addedLines.includes("accent"));
});

test("content lines starting ++/-- cannot hijack the file path (adversarial review M9)", () => {
  // An ADDED line whose content begins "++ " renders as "+++ …" in the
  // diff; inside a hunk it must stay content, not become a header that
  // detaches the malicious hunk from conftest.py.
  const diff = [
    "diff --git a/conftest.py b/conftest.py",
    "--- a/conftest.py",
    "+++ b/conftest.py",
    "@@ -1 +1,3 @@",
    "+++ innocent-looking",
    "+import sys",
    "--- also content",
    "-real_removed()",
  ].join("\n");
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "conftest.py");
  assert.deepEqual(files[0]?.addedLines, ["++ innocent-looking", "import sys"]);
  assert.deepEqual(files[0]?.removedLines, ["-- also content", "real_removed()"]);
  // And the machinery detector therefore still fires on the real path.
  assert.deepEqual(
    detectTripwires(files).map((f) => f.id),
    ["check-machinery-modified"],
  );
});

test("the adapter sees committed, uncommitted, and untracked changes alike", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "glp-trip-"));
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=T", "-c", "user.email=t@t", ...args],
      { cwd: dir, encoding: "utf8" },
    );
  git(["init", "-b", "main"]);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node t.js" } }));
  mkdirSync(path.join(dir, "tests"));
  writeFileSync(path.join(dir, "tests", "a.test.js"), "assert(1);\n");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  const baseSha = git(["rev-parse", "HEAD"]).trim();

  // Committed: gut the test script. Uncommitted: delete the assertion.
  // Untracked: a new conftest.py.
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "true" } }));
  git(["add", "package.json"]);
  git(["commit", "-m", "tamper"]);
  writeFileSync(path.join(dir, "tests", "a.test.js"), "// no assertions left\n");
  writeFileSync(path.join(dir, "conftest.py"), "import sys\n");

  const diffs = await collectChangedFileDiffs(dir, baseSha);
  const byPath = new Map(diffs.map((entry) => [entry.path, entry]));
  assert.ok(byPath.get("package.json")?.addedLines.join("").includes('"test":"true"'));
  assert.ok(byPath.get("tests/a.test.js")?.removedLines.join("").includes("assert(1)"));
  assert.ok(byPath.get("conftest.py")?.addedLines.join("").includes("import sys"));

  const result = await runTripwires(dir, baseSha);
  assert.ok(result.available);
  if (!result.available) {
    return;
  }
  const found = result.tripwires.map((finding) => finding.id).sort();
  // judge-tests-edited also fires: package.json counts as non-test change
  // alongside the gutted test file — a warn, correctly.
  assert.deepEqual(found, [
    "assertions-deleted",
    "check-machinery-modified",
    "check-script-modified",
    "judge-tests-edited",
  ]);

  const broken = await runTripwires(dir, "not-a-sha");
  assert.ok(!broken.available, "an unreadable diff degrades to unavailable, never to clean");
});
