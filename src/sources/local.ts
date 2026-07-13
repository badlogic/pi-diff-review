import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getReviewWindowData } from "../git.js";
import type { ReviewDataset, DiffSourceAdapter } from "./types.js";

function selectLocalAnalysisFileIds(files: ReviewDataset["files"]): string[] {
  const diffFileIds = files.filter((file) => file.inGitDiff).map((file) => file.id);
  if (diffFileIds.length > 0) return diffFileIds;

  const lastCommitFileIds = files.filter((file) => file.inLastCommit).map((file) => file.id);
  if (lastCommitFileIds.length > 0) return lastCommitFileIds;

  return files.filter((file) => file.hasWorkingTreeFile).map((file) => file.id);
}

export async function buildLocalReviewDataset(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReviewDataset> {
  const data = await getReviewWindowData(pi, ctx.cwd);
  return {
    repoRoot: data.repoRoot,
    workingRoot: data.repoRoot,
    files: data.files,
    analysisFileIds: selectLocalAnalysisFileIds(data.files),
    commits: data.commits,
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: data.repoRoot,
      workingRoot: data.repoRoot,
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
  };
}

export const localSourceAdapter: DiffSourceAdapter = {
  name: "local",
  matches(args: string[]): boolean {
    return args.length === 0;
  },
  build: buildLocalReviewDataset,
};
