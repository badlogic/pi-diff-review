import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getRepoRoot, getRevisionDiffReviewData } from "../git.js";
import type { DiffSourceAdapter, GitHubPullRequestMetadata, ReviewDataset } from "./types.js";

const COMMAND_TIMEOUT_MS = 120_000;

export interface GitHubPrRef {
  owner: string;
  repo: string;
  number: number;
  url: string;
}

export interface GitHubPrPrivateRefs {
  baseRef: string;
  headRef: string;
}

interface GitHubPrRevisions {
  baseRevision: string;
  headRevision: string;
}

interface GitHubRemoteRef {
  owner: string;
  repo: string;
}

interface GhPrViewResponse {
  number?: number;
  title?: string;
  body?: string | null;
  author?: { login?: string } | null;
  baseRefName?: string;
  headRefName?: string;
  headRepositoryOwner?: { login?: string } | null;
  isDraft?: boolean;
  state?: string;
  url?: string;
}

export function parseGitHubPrUrl(value: string): GitHubPrRef {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Expected a github.com PR URL.");
  }

  if (url.hostname !== "github.com") {
    throw new Error("Expected a github.com PR URL.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull") {
    throw new Error("Expected URL path /owner/repo/pull/number.");
  }

  const [owner, repo, _pull, rawNumber] = parts;
  if (owner == null || repo == null || rawNumber == null || owner.length === 0 || repo.length === 0) {
    throw new Error("Expected URL path /owner/repo/pull/number.");
  }

  if (!/^[1-9]\d*$/.test(rawNumber)) {
    throw new Error("Expected a positive integer pull request number.");
  }

  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Expected a positive integer pull request number.");
  }

  return {
    owner,
    repo,
    number,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

function safeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.\.+/g, "-");
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    return sanitized.replace(/\./g, "-") || "-";
  }
  return sanitized;
}

export function buildPrPrivateRefs(ref: GitHubPrRef): GitHubPrPrivateRefs {
  const namespace = `refs/pi-diff-review-cockpit/github/${safeSegment(ref.owner)}/${safeSegment(ref.repo)}/pr/${ref.number}`;
  return {
    baseRef: `${namespace}/base`,
    headRef: `${namespace}/head`,
  };
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

async function run(pi: ExtensionAPI, cwd: string, command: string, args: string[]): Promise<string> {
  const result = await pi.exec(command, args, { cwd, timeout: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) {
    const output = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(`Failed to run ${formatCommand(command, args)} in ${cwd}: ${output}`);
  }
  return result.stdout;
}

function parseGitHubRemotePath(path: string): GitHubRemoteRef | null {
  const cleanedPath = path.replace(/^\/+/, "").replace(/\.git$/, "");
  const [owner, repo] = cleanedPath.split("/");
  if (owner == null || repo == null || owner.length === 0 || repo.length === 0) {
    return null;
  }
  return { owner, repo };
}

function parseGitHubRemoteUrl(value: string): GitHubRemoteRef | null {
  const trimmed = value.trim();
  const scpLikePrefix = "git@github.com:";
  if (trimmed.startsWith(scpLikePrefix)) {
    return parseGitHubRemotePath(trimmed.slice(scpLikePrefix.length));
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") {
      return null;
    }
    return parseGitHubRemotePath(url.pathname);
  } catch {
    return null;
  }
}

function sameGitHubRepo(left: GitHubRemoteRef, right: GitHubRemoteRef): boolean {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}

async function verifyOriginMatchesPr(pi: ExtensionAPI, repoRoot: string, ref: GitHubPrRef): Promise<void> {
  const remoteUrl = (await run(pi, repoRoot, "git", ["remote", "get-url", "origin"])).trim();
  const remoteRef = parseGitHubRemoteUrl(remoteUrl);
  if (remoteRef == null) {
    throw new Error(`Current checkout origin must be a github.com URL for ${ref.owner}/${ref.repo} before reviewing this PR. Found origin: ${remoteUrl || "(empty)"}.`);
  }

  if (!sameGitHubRepo(remoteRef, ref)) {
    throw new Error(`Current checkout origin is ${remoteRef.owner}/${remoteRef.repo}, but PR URL is for ${ref.owner}/${ref.repo}. Run /diff-review pr from the matching checkout.`);
  }
}

async function readPrMetadata(pi: ExtensionAPI, cwd: string, ref: GitHubPrRef): Promise<GitHubPullRequestMetadata> {
  const output = await run(pi, cwd, "gh", [
    "pr",
    "view",
    ref.url,
    "--json",
    "number,title,body,author,baseRefName,headRefName,headRepositoryOwner,isDraft,state,url",
  ]);

  let parsed: GhPrViewResponse;
  try {
    parsed = JSON.parse(output) as GhPrViewResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse gh PR metadata: ${message}`);
  }

  if (!Number.isInteger(parsed.number) || parsed.number !== ref.number) {
    throw new Error(`GitHub metadata did not match PR #${ref.number}.`);
  }
  if (typeof parsed.title !== "string" || parsed.title.length === 0) {
    throw new Error("GitHub PR metadata is missing a title.");
  }
  if (typeof parsed.baseRefName !== "string" || parsed.baseRefName.length === 0) {
    throw new Error("GitHub PR metadata is missing a base branch.");
  }
  if (typeof parsed.headRefName !== "string" || parsed.headRefName.length === 0) {
    throw new Error("GitHub PR metadata is missing a head branch.");
  }

  return {
    owner: ref.owner,
    repo: ref.repo,
    number: parsed.number,
    url: typeof parsed.url === "string" && parsed.url.length > 0 ? parsed.url : ref.url,
    title: parsed.title,
    body: parsed.body ?? "",
    author: parsed.author?.login ?? "",
    baseRefName: parsed.baseRefName,
    headRefName: parsed.headRefName,
    headRepositoryOwner: parsed.headRepositoryOwner?.login ?? "",
    isDraft: parsed.isDraft ?? false,
    state: parsed.state ?? "",
  };
}

async function preparePrRefs(pi: ExtensionAPI, repoRoot: string, ref: GitHubPrRef, metadata: GitHubPullRequestMetadata): Promise<GitHubPrPrivateRefs> {
  const privateRefs = buildPrPrivateRefs(ref);

  await run(pi, repoRoot, "git", ["fetch", "origin", `+refs/heads/${metadata.baseRefName}:${privateRefs.baseRef}`]);
  await run(pi, repoRoot, "git", ["fetch", "origin", `+pull/${ref.number}/head:${privateRefs.headRef}`]);

  return privateRefs;
}

async function resolvePrRevisions(pi: ExtensionAPI, repoRoot: string, privateRefs: GitHubPrPrivateRefs): Promise<GitHubPrRevisions> {
  const baseRevision = (await run(pi, repoRoot, "git", ["rev-parse", "--verify", `${privateRefs.baseRef}^{commit}`])).trim();
  const headRevision = (await run(pi, repoRoot, "git", ["rev-parse", "--verify", `${privateRefs.headRef}^{commit}`])).trim();
  if (baseRevision.length === 0 || headRevision.length === 0) {
    throw new Error("Fetched GitHub PR refs did not resolve to immutable commits.");
  }
  return { baseRevision, headRevision };
}

export async function buildGitHubPrReviewDataset(pi: ExtensionAPI, ctx: ExtensionCommandContext, url: string): Promise<ReviewDataset> {
  const ref = parseGitHubPrUrl(url);
  const repoRoot = await getRepoRoot(pi, ctx.cwd);
  await verifyOriginMatchesPr(pi, repoRoot, ref);
  const metadata = await readPrMetadata(pi, repoRoot, ref);
  const privateRefs = await preparePrRefs(pi, repoRoot, ref, metadata);
  const revisions = await resolvePrRevisions(pi, repoRoot, privateRefs);
  const data = await getRevisionDiffReviewData(pi, repoRoot, revisions.baseRevision, revisions.headRevision);

  return {
    repoRoot,
    workingRoot: repoRoot,
    files: data.files,
    analysisFileIds: data.files.filter((file) => file.inGitDiff).map((file) => file.id),
    commits: data.commits,
    source: {
      kind: "github-pr",
      label: `PR #${metadata.number}: ${metadata.title}`,
      repoRoot,
      workingRoot: repoRoot,
      baseRevision: revisions.baseRevision,
      headRevision: revisions.headRevision,
      github: metadata,
      canPublishGitHubReview: true,
    },
  };
}

export const githubPrSourceAdapter: DiffSourceAdapter = {
  name: "github-pr",
  matches(args: string[]): boolean {
    return args[0] === "pr" && typeof args[1] === "string";
  },
  async build(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string[]): Promise<ReviewDataset> {
    const url = args[1];
    if (url == null) {
      throw new Error("Usage: /diff-review pr <github-pr-url>");
    }
    return buildGitHubPrReviewDataset(pi, ctx, url);
  },
};
