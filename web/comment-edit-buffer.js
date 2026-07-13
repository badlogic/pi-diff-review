export function createCommentEditBuffer() {
  const edits = new Map();

  const begin = (comment) => {
    let edit = edits.get(comment.id);
    if (!edit) {
      const originalBody = String(comment.body || "");
      edit = { originalBody, draftBody: originalBody };
      edits.set(comment.id, edit);
    }
    return edit;
  };

  const bodyFor = (comment) => edits.get(comment.id)?.draftBody ?? String(comment.body || "");

  return {
    begin,
    update(comment, body) {
      begin(comment).draftBody = String(body);
    },
    bodyFor,
    snapshot(comments) {
      return comments.map((comment) => ({ ...comment, body: bodyFor(comment) }));
    },
    save(comment) {
      const edit = begin(comment);
      const body = edit.draftBody.trim();
      edits.delete(comment.id);
      if (!body) return { deleteComment: true };
      comment.body = body;
      return { deleteComment: false };
    },
    cancel(comment) {
      const edit = edits.get(comment.id);
      if (!edit) return { deleteComment: !String(comment.body || "").trim() };
      edits.delete(comment.id);
      comment.body = edit.originalBody;
      return { deleteComment: !edit.originalBody.trim() };
    },
    remove(commentId) {
      edits.delete(commentId);
    },
  };
}
