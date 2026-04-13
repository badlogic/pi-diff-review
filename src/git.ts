import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ReviewConfig } from "./config.js";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewScope } from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

interface ReviewFileSeed {
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inBaseBranch: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  baseBranch: ReviewFileComparison | null;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(message);
  }
  return result.stdout;
}

async function runGitAllowFailure(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<string> {
  const result = await pi.exec("git", args, { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

export async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.code !== 0) {
    throw new Error("Not inside a git repository.");
  }
  return result.stdout.trim();
}

async function hasHead(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
  const result = await pi.exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: repoRoot });
  return result.code === 0;
}

function parseNameStatus(output: string): ChangedPath[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const changes: ChangedPath[] = [];

  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];

    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) {
        changes.push({ status: "renamed", oldPath, newPath });
      }
      continue;
    }

    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "modified", oldPath: path, newPath: path });
      }
      continue;
    }

    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "added", oldPath: null, newPath: path });
      }
      continue;
    }

    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) {
        changes.push({ status: "deleted", oldPath: path, newPath: null });
      }
    }
  }

  return changes;
}

function parseUntrackedPaths(output: string): ChangedPath[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((path) => ({
      status: "added" as const,
      oldPath: null,
      newPath: path,
    }));
}

function parseTrackedPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function mergeChangedPaths(tracked: ChangedPath[], untracked: ChangedPath[]): ChangedPath[] {
  const seen = new Set(tracked.map((change) => `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`));
  const merged = [...tracked];

  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }

  return merged;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function toDisplayPath(change: ChangedPath): string {
  if (change.status === "renamed") {
    return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  }
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change: ChangedPath): ReviewFileComparison {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
  };
}

function buildReviewFileId(
  path: string,
  hasWorkingTreeFile: boolean,
  baseBranch: ReviewFileComparison | null,
  gitDiff: ReviewFileComparison | null,
  lastCommit: ReviewFileComparison | null,
): string {
  return [
    path,
    hasWorkingTreeFile ? "working" : "gone",
    baseBranch?.displayPath ?? "",
    gitDiff?.displayPath ?? "",
    lastCommit?.displayPath ?? "",
  ].join("::");
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.baseBranch, seed.gitDiff, seed.lastCommit),
    path: seed.path,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inBaseBranch: seed.inBaseBranch,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    baseBranch: seed.baseBranch,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
  };
}

async function getRevisionContent(pi: ExtensionAPI, repoRoot: string, revision: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `${revision}:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
}

async function getWorkingTreeContent(repoRoot: string, path: string): Promise<string> {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

function isReviewableFilePath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);

  if (fileName.length === 0) return false;

  const binaryExtensions = new Set([
    ".7z",
    ".a",
    ".avi",
    ".avif",
    ".bin",
    ".bmp",
    ".class",
    ".dll",
    ".dylib",
    ".eot",
    ".exe",
    ".gif",
    ".gz",
    ".ico",
    ".jar",
    ".jpeg",
    ".jpg",
    ".lockb",
    ".map",
    ".mov",
    ".mp3",
    ".mp4",
    ".o",
    ".otf",
    ".pdf",
    ".png",
    ".pyc",
    ".so",
    ".svgz",
    ".tar",
    ".ttf",
    ".wasm",
    ".webm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
  ]);

  if (binaryExtensions.has(extension)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;

  return true;
}

function compareReviewFiles(a: ReviewFile, b: ReviewFile): number {
  return a.path.localeCompare(b.path);
}

function upsertSeed(seeds: Map<string, ReviewFileSeed>, key: string, create: () => ReviewFileSeed): ReviewFileSeed {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = create();
  seeds.set(key, seed);
  return seed;
}

async function getRemoteNames(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
  const output = await runGitAllowFailure(pi, repoRoot, ["remote"]);
  return parseTrackedPaths(output);
}

async function maybeFetchRemote(pi: ExtensionAPI, repoRoot: string, remote: string, autoFetch: boolean): Promise<void> {
  if (!autoFetch || remote.length === 0) return;
  await runGitAllowFailure(pi, repoRoot, ["fetch", remote, "--prune"]);
}

async function getUpstreamRemoteName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
  const output = await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const upstream = output.trim();
  if (upstream.length === 0 || !upstream.includes("/")) return null;
  return upstream.split("/")[0] ?? null;
}

async function resolveDefaultBaseRef(pi: ExtensionAPI, repoRoot: string, autoFetch: boolean): Promise<string> {
  const remotes = await getRemoteNames(pi, repoRoot);
  const candidateOrder = [await getUpstreamRemoteName(pi, repoRoot), "origin", ...remotes]
    .filter((remote, index, all): remote is string => remote != null && remote.length > 0 && all.indexOf(remote) === index);

  for (const remote of candidateOrder) {
    await maybeFetchRemote(pi, repoRoot, remote, autoFetch);
    const symbolicRef = (await runGitAllowFailure(pi, repoRoot, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`])).trim();
    if (symbolicRef.length > 0) {
      return symbolicRef;
    }

    const revParseRef = (await runGitAllowFailure(pi, repoRoot, ["rev-parse", "--abbrev-ref", `${remote}/HEAD`])).trim();
    if (revParseRef.length > 0 && revParseRef !== `${remote}/HEAD`) {
      return revParseRef;
    }
  }

  throw new Error("Could not resolve the repository default remote branch. Set one explicitly with /diff-review-set-base <git-ref>.");
}

export async function resolveBaseRef(pi: ExtensionAPI, repoRoot: string, configuredBaseRef: string, autoFetch: boolean): Promise<string> {
  if (configuredBaseRef === "default") {
    return resolveDefaultBaseRef(pi, repoRoot, autoFetch);
  }

  const [remoteCandidate] = configuredBaseRef.split("/");
  const remotes = await getRemoteNames(pi, repoRoot);
  if (remoteCandidate != null && remotes.includes(remoteCandidate)) {
    await maybeFetchRemote(pi, repoRoot, remoteCandidate, autoFetch);
  }

  return configuredBaseRef;
}

async function getMergeBase(pi: ExtensionAPI, repoRoot: string, baseRef: string): Promise<string> {
  const output = await runGit(pi, repoRoot, ["merge-base", baseRef, "HEAD"]);
  return output.trim();
}

async function getBaseBranchNameStatus(pi: ExtensionAPI, repoRoot: string, config: ReviewConfig): Promise<string> {
  const mergeBase = await getMergeBase(pi, repoRoot, config.defaultBaseRef);
  return runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", mergeBase, "HEAD", "--"]);
}

export async function getReviewWindowData(
  pi: ExtensionAPI,
  cwd: string,
  config: ReviewConfig,
): Promise<{ repoRoot: string; files: ReviewFile[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);

  const baseBranchOutput = repositoryHasHead
    ? await getBaseBranchNameStatus(pi, repoRoot, config)
    : "";
  const trackedDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const untrackedOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"]);
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"]);
  const lastCommitOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
    : "";

  const baseBranchChanges = parseNameStatus(baseBranchOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), parseUntrackedPaths(untrackedOutput))
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
  const currentPaths = uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)])
    .filter((path) => !deletedPaths.has(path))
    .filter(isReviewableFilePath);
  const lastCommitChanges = parseNameStatus(lastCommitOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));

  const seeds = new Map<string, ReviewFileSeed>();

  for (const path of currentPaths) {
    seeds.set(path, {
      path,
      worktreeStatus: null,
      hasWorkingTreeFile: true,
      inBaseBranch: false,
      inGitDiff: false,
      inLastCommit: false,
      baseBranch: null,
      gitDiff: null,
      lastCommit: null,
    });
  }

  for (const change of baseBranchChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
      inBaseBranch: false,
      inGitDiff: false,
      inLastCommit: false,
      baseBranch: null,
      gitDiff: null,
      lastCommit: null,
    }));
    seed.inBaseBranch = true;
    seed.baseBranch = toComparison(change);
  }

  for (const change of worktreeChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null,
      inBaseBranch: false,
      inGitDiff: false,
      inLastCommit: false,
      baseBranch: null,
      gitDiff: null,
      lastCommit: null,
    }));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    seed.gitDiff = toComparison(change);
  }

  for (const change of lastCommitChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
      inBaseBranch: false,
      inGitDiff: false,
      inLastCommit: false,
      baseBranch: null,
      gitDiff: null,
      lastCommit: null,
    }));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change);
  }

  const files = [...seeds.values()]
    .map(createReviewFile)
    .sort(compareReviewFiles);

  return { repoRoot, files };
}

export async function loadReviewFileContents(
  pi: ExtensionAPI,
  repoRoot: string,
  file: ReviewFile,
  scope: ReviewScope,
  config: ReviewConfig,
): Promise<ReviewFileContents> {
  if (scope === "all-files") {
    const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
    return {
      originalContent: content,
      modifiedContent: content,
    };
  }

  if (scope === "base-branch") {
    const comparison = file.baseBranch;
    if (comparison == null) {
      return {
        originalContent: "",
        modifiedContent: "",
      };
    }

    const mergeBase = await getMergeBase(pi, repoRoot, config.defaultBaseRef);
    const originalContent = comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, mergeBase, comparison.oldPath);
    const modifiedContent = comparison.newPath == null ? "" : await getRevisionContent(pi, repoRoot, "HEAD", comparison.newPath);

    return {
      originalContent,
      modifiedContent,
    };
  }

  const comparison = scope === "git-diff" ? file.gitDiff : file.lastCommit;
  if (comparison == null) {
    return {
      originalContent: "",
      modifiedContent: "",
    };
  }

  const originalRevision = scope === "git-diff" ? "HEAD" : "HEAD^";
  const modifiedRevision = scope === "git-diff" ? null : "HEAD";

  const originalContent = comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : modifiedRevision == null
      ? await getWorkingTreeContent(repoRoot, comparison.newPath)
      : await getRevisionContent(pi, repoRoot, modifiedRevision, comparison.newPath);

  return {
    originalContent,
    modifiedContent,
  };
}
