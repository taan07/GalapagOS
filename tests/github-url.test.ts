import test from "node:test";
import assert from "node:assert/strict";
import { githubBlobUrl, githubBranchUrl, githubWebBase } from "../src/core/git/github-url";

test("githubWebBase normalizes SSH, scp, and HTTPS remotes to one web base", () => {
  const expected = "https://github.com/taan07/GalapagOS";
  assert.equal(githubWebBase("git@github.com:taan07/GalapagOS.git"), expected);
  assert.equal(githubWebBase("git@github.com:taan07/GalapagOS"), expected);
  assert.equal(githubWebBase("ssh://git@github.com/taan07/GalapagOS.git"), expected);
  assert.equal(githubWebBase("https://github.com/taan07/GalapagOS.git"), expected);
  assert.equal(githubWebBase("https://github.com/taan07/GalapagOS"), expected);
  assert.equal(githubWebBase("https://github.com/taan07/GalapagOS/"), expected);
  assert.equal(githubWebBase("  git@github.com:taan07/GalapagOS.git \n"), expected);
});

test("non-GitHub or unparseable remotes yield null, never a guess", () => {
  assert.equal(githubWebBase("git@gitlab.com:owner/repo.git"), null);
  assert.equal(githubWebBase("https://bitbucket.org/owner/repo"), null);
  assert.equal(githubWebBase("/Users/taan/some/local/bare.git"), null);
  assert.equal(githubWebBase(""), null);
  assert.equal(githubWebBase("https://github.com/owner-only"), null);
});

test("branch and blob links encode path segments but keep slashes", () => {
  const base = "https://github.com/taan07/GalapagOS";
  assert.equal(
    githubBranchUrl(base, "galapagos/worker/auth-ui"),
    `${base}/tree/galapagos/worker/auth-ui`,
  );
  assert.equal(
    githubBlobUrl(base, "main", "docs/galapagos/briefs/2026-07-09-auth.md"),
    `${base}/blob/main/docs/galapagos/briefs/2026-07-09-auth.md`,
  );
  // A space in a record filename must be encoded, not break the URL.
  assert.equal(
    githubBlobUrl(base, "main", "docs/galapagos/briefs/with space.md"),
    `${base}/blob/main/docs/galapagos/briefs/with%20space.md`,
  );
});
