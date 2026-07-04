import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/adapters/db/db";
import { createNewProject } from "../src/adapters/db/repos/projects";

const TEST_GIT_IDENTITY = { name: "Galapagos Tests", email: "tests@galapagos.local" };

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
  await assert.rejects(
    () => createNewProject(db, { name: "   ", devRoot, gitIdentity: TEST_GIT_IDENTITY }),
    /name is required/,
  );
});
