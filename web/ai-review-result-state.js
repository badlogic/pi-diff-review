const verdictLabels = Object.freeze({
  approve: "Approve",
  comment: "Comment",
  "request-changes": "Request changes",
});

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function lifecycleFor(aiReview, aiReviewCompleted) {
  if (aiReview?.status === "failed") return "failed";
  if (aiReview?.status === "running") return "running";
  if (aiReview?.status === "done" || aiReviewCompleted === true) return "complete";
  return "queued";
}

function statusLabelFor(lifecycle) {
  return {
    queued: "AI review queued",
    running: "AI review in progress",
    complete: "AI review complete",
    failed: "AI review incomplete",
  }[lifecycle];
}

function defaultMessageFor(lifecycle) {
  return {
    queued: "AI analysis will run in the background.",
    running: "AI review is running.",
    complete: "AI review complete.",
    failed: "AI review failed before producing a complete result.",
  }[lifecycle];
}

export function buildAiReviewResultState(input = {}) {
  const aiReview = input.aiReview || {};
  const analysis = input.analysis || {};
  const approvalPacket = analysis.approvalPacket || {};
  const lifecycle = lifecycleFor(aiReview, input.aiReviewCompleted);
  const complete = lifecycle === "complete";
  const verdict = complete && verdictLabels[approvalPacket.suggestedVerdict]
    ? approvalPacket.suggestedVerdict
    : null;

  return {
    lifecycle,
    statusLabel: statusLabelFor(lifecycle),
    message: typeof aiReview.message === "string" && aiReview.message.length > 0
      ? aiReview.message
      : defaultMessageFor(lifecycle),
    progress: aiReview.progress || null,
    findingCount: Array.isArray(analysis.findings) ? analysis.findings.length : 0,
    reviewedAreaCount: complete ? stringArray(approvalPacket.reviewedChapters).length : 0,
    verdict,
    verdictLabel: verdict ? verdictLabels[verdict] : "",
    summary: complete && typeof approvalPacket.summary === "string" ? approvalPacket.summary : "",
    body: complete && typeof approvalPacket.body === "string" ? approvalPacket.body : "",
    acceptedRisks: complete ? stringArray(approvalPacket.acceptedRisks) : [],
    unresolvedFindings: complete ? stringArray(approvalPacket.unresolvedFindings) : [],
  };
}
