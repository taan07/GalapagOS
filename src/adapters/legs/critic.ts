// I/O for the critic leg: assemble the BLINDED review packet — the brief
// record, the lane contract, the user's agreed specifics, the real diff vs
// the lane base, and the execution evidence; never the worker's narrative,
// claims, or transcript — run the single-shot critique on
// GALAPAGOS_CRITIC_MODEL, and persist the verdict as a jobs row (kind
// "critic") keyed to the workspace evidence state.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GalapagosConfig } from "../../config";
import {
  buildCriticPrompt,
  CRITIC_SYSTEM_PROMPT,
  parseCriticVerdict,
  type CriticFinding,
} from "../../core/legs/critic";
import { parseStatusPorcelain } from "../../core/git/parsers";
import type { GalapagosDb } from "../db/db";
import { createJob, failJob, finishJob, startJob } from "../db/repos/jobs";
import { laneGlobs, type LaneRow } from "../db/repos/lanes";
import { latestRunsByKey } from "../db/repos/evidence";
import type { ProjectRow } from "../db/repos/projects";
import type { WorkerRow } from "../db/repos/workers";
import { observeWorkspaceEvidence } from "../evidence/workspace";
import { LocalGitCommandRunner } from "../git/runner";
import { createRecordsStore } from "../records/store";
import { runSingleShotReview } from "./session";

export type CriticJobResult = {
  verdict: "approve" | "needs_work" | "reject";
  summary: string;
  findings: CriticFinding[];
  evidenceKey: string;
  digestId: string;
  workerId: string;
};

const UNTRACKED_RENDER_LIMIT = 16 * 1024;

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
  const job = createJob(db, "critic", {
    workerId: worker.id,
    digestId: input.digestId,
    projectId: project.id,
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
    const prompt = buildCriticPrompt({
      briefTitle: brief.title,
      briefBody: brief.body,
      laneName: input.lane.name,
      allowedGlobs: globs.allowedGlobs,
      forbiddenGlobs: globs.forbiddenGlobs,
      agreedSpecifics,
      evidenceSummary,
      diffText,
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
