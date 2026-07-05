import test from "node:test";
import assert from "node:assert/strict";
import {
  checkLane,
  findLaneOverlap,
  globsCouldOverlap,
} from "../src/core/lanes/lane-check";

test("in-lane files pass, out-of-lane files are not_allowed", () => {
  const contract = { allowedGlobs: ["src/auth/**"], forbiddenGlobs: [] };
  assert.deepEqual(checkLane(["src/auth/login.ts", "src/auth/deep/nested/form.tsx"], contract), []);
  assert.deepEqual(checkLane(["src/billing/invoice.ts"], contract), [
    { path: "src/billing/invoice.ts", reason: "not_allowed" },
  ]);
});

test("forbidden globs win over allowed globs", () => {
  const contract = { allowedGlobs: ["src/**"], forbiddenGlobs: ["src/**/*.env", "src/secrets/**"] };
  assert.deepEqual(checkLane(["src/app/config.env"], contract), [
    { path: "src/app/config.env", reason: "forbidden", glob: "src/**/*.env" },
  ]);
  assert.deepEqual(checkLane(["src/secrets/keys.ts"], contract), [
    { path: "src/secrets/keys.ts", reason: "forbidden", glob: "src/secrets/**" },
  ]);
  assert.deepEqual(checkLane(["src/app/main.ts"], contract), []);
});

test("glob matrix: extensions, single-star depth, braces, literals", () => {
  const byExtension = { allowedGlobs: ["src/**/*.ts"], forbiddenGlobs: [] };
  assert.deepEqual(checkLane(["src/a/b.ts"], byExtension), []);
  assert.deepEqual(
    checkLane(["src/a/b.css"], byExtension),
    [{ path: "src/a/b.css", reason: "not_allowed" }],
  );

  const singleLevel = { allowedGlobs: ["src/*.ts"], forbiddenGlobs: [] };
  assert.deepEqual(checkLane(["src/top.ts"], singleLevel), []);
  assert.deepEqual(
    checkLane(["src/nested/deep.ts"], singleLevel),
    [{ path: "src/nested/deep.ts", reason: "not_allowed" }],
  );

  const braces = { allowedGlobs: ["src/{ui,core}/**"], forbiddenGlobs: [] };
  assert.deepEqual(checkLane(["src/ui/x.tsx", "src/core/y.ts"], braces), []);
  assert.deepEqual(
    checkLane(["src/daemon/z.ts"], braces),
    [{ path: "src/daemon/z.ts", reason: "not_allowed" }],
  );

  const literal = { allowedGlobs: ["README.md"], forbiddenGlobs: [] };
  assert.deepEqual(checkLane(["README.md"], literal), []);
  assert.deepEqual(
    checkLane(["docs/README.md"], literal),
    [{ path: "docs/README.md", reason: "not_allowed" }],
  );
});

test("dotfiles are governed like any other file", () => {
  const contract = { allowedGlobs: ["src/**"], forbiddenGlobs: [] };
  assert.deepEqual(
    checkLane([".github/workflows/ci.yml"], contract),
    [{ path: ".github/workflows/ci.yml", reason: "not_allowed" }],
  );
  assert.deepEqual(checkLane(["src/.env.example"], contract), []);
});

test("paths are normalized before matching; blanks are skipped", () => {
  const contract = { allowedGlobs: ["src/**"], forbiddenGlobs: [] };
  assert.deepEqual(checkLane(["./src/a.ts", "src\\win\\b.ts", "/src/c.ts", "  ", ""], contract), []);
});

test("an empty allowed list makes every change a violation", () => {
  assert.deepEqual(checkLane(["any.ts"], { allowedGlobs: [], forbiddenGlobs: [] }), [
    { path: "any.ts", reason: "not_allowed" },
  ]);
});

test("overlap: identical and nested directory globs collide", () => {
  assert.ok(globsCouldOverlap("src/auth/**", "src/auth/**"));
  assert.ok(globsCouldOverlap("src/**", "src/auth/**"));
  assert.ok(globsCouldOverlap("src/auth/**", "src/**"));
  assert.ok(globsCouldOverlap("**", "src/anything/**"), "a root glob overlaps everything");
});

test("overlap: disjoint directories do not collide", () => {
  assert.equal(globsCouldOverlap("src/auth/**", "src/billing/**"), false);
  assert.equal(globsCouldOverlap("docs/**", "src/**"), false);
  assert.equal(
    globsCouldOverlap("src/auth-ui/**", "src/auth/**"),
    false,
    "sibling dirs sharing a name prefix are not nested",
  );
});

test("overlap: literal-vs-glob pairs are answered exactly", () => {
  assert.ok(globsCouldOverlap("src/auth/login.ts", "src/auth/**"));
  assert.equal(globsCouldOverlap("src/billing/invoice.ts", "src/auth/**"), false);
  assert.ok(globsCouldOverlap("src/utils.ts", "src/*.ts"));
  assert.equal(globsCouldOverlap("src/utils.ts", "src/*.css"), false);
  assert.ok(globsCouldOverlap("README.md", "README.md"));
  assert.equal(globsCouldOverlap("README.md", "CHANGELOG.md"), false);
});

test("overlap: same base with different extensions is conservatively rejected", () => {
  // Documented approximation: glob-vs-glob compares static bases only, so
  // src/**/*.ts and src/**/*.css collide even though no file matches both.
  // Refusing a spawn is the safe error; lanes should split by directory.
  assert.ok(globsCouldOverlap("src/**/*.ts", "src/**/*.css"));
});

test("findLaneOverlap names the colliding pair across lists", () => {
  assert.deepEqual(
    findLaneOverlap(["docs/**", "src/auth/**"], ["src/**", "scripts/**"]),
    { candidateGlob: "src/auth/**", existingGlob: "src/**" },
  );
  assert.equal(findLaneOverlap(["docs/**"], ["src/**", "scripts/**"]), null);
});
