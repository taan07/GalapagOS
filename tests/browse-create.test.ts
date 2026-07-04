import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { browseDirectory } from "../src/server/browse";
import { openDb } from "../src/adapters/db/db";
import { createNewProject } from "../src/adapters/db/repos/projects";

const TEST_GIT_IDENTITY = { name: "Galapagos Tests", email: "tests@galapagos.local" };

// Browse is home-bounded, so fixtures must live under the real home dir;
// each test removes its fixture in finally.
function tmpHomeDir(): string {
  return mkdtempSync(path.join(os.homedir(), ".glp-browse-test-"));
}

test("browseDirectory lists subfolders with git and registered badges", () => {
  const root = tmpHomeDir();
  try {
    mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
    mkdirSync(path.join(root, "beta"));
    mkdirSync(path.join(root, ".hidden"));
    mkdirSync(path.join(root, "node_modules"));

    const result = browseDirectory({
      requestedPath: root,
      devRoot: root,
      registeredPaths: new Set([path.join(root, "beta")]),
    });

    assert.deepEqual(
      result.entries.map((entry) => [entry.name, entry.isGitRepo, entry.isRegistered]),
      [
        ["alpha", true, false],
        ["beta", false, true],
      ],
    );
    assert.equal(result.parent, path.dirname(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browseDirectory refuses paths outside the home directory", () => {
  const root = tmpHomeDir();
  try {
    assert.throws(
      () => browseDirectory({ requestedPath: "/etc", devRoot: root, registeredPaths: new Set() }),
      /limited to your home directory/,
    );
    assert.throws(
      () =>
        browseDirectory({
          requestedPath: path.join(root, "missing"),
          devRoot: root,
          registeredPaths: new Set(),
        }),
      /Not a directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createNewProject scaffolds folder, README, git history, and registration", async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "glp-state-"));
  const devRoot = mkdtempSync(path.join(os.tmpdir(), "glp-dev-"));
  const db = openDb(stateDir);

  const project = await createNewProject(db, {
    name: "Mali Test App",
    devRoot,
    gitIdentity: TEST_GIT_IDENTITY,
  });

  assert.equal(project.name, "Mali Test App");
  assert.equal(project.root_path, path.join(devRoot, "Mali Test App"));
  assert.ok(existsSync(path.join(project.root_path, ".git")));
  assert.equal(readFileSync(path.join(project.root_path, "README.md"), "utf8"), "# Mali Test App\n");

  await assert.rejects(
    () => createNewProject(db, { name: "Mali Test App", devRoot, gitIdentity: TEST_GIT_IDENTITY }),
    /already exists/,
  );
  await assert.rejects(
    () => createNewProject(db, { name: "../escape", devRoot, gitIdentity: TEST_GIT_IDENTITY }),
    /cannot start with a dot or contain/,
  );
  await assert.rejects(
    () => createNewProject(db, { name: ".sneaky", devRoot, gitIdentity: TEST_GIT_IDENTITY }),
    /cannot start with a dot/,
  );
});
