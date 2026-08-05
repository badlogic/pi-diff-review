import assert from "node:assert/strict";
import test from "node:test";
import { buildAiReviewResultState } from "../web/ai-review-result-state.js";

const approvalPacket = {
  summary: "The implementation is ready for review.",
  body: "The changed behavior is covered by focused tests.",
  reviewedChapters: ["contract", "cleanup"],
  acceptedRisks: ["A manual release check remains."],
  unresolvedFindings: [],
  suggestedVerdict: "approve",
};

test("completed zero-finding analysis remains an explicit result", () => {
  assert.deepEqual(
    buildAiReviewResultState({
      aiReview: { status: "done", message: "AI review complete." },
      aiReviewCompleted: true,
      analysis: { findings: [], approvalPacket },
    }),
    {
      lifecycle: "complete",
      statusLabel: "AI review complete",
      message: "AI review complete.",
      progress: null,
      findingCount: 0,
      reviewedAreaCount: 2,
      verdict: "approve",
      verdictLabel: "Approve",
      summary: "The implementation is ready for review.",
      body: "The changed behavior is covered by focused tests.",
      acceptedRisks: ["A manual release check remains."],
      unresolvedFindings: [],
    },
  );
});

test("a restored completion bit preserves a zero-finding result", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "idle", message: "AI analysis complete." },
    aiReviewCompleted: true,
    analysis: { findings: [], approvalPacket },
  });
  assert.equal(result.lifecycle, "complete");
  assert.equal(result.findingCount, 0);
  assert.equal(result.verdictLabel, "Approve");
});

test("validated findings and request-changes verdict are counted", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "done" },
    aiReviewCompleted: true,
    analysis: {
      findings: [{ id: "finding-1" }, { id: "finding-2" }],
      approvalPacket: { ...approvalPacket, suggestedVerdict: "request-changes" },
    },
  });
  assert.equal(result.findingCount, 2);
  assert.equal(result.verdictLabel, "Request changes");
});

test("unresolved finding IDs resolve to human review details", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "done" },
    analysis: {
      findings: [{
        id: "normalize-allow-list-urls",
        title: "Normalize allow-list URLs to hosts",
        severity: "medium",
        confidence: "high",
        locations: [{ fileId: "src/config.ts", side: "modified", line: 12 }],
      }],
      approvalPacket: { ...approvalPacket, unresolvedFindings: ["normalize-allow-list-urls"] },
    },
  });

  assert.deepEqual(result.unresolvedFindings, [{
    id: "normalize-allow-list-urls",
    title: "Normalize allow-list URLs to hosts",
    severity: "medium",
    confidence: "high",
    hasLocation: true,
  }]);
});

test("unknown saved finding IDs remain readable", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "done" },
    analysis: {
      findings: [],
      approvalPacket: { ...approvalPacket, unresolvedFindings: ["legacy_unknown-id"] },
    },
  });

  assert.deepEqual(result.unresolvedFindings, [{
    id: "legacy_unknown-id",
    title: "Legacy unknown id",
    severity: "unknown",
    confidence: "unknown",
    hasLocation: false,
  }]);
});

test("running analysis suppresses stale completion details", () => {
  const result = buildAiReviewResultState({
    aiReview: {
      status: "running",
      message: "Validating findings...",
      progress: { phase: "validation" },
    },
    aiReviewCompleted: false,
    analysis: { findings: [{ id: "finding-1" }], approvalPacket },
  });
  assert.equal(result.lifecycle, "running");
  assert.equal(result.statusLabel, "AI review in progress");
  assert.equal(result.findingCount, 1);
  assert.equal(result.verdict, null);
  assert.equal(result.summary, "");
  assert.equal(result.body, "");
  assert.deepEqual(result.acceptedRisks, []);
  assert.deepEqual(result.unresolvedFindings, []);
});

test("failure takes precedence over the completion persistence bit", () => {
  const result = buildAiReviewResultState({
    aiReview: { status: "failed", message: "The model request timed out." },
    aiReviewCompleted: true,
    analysis: { findings: [{ id: "partial-finding" }], approvalPacket },
  });
  assert.equal(result.lifecycle, "failed");
  assert.equal(result.statusLabel, "AI review incomplete");
  assert.equal(result.message, "The model request timed out.");
  assert.equal(result.findingCount, 1);
  assert.equal(result.verdict, null);
  assert.equal(result.summary, "");
});

test("idle analysis is queued and has safe empty values", () => {
  const result = buildAiReviewResultState({});
  assert.equal(result.lifecycle, "queued");
  assert.equal(result.statusLabel, "AI review queued");
  assert.equal(result.message, "AI analysis will run in the background.");
  assert.equal(result.findingCount, 0);
  assert.equal(result.reviewedAreaCount, 0);
  assert.equal(result.verdictLabel, "");
});
