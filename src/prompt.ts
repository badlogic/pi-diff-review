import type { DiffReviewComment, DiffReviewFile, ReviewSubmitPayload } from "./types.js";

function formatLocation(comment: DiffReviewComment, filePath: string): string {
  if (comment.side === "file" || comment.startLine == null) {
    return filePath;
  }
  const suffix = comment.side === "original" ? " (old)" : " (new)";
  if (comment.endLine != null && comment.endLine !== comment.startLine) {
    return `${filePath}:${comment.startLine}-${comment.endLine}${suffix}`;
  }
  return `${filePath}:${comment.startLine}${suffix}`;
}

export function composeReviewPrompt(files: DiffReviewFile[], payload: ReviewSubmitPayload): string {
  const fileMap = new Map(files.map((file) => [file.id, file]));
  const lines: string[] = [];

  const overallComment = payload.overallComment.trim();
  const hasFeedback = overallComment.length > 0 || payload.comments.length > 0;
  if (hasFeedback) {
    lines.push("Address the following code review feedback:");
    lines.push("");
  }

  if (overallComment.length > 0) {
    lines.push(overallComment);
    lines.push("");
  }

  payload.comments.forEach((comment, index) => {
    const file = fileMap.get(comment.fileId);
    const filePath = file?.displayPath ?? comment.fileId;
    lines.push(`${index + 1}. ${formatLocation(comment, filePath)}`);
    lines.push(`   ${comment.body.trim()}`);
    lines.push("");
  });

  return lines.join("\n").trim();
}
