export function applyAuthoritativePublishedCommentState(comments, publishedComments) {
  const authoritativeById = new Map((publishedComments || []).map((comment) => [comment.id, comment]));
  const appliedIds = new Set();
  const merged = (comments || []).map((comment) => {
    const authoritative = authoritativeById.get(comment.id);
    if (!authoritative) return comment;
    appliedIds.add(comment.id);
    return { ...authoritative };
  });
  for (const comment of publishedComments || []) {
    if (!appliedIds.has(comment.id)) merged.push({ ...comment });
  }
  return merged;
}
