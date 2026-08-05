/**
 * @param {{
 *   path: string,
 *   contents?: { originalContent: string, modifiedContent: string } | null,
 *   error?: string | null,
 *   requestId?: string | null,
 * }} state
 */
export function fileLoadView({ path, contents = null, error = null, requestId = null }) {
  if (contents) return { kind: "ready", contents };
  if (error) {
    return {
      kind: "error",
      title: `Could not load ${path}`,
      message: error,
    };
  }
  return {
    kind: "loading",
    title: `Loading ${path}`,
    message: requestId ? "Fetching both sides of the diff." : "Waiting to request this file.",
  };
}

/** @param {string | undefined} pendingRequestId @param {string} replyRequestId */
export function isCurrentFileReply(pendingRequestId, replyRequestId) {
  return typeof pendingRequestId === "string" && pendingRequestId === replyRequestId;
}
