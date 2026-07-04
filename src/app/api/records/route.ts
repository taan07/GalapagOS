import { NextResponse } from "next/server";
import { getProject } from "../../../adapters/db/repos/projects";
import { createRecordsStore, type RecordDoc } from "../../../adapters/records/store";
import { readDb } from "../../../server/read-db";
import type { RecordView } from "../../../ui/types";

export const dynamic = "force-dynamic";

const BASE_KEYS = new Set([
  "id",
  "glp_type",
  "title",
  "status",
  "project",
  "created_at",
  "updated_at",
  "written_by",
]);

// Source attribution is non-negotiable (architecture §9): every field says
// where it physically comes from; missing data renders as missing upstream.
function toView(doc: RecordDoc): RecordView {
  const fieldSources: Record<string, string> = {
    id: "frontmatter:id",
    type: "frontmatter:glp_type",
    title: "frontmatter:title",
    status: "frontmatter:status",
    createdAt: "frontmatter:created_at",
    updatedAt: "frontmatter:updated_at",
    writtenBy: "frontmatter:written_by",
    body: "markdown body",
  };
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc.frontmatter)) {
    if (!BASE_KEYS.has(key)) {
      extra[key] = value;
      fieldSources[key] = `frontmatter:${key}`;
    }
  }
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    writtenBy: doc.writtenBy,
    body: doc.body,
    sourceFile: doc.filePath,
    fieldSources,
    extra,
  };
}

export async function GET(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required." }, { status: 400 });
  }
  const project = getProject(readDb(), projectId);
  if (!project) {
    return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
  }
  const store = createRecordsStore(project.root_path, project.slug);
  const records = store.list().map(toView);
  return NextResponse.json(
    { records, recordsRoot: `${project.root_path}/docs/galapagos` },
    { headers: { "Cache-Control": "no-store" } },
  );
}
