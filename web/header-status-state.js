const compactAiLabels = Object.freeze({
  done: "AI done",
  running: "AI running",
  failed: "AI failed",
  queued: "AI queued",
});

/** @param {{ detail?: string, aiStatus?: string, reviewed?: number, total?: number, staged?: number }} input */
export function buildHeaderStatusState(input = {}) {
  const total = Math.max(0, Number(input.total || 0));
  const reviewed = Math.max(0, Math.min(total, Number(input.reviewed || 0)));
  const staged = Math.max(0, Number(input.staged || 0));
  const progress = `${reviewed}/${total} reviewed · ${staged} staged`;
  const detail = typeof input.detail === "string" ? input.detail.trim() : "";
  return {
    compact: `${compactAiLabels[input.aiStatus] || "AI ready"} · ${progress}`,
    accessibleLabel: detail ? `${detail} · ${progress}` : progress,
  };
}

/** @param {number} count */
export function githubThreadLabel(count) {
  const safeCount = Math.max(0, Number(count || 0));
  if (safeCount === 0) return null;
  return `${safeCount} thread${safeCount === 1 ? "" : "s"}`;
}
