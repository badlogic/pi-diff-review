import { extname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRepositoryTextFile } from "./repository-text.js";
import type { ChangeStatus, ReviewFile, ReviewFileComparison, ReviewFileContents, ReviewLineRange, ReviewScope } from "./types.js";

interface ChangedPath {
  status: ChangeStatus;
  oldPath: string | null;
  newPath: string | null;
}

interface ReviewFileSeed {
  path: string;
  worktreeStatus: ChangeStatus | null;
  hasWorkingTreeFile: boolean;
  inGitDiff: boolean;
  inLastCommit: boolean;
  gitDiff: ReviewFileComparison | null;
  lastCommit: ReviewFileComparison | null;
  commitComparisons: Record<string, ReviewFileComparison>;
}

interface CommentableLineRanges {
  original: ReviewLineRange[];
  modified: ReviewLineRange[];
}

interface DiffLineStats {
  added: number;
  deleted: number;
}

export type ReviewGitDiffMode = "working-tree" | "index";

export interface ReviewWindowDataOptions {
  gitDiffMode?: ReviewGitDiffMode;
  revisionDiff?: {
    baseRevision: string;
    headRevision: string;
  };
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

function parseDiffPath(value: string, prefix: "a/" | "b/"): string | null {
  const path = value.trimEnd();
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function addCommentableLine(ranges: ReviewLineRange[], line: number): void {
  if (line <= 0) return;
  const previous = ranges[ranges.length - 1];
  if (previous != null && previous.end + 1 === line) {
    previous.end = line;
    return;
  }
  ranges.push({ start: line, end: line });
}

function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match == null) return null;

  return {
    oldStart: Number.parseInt(match[1] ?? "0", 10),
    oldCount: Number.parseInt(match[2] ?? "1", 10),
    newStart: Number.parseInt(match[3] ?? "0", 10),
    newCount: Number.parseInt(match[4] ?? "1", 10),
  };
}

export interface CanonicalPatchHunk {
  header: string;
  symbol: string | null;
  originalRanges: ReviewLineRange[];
  modifiedRanges: ReviewLineRange[];
  patch: string;
}

export function parseCanonicalPatchHunks(output: string): CanonicalPatchHunk[] {
  const lines = output.split(/\r?\n/);
  const hunks: CanonicalPatchHunk[] = [];
  let current: CanonicalPatchHunk | null = null;
  let originalLine = 0;
  let modifiedLine = 0;

  const finish = (): void => {
    if (current != null) hunks.push(current);
    current = null;
  };

  for (const line of lines) {
    const hunk = parseHunkHeader(line);
    if (hunk != null) {
      finish();
      const markerEnd = line.indexOf("@@", 2);
      const symbol = markerEnd < 0 ? "" : line.slice(markerEnd + 2).trim();
      current = {
        header: line,
        symbol: symbol.length > 0 ? symbol : null,
        originalRanges: [],
        modifiedRanges: [],
        patch: line,
      };
      originalLine = hunk.oldStart;
      modifiedLine = hunk.newStart;
      continue;
    }
    if (current == null) continue;
    current.patch += `\n${line}`;
    if (line.startsWith(" ")) {
      originalLine += 1;
      modifiedLine += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      addCommentableLine(current.originalRanges, originalLine++);
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      addCommentableLine(current.modifiedRanges, modifiedLine++);
    } else if (!line.startsWith("\\ No newline at end of file")) {
      finish();
    }
  }
  finish();
  return hunks;
}

function parseCommentableLineRanges(output: string): Map<string, CommentableLineRanges> {
  const rangesByPath = new Map<string, CommentableLineRanges>();
  let current: {
    oldPath: string | null;
    newPath: string | null;
    ranges: CommentableLineRanges;
  } | null = null;
  let originalLine: number | null = null;
  let modifiedLine: number | null = null;

  const finishCurrentFile = (): void => {
    if (current == null) return;

    const paths = uniquePaths([current.newPath, current.oldPath].filter((path): path is string => path != null));
    for (const path of paths) {
      rangesByPath.set(path, current.ranges);
    }
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      finishCurrentFile();
      current = {
        oldPath: null,
        newPath: null,
        ranges: { original: [], modified: [] },
      };
      originalLine = null;
      modifiedLine = null;
      continue;
    }

    if (current == null) continue;

    const hunk = parseHunkHeader(line);
    if (hunk != null) {
      originalLine = hunk.oldStart;
      modifiedLine = hunk.newStart;
      continue;
    }

    if (originalLine != null && modifiedLine != null) {
      if (line.startsWith(" ")) {
        originalLine += 1;
        modifiedLine += 1;
      } else if (line.startsWith("-")) {
        addCommentableLine(current.ranges.original, originalLine);
        originalLine += 1;
      } else if (line.startsWith("+")) {
        addCommentableLine(current.ranges.modified, modifiedLine);
        modifiedLine += 1;
      } else if (!line.startsWith("\\ No newline at end of file")) {
        originalLine = null;
        modifiedLine = null;
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      current.oldPath = parseDiffPath(line.slice(4), "a/");
      continue;
    }

    if (line.startsWith("+++ ")) {
      current.newPath = parseDiffPath(line.slice(4), "b/");
      continue;
    }
  }

  finishCurrentFile();
  return rangesByPath;
}

function parseNumstatCount(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const count = Number.parseInt(value, 10);
  return Number.isSafeInteger(count) ? count : null;
}

function parseDiffLineStats(output: string): Map<string, DiffLineStats> {
  const statsByPath = new Map<string, DiffLineStats>();
  const records = output.split("\0");

  for (let index = 0; index < records.length;) {
    const record = records[index++] ?? "";
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;

    const added = parseNumstatCount(record.slice(0, firstTab));
    const deleted = parseNumstatCount(record.slice(firstTab + 1, secondTab));
    const inlinePath = record.slice(secondTab + 1);
    if (added == null || deleted == null) continue;
    const stats = { added, deleted };

    if (inlinePath.length > 0) {
      statsByPath.set(inlinePath, stats);
      continue;
    }

    const oldPath = records[index++] ?? "";
    const newPath = records[index++] ?? "";
    if (oldPath.length > 0) statsByPath.set(oldPath, stats);
    if (newPath.length > 0) statsByPath.set(newPath, stats);
  }

  return statsByPath;
}

function countLineRanges(ranges: ReviewLineRange[]): number {
  return ranges.reduce((total, range) => total + range.end - range.start + 1, 0);
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

function toComparison(change: ChangedPath, commentableLines?: CommentableLineRanges, stats?: DiffLineStats): ReviewFileComparison {
  const path = change.newPath ?? change.oldPath ?? toDisplayPath(change);
  const anchorStats = commentableLines == null
    ? null
    : {
        added: countLineRanges(commentableLines.modified),
        deleted: countLineRanges(commentableLines.original),
      };
  if (stats != null && anchorStats == null && (stats.added > 0 || stats.deleted > 0)) {
    throw new Error(`Diff metadata for ${path} is inconsistent: canonical numstat has changed lines, but patch anchors are missing.`);
  }
  if (stats == null && anchorStats != null && (anchorStats.added > 0 || anchorStats.deleted > 0)) {
    throw new Error(`Diff metadata for ${path} is inconsistent: patch anchors have changed lines, but canonical numstat is missing.`);
  }
  if (commentableLines != null && stats != null) {
    if (anchorStats?.added !== stats.added || anchorStats.deleted !== stats.deleted) {
      throw new Error(
        `Diff metadata for ${path} is inconsistent: patch anchors are +${anchorStats?.added ?? 0} -${anchorStats?.deleted ?? 0}, but numstat is +${stats.added} -${stats.deleted}.`,
      );
    }
  }

  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
    ...(stats == null ? {} : { addedLines: stats.added, deletedLines: stats.deleted }),
    ...(commentableLines == null
      ? {}
      : {
          commentableOriginalLines: commentableLines.original,
          commentableModifiedLines: commentableLines.modified,
        }),
  };
}

function buildReviewFileId(path: string, hasWorkingTreeFile: boolean, gitDiff: ReviewFileComparison | null, lastCommit: ReviewFileComparison | null): string {
  return [
    path,
    hasWorkingTreeFile ? "working" : "gone",
    gitDiff?.displayPath ?? "",
    lastCommit?.displayPath ?? "",
  ].join("::");
}

function parseCommitLog(output: string): { sha: string; shortSha: string; subject: string }[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", ...subjectParts] = line.split("\t");
      return { sha, shortSha, subject: subjectParts.join("\t") };
    })
    .filter((commit) => commit.sha.length > 0);
}

function createReviewFile(seed: ReviewFileSeed): ReviewFile {
  return {
    id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit),
    path: seed.path,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
    commitComparisons: seed.commitComparisons,
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
  return readRepositoryTextFile(repoRoot, path);
}

async function getIndexContent(pi: ExtensionAPI, repoRoot: string, path: string): Promise<string> {
  const result = await pi.exec("git", ["show", `:${path}`], { cwd: repoRoot });
  if (result.code !== 0) {
    return "";
  }
  return result.stdout;
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

export async function getReviewWindowData(pi: ExtensionAPI, cwd: string, options: ReviewWindowDataOptions = {}): Promise<{ repoRoot: string; files: ReviewFile[]; commits: { sha: string; shortSha: string; subject: string }[] }> {
  const repoRoot = await getRepoRoot(pi, cwd);
  const repositoryHasHead = await hasHead(pi, repoRoot);
  const gitDiffMode = options.gitDiffMode ?? "working-tree";
  const diffModeArgs = gitDiffMode === "index" ? ["--cached"] : [];

  const trackedDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", ...diffModeArgs, "--find-renames", "-M", "--name-status", "HEAD", "--"])
    : "";
  const commentableDiffOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", ...diffModeArgs, "--find-renames", "-M", "--no-color", "HEAD", "--"])
    : "";
  const diffstatOutput = repositoryHasHead
    ? await runGit(pi, repoRoot, ["diff", ...diffModeArgs, "--find-renames", "-M", "--numstat", "-z", "HEAD", "--"])
    : "";
  const untrackedOutput = gitDiffMode === "working-tree"
    ? await runGitAllowFailure(pi, repoRoot, ["ls-files", "--others", "--exclude-standard"])
    : "";
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-files", "--cached"]);
  const deletedFilesOutput = gitDiffMode === "working-tree"
    ? await runGitAllowFailure(pi, repoRoot, ["ls-files", "--deleted"])
    : "";
  const lastCommitOutput = repositoryHasHead
    ? await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
    : "";
  const commits = repositoryHasHead
    ? parseCommitLog(await runGitAllowFailure(pi, repoRoot, ["log", "--max-count=50", "--format=%H%x09%h%x09%s"]))
    : [];
  const commitChanges = new Map<string, ChangedPath[]>();
  for (const commit of commits) {
    const output = await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", commit.sha]);
    commitChanges.set(commit.sha, parseNameStatus(output).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  }

  const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), parseUntrackedPaths(untrackedOutput))
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const commentableLinesByPath = parseCommentableLineRanges(commentableDiffOutput);
  const diffstatsByPath = parseDiffLineStats(diffstatOutput);
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
      inGitDiff: false,
      inLastCommit: false,
      gitDiff: null,
      lastCommit: null,
      commitComparisons: {},
    });
  }

  for (const change of worktreeChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null,
      inGitDiff: false,
      inLastCommit: false,
      gitDiff: null,
      lastCommit: null,
      commitComparisons: {},
    }));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    const changedPath = change.newPath ?? change.oldPath ?? "";
    seed.gitDiff = toComparison(change, commentableLinesByPath.get(changedPath), diffstatsByPath.get(changedPath));
  }

  for (const change of lastCommitChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
      inGitDiff: false,
      inLastCommit: false,
      gitDiff: null,
      lastCommit: null,
      commitComparisons: {},
    }));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change);
  }

  for (const [commitSha, changes] of commitChanges) {
    for (const change of changes) {
      const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const seed = upsertSeed(seeds, key, () => ({
        path: key,
        worktreeStatus: null,
        hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
        inGitDiff: false,
        inLastCommit: false,
        gitDiff: null,
        lastCommit: null,
        commitComparisons: {},
      }));
      seed.commitComparisons[commitSha] = toComparison(change);
    }
  }

  const files = [...seeds.values()]
    .map(createReviewFile)
    .sort(compareReviewFiles);

  return { repoRoot, files, commits };
}

export async function getRevisionDiffReviewData(
  pi: ExtensionAPI,
  repoRoot: string,
  baseRevision: string,
  headRevision: string,
): Promise<{ repoRoot: string; files: ReviewFile[]; commits: { sha: string; shortSha: string; subject: string }[] }> {
  const diffRange = `${baseRevision}...${headRevision}`;
  const trackedDiffOutput = await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--name-status", diffRange, "--"]);
  const commentableDiffOutput = await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--no-color", diffRange, "--"]);
  const diffstatOutput = await runGit(pi, repoRoot, ["diff", "--find-renames", "-M", "--numstat", "-z", diffRange, "--"]);
  const trackedFilesOutput = await runGitAllowFailure(pi, repoRoot, ["ls-tree", "-r", "--name-only", headRevision]);
  const lastCommitOutput = await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", headRevision]);
  const commits = parseCommitLog(await runGitAllowFailure(pi, repoRoot, ["log", "--max-count=50", "--format=%H%x09%h%x09%s", `${baseRevision}..${headRevision}`]));
  const commitChanges = new Map<string, ChangedPath[]>();
  for (const commit of commits) {
    const output = await runGitAllowFailure(pi, repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", commit.sha]);
    commitChanges.set(commit.sha, parseNameStatus(output).filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
  }

  const diffChanges = parseNameStatus(trackedDiffOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));
  const commentableLinesByPath = parseCommentableLineRanges(commentableDiffOutput);
  const diffstatsByPath = parseDiffLineStats(diffstatOutput);
  const currentPaths = parseTrackedPaths(trackedFilesOutput).filter(isReviewableFilePath);
  const lastCommitChanges = parseNameStatus(lastCommitOutput)
    .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? ""));

  const seeds = new Map<string, ReviewFileSeed>();

  for (const path of currentPaths) {
    seeds.set(path, {
      path,
      worktreeStatus: null,
      hasWorkingTreeFile: true,
      inGitDiff: false,
      inLastCommit: false,
      gitDiff: null,
      lastCommit: null,
      commitComparisons: {},
    });
  }

  for (const change of diffChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null,
      inGitDiff: false,
      inLastCommit: false,
      gitDiff: null,
      lastCommit: null,
      commitComparisons: {},
    }));
    seed.worktreeStatus = change.status;
    seed.hasWorkingTreeFile = change.newPath != null;
    seed.inGitDiff = true;
    const changedPath = change.newPath ?? change.oldPath ?? "";
    seed.gitDiff = toComparison(change, commentableLinesByPath.get(changedPath), diffstatsByPath.get(changedPath));
  }

  for (const change of lastCommitChanges) {
    const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
    const seed = upsertSeed(seeds, key, () => ({
      path: key,
      worktreeStatus: null,
      hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
      inGitDiff: false,
      inLastCommit: false,
      gitDiff: null,
      lastCommit: null,
      commitComparisons: {},
    }));
    seed.inLastCommit = true;
    seed.lastCommit = toComparison(change);
  }

  for (const [commitSha, changes] of commitChanges) {
    for (const change of changes) {
      const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const seed = upsertSeed(seeds, key, () => ({
        path: key,
        worktreeStatus: null,
        hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
        inGitDiff: false,
        inLastCommit: false,
        gitDiff: null,
        lastCommit: null,
        commitComparisons: {},
      }));
      seed.commitComparisons[commitSha] = toComparison(change);
    }
  }

  const files = [...seeds.values()]
    .map(createReviewFile)
    .sort(compareReviewFiles);

  return { repoRoot, files, commits };
}

export async function loadReviewFileContents(pi: ExtensionAPI, repoRoot: string, file: ReviewFile, scope: ReviewScope, commitSha?: string, options: ReviewWindowDataOptions = {}): Promise<ReviewFileContents> {
  const gitDiffMode = options.gitDiffMode ?? "working-tree";
  const revisionDiff = options.revisionDiff;

  if (scope === "all-files") {
    const content = file.hasWorkingTreeFile
      ? revisionDiff != null
        ? await getRevisionContent(pi, repoRoot, revisionDiff.headRevision, file.path)
        : gitDiffMode === "index"
        ? await getIndexContent(pi, repoRoot, file.path)
        : await getWorkingTreeContent(repoRoot, file.path)
      : "";
    return {
      originalContent: content,
      modifiedContent: content,
    };
  }

  const comparison = scope === "git-diff" ? file.gitDiff : scope === "commit" && commitSha ? file.commitComparisons[commitSha] : file.lastCommit;
  if (comparison == null) {
    return {
      originalContent: "",
      modifiedContent: "",
    };
  }

  const originalRevision = scope === "git-diff"
    ? revisionDiff?.baseRevision ?? "HEAD"
    : scope === "commit" && commitSha
      ? `${commitSha}^`
      : revisionDiff != null
        ? `${revisionDiff.headRevision}^`
        : "HEAD^";
  const modifiedRevision = scope === "git-diff"
    ? revisionDiff?.headRevision ?? null
    : scope === "commit" && commitSha
      ? commitSha
      : revisionDiff?.headRevision ?? "HEAD";

  const originalContent = comparison.oldPath == null ? "" : await getRevisionContent(pi, repoRoot, originalRevision, comparison.oldPath);
  const modifiedContent = comparison.newPath == null
    ? ""
    : scope === "git-diff" && revisionDiff == null && gitDiffMode === "index"
      ? await getIndexContent(pi, repoRoot, comparison.newPath)
    : modifiedRevision == null
      ? await getWorkingTreeContent(repoRoot, comparison.newPath)
      : await getRevisionContent(pi, repoRoot, modifiedRevision, comparison.newPath);

  return {
    originalContent,
    modifiedContent,
  };
}
