export function unresolvedThreadCount(context) {
  return (context?.threads ?? []).filter((thread) => !thread.isResolved && !thread.isOutdated).length;
}

export function threadItemsForFilter(context, filter) {
  const threads = context?.threads ?? [];
  if (filter === "open") {
    return threads.filter((thread) => !thread.isResolved && !thread.isOutdated).map((item) => ({ kind: "thread", item }));
  }
  return [
    ...threads.map((item) => ({ kind: "thread", item })),
    ...(context?.reviews ?? []).map((item) => ({ kind: "review", item })),
    ...(context?.conversationComments ?? []).map((item) => ({ kind: "conversation", item })),
  ];
}

export function locateCurrentThread(thread, options) {
  if (thread.isOutdated || options.context.reviewedHeadSha !== options.context.remoteHeadSha) return null;
  const line = thread.side === "original" ? thread.originalLine : thread.line;
  if (thread.side == null || !Number.isInteger(line) || line < 1) return null;
  const files = options.filesByPath.get(thread.path) ?? [];
  if (files.length !== 1) return null;
  const lineCount = thread.side === "original" ? options.originalLineCount : options.modifiedLineCount;
  if (line > lineCount) return null;
  return { fileId: files[0].id, side: thread.side, line };
}

export function createGitHubThreadDisclosureState() {
  const collapsed = new Set();
  return {
    isExpanded: (id) => !collapsed.has(id),
    collapse: (id) => collapsed.add(id),
    expand: (id) => collapsed.delete(id),
    toggle: (id) => collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id),
  };
}
