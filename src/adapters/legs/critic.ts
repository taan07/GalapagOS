// I/O for the critic leg: assemble the BLINDED review packet — the brief
// record, the lane contract, the user's agreed specifics, the real diff vs
// the lane base, and the execution evidence; never the worker's narrative,
// claims, or transcript — run the single-shot critique on
// GALAPAGOS_CRITIC_MODEL, and persist the verdict as a jobs row (kind
// "critic") keyed to the workspace evidence state.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GalapagosConfig } from "../../config";
import {
  buildCriticPrompt,
  CRITIC_SYSTEM_PROMPT,
  parseCriticVerdict,
  type CriticFinding,
} from "../../core/legs/critic";
import { isTestPath } from "../../core/legs/tripwires";
import { parseStatusPorcelain } from "../../core/git/parsers";
import type { GalapagosDb } from "../db/db";
import { createJob, failJob, finishJob, startJob } from "../db/repos/jobs";
import { laneGlobs, type LaneRow } from "../db/repos/lanes";
import { evidenceRunsKey, latestRunsByKey } from "../db/repos/evidence";
import type { ProjectRow } from "../db/repos/projects";
import type { WorkerRow } from "../db/repos/workers";
import { observeWorkspaceEvidence } from "../evidence/workspace";
import { LocalGitCommandRunner } from "../git/runner";
import { createRecordsStore } from "../records/store";
import { collectAuditFiles } from "../agent/worker-runtime";
import { runSingleShotReview } from "./session";

export type CriticJobResult = {
  verdict: "approve" | "needs_work" | "reject";
  summary: string;
  findings: CriticFinding[];
  evidenceKey: string;
  /** The evidence pool the critique weighed — a new check run stales it. */
  runsKey: string;
  digestId: string;
  workerId: string;
};

const UNTRACKED_RENDER_LIMIT = 16 * 1024;
const REFERENCE_TEST_LIMIT = 8 * 1024;
const REFERENCE_TEST_MAX_FILES = 3;
const WALK_MAX_ENTRIES = 500;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-node", "build", ".next", "vendor"]);

/**
 * Unchanged test files that exercise the changed code (found live
 * 2026-07-05: the diff alone left the critic unable to see what the tests
 * assert, forcing blind skepticism). Heuristic: test files whose content
 * mentions a changed non-test file's basename. Bounded walk, bounded reads.
 */
function collectReferenceTests(
  worktreePath: string,
  changedPaths: string[],
): { path: string; content: string }[] {
  const changedBasenames = changedPaths
    .filter((p) => !isTestPath(p))
    .map((p) => path.basename(p).replace(/\.[^.]+$/, ""))
    .filter((name) => name.length > 2 && name !== "index");
  if (changedBasenames.length === 0) {
    return [];
  }
  const changed = new Set(changedPaths);

  const testFiles: string[] = [];
  let scanned = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || scanned > WALK_MAX_ENTRIES || testFiles.length > 40) {
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(path.join(worktreePath, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      scanned += 1;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          walk(relative, depth + 1);
        }
      } else if (isTestPath(relative) && !changed.has(relative)) {
        testFiles.push(relative);
      }
    }
  };
  walk("", 0);

  const references: { path: string; content: string }[] = [];
  for (const testFile of testFiles) {
    if (references.length >= REFERENCE_TEST_MAX_FILES) {
      break;
    }
    try {
      const content = readFileSync(path.join(worktreePath, testFile), "utf8").slice(
        0,
        REFERENCE_TEST_LIMIT,
      );
      if (content.includes("\0")) {
        continue;
      }
      if (changedBasenames.some((name) => content.includes(name))) {
        references.push({ path: testFile, content });
      }
    } catch {
      // Unreadable reference: skipped, never fabricated.
    }
  }
  return references;
}

/** The real diff vs the lane base, with untracked files appended honestly. */
async function collectReviewDiff(worktreePath: string, baseSha: string): Promise<string> {
  const runner = new LocalGitCommandRunner();
  const [diffText, porcelainOutput] = await Promise.all([
    runner.runGit(["diff", baseSha], worktreePath),
    runner.runGit(["status", "--porcelain=v1", "-z", "-uall"], worktreePath),
  ]);
  const parts = [diffText];
  for (const entry of parseStatusPorcelain(porcelainOutput).untrackedFiles) {
    if (!entry.path) {
      continue;
    }
    try {
      const content = readFileSync(path.join(worktreePath, entry.path), "utf8").slice(
        0,
        UNTRACKED_RENDER_LIMIT,
      );
      if (content.includes("\0")) {
        parts.push(`\n=== untracked (binary, not shown): ${entry.path} ===`);
        continue;
      }
      parts.push(`\n=== untracked new file: ${entry.path} ===\n${content}`);
    } catch {
      parts.push(`\n=== untracked (unreadable): ${entry.path} ===`);
    }
  }
  return parts.join("\n");
}

export async function runCriticReview(input: {
  db: GalapagosDb;
  config: GalapagosConfig;
  project: ProjectRow;
  worker: WorkerRow;
  lane: LaneRow | null;
  digestId: string;
}): Promise<{ ran: boolean; error: string | null }> {
  const { db, config, project, worker } = input;
  // The judged state goes in the PAYLOAD, before the run — a FAILED run
  // records what it failed against, so the leg re-arms when the workspace
  // or the evidence pool moves (coverage audit 2026-07-05).
  let payloadKey = "unobservable";
  try {
    payloadKey = (await observeWorkspaceEvidence(worker.worktree_path)).key;
  } catch {
    // Key stays "unobservable"; the run below fails loudly on its own.
  }
  const job = createJob(db, "critic", {
    workerId: worker.id,
    digestId: input.digestId,
    projectId: project.id,
    evidenceKey: payloadKey,
    runsKey: evidenceRunsKey(
      latestRunsByKey(db, { projectId: project.id, workerId: worker.id }),
    ),
  });
  startJob(db, job.id);

  try {
    if (!input.lane) {
      const reason = "The lane record is missing — the critic has no contract to judge against.";
      failJob(db, job.id, reason);
      return { ran: false, error: reason };
    }
    const store = createRecordsStore(project.root_path, project.slug);
    const brief = worker.brief_record_id ? store.get(worker.brief_record_id) : undefined;
    if (!brief) {
      // The brief IS the intent anchor; critique without it would be the
      // generic code-vibes review the research warns against.
      const reason = "The worker_brief record is missing — the critic cannot derive the checklist.";
      failJob(db, job.id, reason);
      return { ran: false, error: reason };
    }

    const agreedSpecifics = store
      .list({ type: "user_answer", status: "agreed" })
      .slice(-15)
      .map((doc) => ({
        question:
          typeof doc.frontmatter.question === "string" ? doc.frontmatter.question : doc.title,
        answer:
          typeof doc.frontmatter.answer === "string"
            ? doc.frontmatter.answer
            : doc.body.trim().slice(0, 300),
      }));

    const workspace = await observeWorkspaceEvidence(worker.worktree_path);
    const runs = latestRunsByKey(db, { projectId: project.id, workerId: worker.id });
    const evidenceSummary = Array.from(runs.values())
      .map(
        (run) =>
          `- ${run.check_key}: ${run.status} (${run.head_sha === workspace.key ? "fresh — matches the current state" : "STALE — predates the current state"}) — ${run.summary}`,
      )
      .join("\n");

    const globs = laneGlobs(input.lane);
    const diffText = await collectReviewDiff(worker.worktree_path, input.lane.base_sha);
    const changedPaths = await collectAuditFiles(worker.worktree_path, input.lane.base_sha);
    const referenceTests = collectReferenceTests(worker.worktree_path, changedPaths);
    const prompt = buildCriticPrompt({
      briefTitle: brief.title,
      briefBody: brief.body,
      laneName: input.lane.name,
      allowedGlobs: globs.allowedGlobs,
      forbiddenGlobs: globs.forbiddenGlobs,
      agreedSpecifics,
      evidenceSummary,
      diffText,
      changedFiles: changedPaths,
      referenceTests,
    });

    const response = await runSingleShotReview({
      config,
      cwd: worker.worktree_path,
      model: config.criticModel,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
      prompt,
    });
    if (!response.ok) {
      failJob(db, job.id, response.reason);
      return { ran: false, error: response.reason };
    }
    const parsed = parseCriticVerdict(response.text);
    if (!parsed.ok) {
      failJob(db, job.id, parsed.problem);
      return { ran: false, error: parsed.problem };
    }
    const result: CriticJobResult = {
      ...parsed.verdict,
      evidenceKey: workspace.key,
      runsKey: evidenceRunsKey(runs),
      digestId: input.digestId,
      workerId: worker.id,
    };
    finishJob(db, job.id, result);
    return { ran: true, error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    failJob(db, job.id, reason);
    return { ran: false, error: reason };
  }
}
