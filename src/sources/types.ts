import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewCommit, ReviewFile } from "../types.js";

export type ReviewSourceKind =
  | "local-working-tree"
  | "last-commit"
  | "commit"
  | "all-files"
  | "github-pr";

export interface GitHubPullRequestMetadata {
  owner: string;
  repo: string;
  number: number;
  url: string;
  title: string;
  body: string;
  author: string;
  baseRefName: string;
  headRefName: string;
  headRepositoryOwner: string;
  isDraft: boolean;
  state: string;
}

export interface ReviewSourceMetadata {
  kind: ReviewSourceKind;
  label: string;
  repoRoot: string;
  workingRoot: string;
  baseRevision: string | null;
  headRevision: string | null;
  github?: GitHubPullRequestMetadata;
  canPublishGitHubReview: boolean;
}

export interface ReviewDataset {
  repoRoot: string;
  workingRoot: string;
  files: ReviewFile[];
  analysisFileIds: string[];
  commits: ReviewCommit[];
  source: ReviewSourceMetadata;
}

export interface DiffSourceAdapter {
  name: string;
  matches(args: string[]): boolean;
  build(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<ReviewDataset>;
}
