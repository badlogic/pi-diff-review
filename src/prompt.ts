import type { DiffReviewComment, ReviewFile, ReviewScope, ReviewSubmitPayload } from "./types.js";

function formatScopeLabel(scope: ReviewScope, baseRef: string): string {
  switch (scope) {
    case "base-branch": return `base branch (${baseRef})`;
    case "git-diff": return "git diff";
    case "last-commit": return "last commit";
    default: return "all files";
  }
}

function getCommentFilePath(file: ReviewFile | undefined, scope: ReviewScope): string {
  if (file == null) return "(unknown file)";
  const comparison = scope === "base-branch"
    ? file.baseBranch
    : scope === "git-diff"
      ? file.gitDiff
      : scope === "last-commit"
        ? file.lastCommit
        : null;
  return comparison?.displayPath ?? file.path;
}

function formatLocation(comment: DiffReviewComment, file: ReviewFile | undefined, baseRef: string): string {
  const filePath = getCommentFilePath(file, comment.scope);
  const scopePrefix = `[${formatScopeLabel(comment.scope, baseRef)}] `;

  if (comment.side === "file" || comment.startLine == null) {
    return `${scopePrefix}${filePath}`;
  }

  const range = comment.endLine != null && comment.endLine !== comment.startLine
    ? `${comment.startLine}-${comment.endLine}`
    : `${comment.startLine}`;

  if (comment.scope === "all-files") {
    return `${scopePrefix}${filePath}:${range}`;
  }

  const suffix = comment.side === "original" ? " (old)" : " (new)";
  return `${scopePrefix}${filePath}:${range}${suffix}`;
}

export function composeReviewPrompt(files: ReviewFile[], payload: ReviewSubmitPayload, baseRef: string): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  lines.push("Please address the following feedback");
  lines.push("");
  lines.push(`Primary compare base: ${baseRef}`);
  lines.push("");

  const overallComment = payload.overallComment.trim();
  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push("");
  }

  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    lines.push(`${index + 1}. ${formatLocation(comment, file, baseRef)}`);
    lines.push(`   ${comment.body.trim()}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}
