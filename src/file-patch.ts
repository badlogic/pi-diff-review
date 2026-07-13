import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRepositoryTextFile } from "./repository-text.js";
import type { ReviewFile } from "./types.js";

const PATCH_COMMAND_TIMEOUT_MS = 120_000;

function gitFailure(file: ReviewFile, args: string[], result: { code: number; stdout: string; stderr: string }): Error {
  const diagnostics = result.stderr.trim() || result.stdout.trim() || "Git produced no diagnostics.";
  return new Error(
    `Cannot load patch for "${file.path}": git ${args.join(" ")} exited with code ${result.code}: ${diagnostics}`,
  );
}

function rootAwareCommitPatchArgs(revision: string, paths: string[]): string[] {
  return ["show", "--format=", "--no-color", "--unified=80", revision, "--", ...paths];
}

export interface ReviewFilePatchLoaderOptions {
  repoRoot: string;
  workingRoot: string;
  revisionDiff?: {
    baseRevision: string;
    headRevision: string;
  };
}

export function createReviewFilePatchLoader(
  pi: ExtensionAPI,
  options: ReviewFilePatchLoaderOptions,
): (file: ReviewFile) => Promise<string> {
  return async (file) => {
    const comparison = file.gitDiff ?? file.lastCommit ?? Object.values(file.commitComparisons)[0] ?? null;
    if (comparison == null) return "";
    const paths = [...new Set([
      comparison.oldPath,
      comparison.newPath,
      file.path,
    ].filter((path): path is string => path != null && path.length > 0))];
    if (paths.length === 0) {
      throw new Error(`Cannot load patch for "${file.path}": the comparison has no file paths.`);
    }
    const isGitDiff = file.gitDiff === comparison;
    const isLastCommit = file.lastCommit === comparison;

    const args = isGitDiff
      ? options.revisionDiff == null
        ? ["diff", "--no-color", "--unified=80", "HEAD", "--", ...paths]
        : ["diff", "--no-color", "--unified=80", `${options.revisionDiff.baseRevision}...${options.revisionDiff.headRevision}`, "--", ...paths]
      : isLastCommit
        ? rootAwareCommitPatchArgs(options.revisionDiff?.headRevision ?? "HEAD", paths)
        : ["diff", "--no-color", "--unified=80", "HEAD", "--", ...paths];
    const result = await pi.exec("git", args, {
      cwd: options.revisionDiff == null ? options.workingRoot : options.repoRoot,
      timeout: PATCH_COMMAND_TIMEOUT_MS,
    });
    if (result.code === 0 && result.stdout.length > 0) {
      return result.stdout;
    }
    if (result.code !== 0) {
      throw gitFailure(file, args, result);
    }
    if (isGitDiff && comparison.status === "added" && comparison.oldPath == null && comparison.newPath != null) {
      if (options.revisionDiff != null) {
        const showArgs = ["show", `${options.revisionDiff.headRevision}:${comparison.newPath}`];
        const showResult = await pi.exec("git", showArgs, {
          cwd: options.repoRoot,
          timeout: PATCH_COMMAND_TIMEOUT_MS,
        });
        if (showResult.code !== 0) {
          throw gitFailure(file, showArgs, showResult);
        }
        if (showResult.stdout.length > 0) return showResult.stdout;
        throw new Error(
          `Cannot load patch for "${file.path}": git ${showArgs.join(" ")} succeeded but returned empty content after an empty git diff.`,
        );
      }
      return readRepositoryTextFile(options.workingRoot, comparison.newPath);
    }
    throw new Error(
      `Cannot load patch for "${file.path}": git ${args.join(" ")} succeeded but returned an empty patch for a represented change.`,
    );
  };
}
