import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewAnalysisJson } from "../src/analysis.js";
import * as aiReviewModule from "../src/ai-review.js";
import {
  applyValidationDecisions,
  createValidationFailureResult,
  normalizeChapterReviewJson,
  normalizeSynthesisJson,
  normalizeValidationDecisionsJson,
  refreshProgressFindingCounts,
} from "../src/ai-review.js";
import type { ReviewDataset } from "../src/sources/types.js";
import type { ReviewChapter } from "../src/types.js";

function dataset(): ReviewDataset {
  const path = "src/app/api/qa_api.py";
  return {
    repoRoot: "/repo",
    workingRoot: "/repo",
    commits: [],
    analysisFileIds: [path],
    source: {
      kind: "local-working-tree",
      label: "Local diff",
      repoRoot: "/repo",
      workingRoot: "/repo",
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
    files: [{
      id: path,
      path,
      worktreeStatus: "modified",
      hasWorkingTreeFile: true,
      inGitDiff: true,
      inLastCommit: false,
      gitDiff: {
        status: "modified",
        oldPath: path,
        newPath: path,
        displayPath: path,
        hasOriginal: true,
        hasModified: true,
        commentableOriginalLines: [{ start: 1, end: 1 }],
        commentableModifiedLines: [{ start: 1, end: 4 }],
      },
      lastCommit: null,
      commitComparisons: {},
    }],
  };
}

function chapter(): ReviewChapter {
  return {
    id: "qa-api",
    title: "QA labeling API",
    summary: "Review API changes.",
    reviewOrder: 1,
    reviewWeight: 100_000,
    priority: "review-first",
    attentionTags: ["API"],
    fileIds: ["src/app/api/qa_api.py"],
    ranges: [],
    findingIds: [],
  };
}

function analysisWithFinding(locations: Array<{
  fileId: string;
  path: string;
  side: "original" | "modified" | "file";
  line: number | null;
}>) {
  return parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [{
      id: "candidate",
      kind: "bug",
      severity: "medium",
      confidence: "high",
      title: "Candidate",
      explanation: "Candidate issue.",
      suggestedComment: "Candidate comment.",
      locations,
      status: "new",
    }],
  }), chapter()), dataset());
}

test("chapter review normalization ignores invalid model approval packet", () => {
  const modelOutput = {
    chapters: [{
      id: "different-id",
      title: "Different",
      summary: "Wrong shape.",
      priority: "low-attention",
      attentionTags: ["Wrong"],
      fileIds: ["not-real.py"],
      findingIds: ["missing-check"],
    }],
    findings: [{
      id: "missing-check",
      kind: "bug",
      severity: "medium",
      confidence: "high",
      title: "Validate request",
      explanation: "The diff calls the service without checking required input.",
      suggestedComment: "Should this validate the request before calling the service?",
      locations: [{
        fileId: "src/app/api/qa_api.py",
        path: "src/app/api/qa_api.py",
        side: "modified",
        line: 2,
      }],
      status: "new",
    }],
    approvalPacket: {
      summary: 123,
      reviewedChapters: ["not-real"],
      acceptedRisks: "invalid",
      unresolvedFindings: ["not-real-finding"],
      suggestedVerdict: "merge",
      body: null,
    },
  };

  const normalized = normalizeChapterReviewJson(JSON.stringify(modelOutput), chapter());
  const analysis = parseReviewAnalysisJson(normalized, dataset());

  assert.equal(analysis.chapters[0]?.id, "qa-api");
  assert.deepEqual(analysis.chapters[0]?.fileIds, ["src/app/api/qa_api.py"]);
  assert.deepEqual(analysis.approvalPacket.reviewedChapters, ["qa-api"]);
  assert.deepEqual(analysis.approvalPacket.unresolvedFindings, ["missing-check"]);
  assert.equal(analysis.findings[0]?.title, "Validate request");
});

test("chapter review normalization caps candidate findings", () => {
  const output = {
    findings: [
      {
        id: "first",
        kind: "bug",
        severity: "medium",
        confidence: "high",
        title: "First",
        explanation: "First issue.",
        suggestedComment: "First comment.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
        status: "new",
      },
      {
        id: "second",
        kind: "bug",
        severity: "medium",
        confidence: "high",
        title: "Second",
        explanation: "Second issue.",
        suggestedComment: "Second comment.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 3 }],
        status: "new",
      },
    ],
  };

  const normalized = normalizeChapterReviewJson(JSON.stringify(output), chapter(), 1);
  const analysis = parseReviewAnalysisJson(normalized, dataset());

  assert.deepEqual(analysis.findings.map((finding) => finding.id), ["first"]);
  assert.deepEqual(analysis.chapters[0]?.findingIds, ["first"]);
});

test("validation decisions drop and adjust candidate findings", () => {
  const analysis = parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [
      {
        id: "drop-me",
        kind: "question",
        severity: "medium",
        confidence: "low",
        title: "Speculative",
        explanation: "Maybe bad.",
        suggestedComment: "Maybe bad?",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
        status: "new",
      },
      {
        id: "adjust-me",
        kind: "bug",
        severity: "high",
        confidence: "medium",
        title: "Old title",
        explanation: "Old explanation.",
        suggestedComment: "Old comment.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 3 }],
        status: "new",
      },
    ],
  }), chapter()), dataset());
  const decisions = normalizeValidationDecisionsJson(JSON.stringify({
    decisions: [
      { id: "drop-me", action: "drop", reason: "Speculative." },
      {
        id: "adjust-me",
        action: "adjust",
        reason: "Too severe.",
        severity: "medium",
        confidence: "high",
        title: "New title",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 4 }],
      },
    ],
  }), new Set(analysis.findings.map((finding) => finding.id)));

  const validated = applyValidationDecisions(analysis, decisions, dataset());

  assert.deepEqual(validated.findings.map((finding) => finding.id), ["adjust-me"]);
  assert.equal(validated.findings[0]?.severity, "medium");
  assert.equal(validated.findings[0]?.confidence, "high");
  assert.equal(validated.findings[0]?.title, "New title");
  assert.deepEqual(validated.findings[0]?.locations, [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 4 }]);
  assert.deepEqual(validated.chapters[0]?.findingIds, ["adjust-me"]);
  assert.deepEqual(validated.approvalPacket.unresolvedFindings, ["adjust-me"]);
  assert.equal(validated.approvalPacket.suggestedVerdict, "comment");
});

test("validation decisions reject duplicate candidate ids", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [
        { id: "candidate", action: "keep", reason: "Supported." },
        { id: "candidate", action: "drop", reason: "Not supported." },
      ],
    }), new Set(["candidate"])),
    /duplicate.*candidate/,
  );
});

test("validation decisions reject unknown candidate ids", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [{ id: "invented", action: "keep", reason: "Supported." }],
    }), new Set(["candidate"])),
    /unknown.*invented/,
  );
});

test("validation decisions reject missing candidate ids", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [{ id: "first", action: "keep", reason: "Supported." }],
    }), new Set(["first", "second"])),
    /missing.*second/,
  );
});

test("validation decisions reject invalid actions", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [{ id: "candidate", action: "accept", reason: "Supported." }],
    }), new Set(["candidate"])),
    /invalid action.*candidate/,
  );
});

test("validation decisions reject malformed extra entries", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [
        { id: "candidate", action: "keep", reason: "Supported." },
        null,
      ],
    }), new Set(["candidate"])),
    /malformed decision/,
  );
});

test("validation decisions require the decisions field for zero candidates", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({}), new Set()),
    /decisions.*array/,
  );
});

test("validation decisions reject non-array decisions for zero candidates", () => {
  for (const decisions of [null, {}, "none"]) {
    assert.throws(
      () => normalizeValidationDecisionsJson(JSON.stringify({ decisions }), new Set()),
      /decisions.*array/,
    );
  }
});

test("validation decisions accept an empty array for zero candidates", () => {
  assert.deepEqual(
    normalizeValidationDecisionsJson(JSON.stringify({ decisions: [] }), new Set()),
    [],
  );
});

test("validation decisions reject file-side adjusted locations", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [{
        id: "candidate",
        action: "adjust",
        reason: "Move the anchor.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "file", line: 1 }],
      }],
    }), new Set(["candidate"])),
    /invalid location.*candidate/,
  );
});

test("validation decisions reject adjusted locations without positive integer lines", () => {
  for (const line of [null, 0, 1.5]) {
    assert.throws(
      () => normalizeValidationDecisionsJson(JSON.stringify({
        decisions: [{
          id: "candidate",
          action: "adjust",
          reason: "Move the anchor.",
          locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line }],
        }],
      }), new Set(["candidate"])),
      /invalid location.*candidate/,
    );
  }
});

test("validation decisions reject malformed adjusted locations", () => {
  assert.throws(
    () => normalizeValidationDecisionsJson(JSON.stringify({
      decisions: [{
        id: "candidate",
        action: "adjust",
        reason: "Move the anchor.",
        locations: [{ fileId: "src/app/api/qa_api.py", path: "", side: "modified", line: 2 }],
      }],
    }), new Set(["candidate"])),
    /invalid location.*candidate/,
  );
});

test("validation decisions reject adjusted locations for unknown dataset files", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);

  assert.throws(
    () => applyValidationDecisions(analysis, [{
      id: "candidate",
      action: "adjust",
      reason: "Move the anchor.",
      locations: [{ fileId: "invented.py", path: "invented.py", side: "modified", line: 2 }],
    }], dataset()),
    /unknown.*candidate.*invented\.py/,
  );
});

test("validation decisions reject adjusted locations with mismatched dataset paths", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);

  assert.throws(
    () => applyValidationDecisions(analysis, [{
      id: "candidate",
      action: "adjust",
      reason: "Move the anchor.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/invented.py", side: "modified", line: 2 }],
    }], dataset()),
    /mismatched path.*candidate.*invented\.py/,
  );
});

test("validation decisions do not normalize adjusted dataset paths", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);
  const decisions = normalizeValidationDecisionsJson(JSON.stringify({
    decisions: [{
      id: "candidate",
      action: "adjust",
      reason: "Move the anchor.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: " src/app/api/qa_api.py ", side: "modified", line: 2 }],
    }],
  }), new Set(["candidate"]));

  assert.throws(
    () => applyValidationDecisions(analysis, decisions, dataset()),
    /mismatched path.*candidate/,
  );
});

test("validation decisions reject adjusted locations outside commentable changed lines", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);

  assert.throws(
    () => applyValidationDecisions(analysis, [{
      id: "candidate",
      action: "adjust",
      reason: "Move the anchor.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 5 }],
    }], dataset()),
    /non-commentable.*candidate.*modified.*5/,
  );
});

test("validation decisions reject kept candidates without a changed-line anchor", () => {
  const analysis = analysisWithFinding([]);

  assert.throws(
    () => applyValidationDecisions(analysis, [{
      id: "candidate",
      action: "keep",
      reason: "Supported.",
    }], dataset()),
    /candidate.*no changed-line anchored location/,
  );
});

test("validation keeps contextual locations when a real changed-line anchor is present", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "file", line: null },
  ]);

  const validated = applyValidationDecisions(analysis, [{
    id: "candidate",
    action: "keep",
    reason: "The changed line is supported and the file location is useful context.",
  }], dataset());

  assert.deepEqual(validated.findings[0]?.locations, [
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "file", line: null },
  ]);
});

test("validation application rejects missing decisions when called directly", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);

  assert.throws(
    () => applyValidationDecisions(analysis, [], dataset()),
    /missing.*candidate/,
  );
});

test("validation application rejects duplicate decisions when called directly", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);

  assert.throws(
    () => applyValidationDecisions(analysis, [
      { id: "candidate", action: "keep", reason: "Supported." },
      { id: "candidate", action: "drop", reason: "Unsupported." },
    ], dataset()),
    /duplicate.*candidate/,
  );
});

test("validation application rejects unknown decisions when called directly", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);

  assert.throws(
    () => applyValidationDecisions(analysis, [
      { id: "candidate", action: "keep", reason: "Supported." },
      { id: "invented", action: "drop", reason: "Unsupported." },
    ], dataset()),
    /unknown.*invented/,
  );
});

test("validation application rejects runtime-invalid actions when called directly", () => {
  const analysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);
  const decisions = [{
    id: "candidate",
    action: "accept",
    reason: "Supported.",
  }] as unknown as Parameters<typeof applyValidationDecisions>[1];

  assert.throws(
    () => applyValidationDecisions(analysis, decisions, dataset()),
    /invalid action.*candidate/,
  );
});

test("validation contract failures fail the phase without retaining candidates", () => {
  const candidateAnalysis = analysisWithFinding([
    { fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 },
  ]);
  const analysis = {
    ...candidateAnalysis,
    approvalPacket: {
      ...candidateAnalysis.approvalPacket,
      summary: "Candidate finding summary.",
      acceptedRisks: ["Candidate accepted risk."],
      suggestedVerdict: "approve" as const,
      body: "1. Candidate finding (medium)",
    },
  };
  const progress = {
    status: "running" as const,
    phase: "validation" as const,
    message: "Validating.",
    scoutSummary: "Scout summary.",
    chapters: [{
      chapterId: "qa-api",
      title: "QA labeling API",
      status: "done" as const,
      message: "Done. 1 finding(s).",
      findingCount: 1,
    }],
  };

  const failed = createValidationFailureResult(analysis, progress, new Error("missing decision for candidate"));

  assert.equal(failed.analysis.status, "failed");
  assert.deepEqual(failed.analysis.findings, []);
  assert.deepEqual(failed.analysis.chapters[0]?.findingIds, []);
  assert.deepEqual(failed.analysis.approvalPacket.unresolvedFindings, []);
  assert.doesNotMatch(failed.analysis.approvalPacket.summary, /candidate finding/i);
  assert.doesNotMatch(failed.analysis.approvalPacket.body, /candidate finding/i);
  assert.deepEqual(failed.analysis.approvalPacket.acceptedRisks, []);
  assert.notEqual(failed.analysis.approvalPacket.suggestedVerdict, "approve");
  assert.equal(failed.progress.status, "failed");
  assert.equal(failed.progress.chapters[0]?.findingCount, 0);
  assert.doesNotMatch(failed.progress.chapters[0]?.message ?? "", /1 finding/i);
  assert.match(failed.analysis.message, /validation failed.*missing decision for candidate/i);
});

test("validation decisions reset request-changes verdict when all findings are dropped", () => {
  const analysis = parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [{
      id: "drop-high",
      kind: "bug",
      severity: "high",
      confidence: "high",
      title: "High candidate",
      explanation: "High issue.",
      suggestedComment: "High comment.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
      status: "new",
    }],
  }), chapter()), dataset());
  const withRequestChanges = {
    ...analysis,
    approvalPacket: {
      ...analysis.approvalPacket,
      suggestedVerdict: "request-changes" as const,
    },
  };

  const validated = applyValidationDecisions(withRequestChanges, [{ id: "drop-high", action: "drop", reason: "Unverifiable." }], dataset());

  assert.equal(validated.findings.length, 0);
  assert.deepEqual(validated.approvalPacket.unresolvedFindings, []);
  assert.equal(validated.approvalPacket.suggestedVerdict, "approve");
});

test("progress finding counts can be refreshed from validated chapters", () => {
  const analysis = parseReviewAnalysisJson(normalizeChapterReviewJson(JSON.stringify({
    findings: [{
      id: "kept",
      kind: "bug",
      severity: "medium",
      confidence: "high",
      title: "Kept",
      explanation: "Kept issue.",
      suggestedComment: "Kept comment.",
      locations: [{ fileId: "src/app/api/qa_api.py", path: "src/app/api/qa_api.py", side: "modified", line: 2 }],
      status: "new",
    }],
  }), chapter()), dataset());
  const progress = {
    status: "running" as const,
    phase: "validation" as const,
    message: "Validating.",
    scoutSummary: "",
    chapters: [{
      chapterId: "qa-api",
      title: "QA labeling API",
      status: "done" as const,
      message: "Done. 3 finding(s).",
      findingCount: 3,
    }],
  };

  const refreshed = refreshProgressFindingCounts(progress, analysis);

  assert.equal(refreshed.chapters[0]?.findingCount, 1);
});

test("partial chapter failure is incomplete and can never recommend approval", () => {
  const finalize = (aiReviewModule as Record<string, unknown>).finalizeAiReviewResult;
  assert.equal(typeof finalize, "function");
  if (typeof finalize !== "function") return;
  const analysis = analysisWithFinding([]);
  const progress = {
    status: "running" as const,
    phase: "synthesis" as const,
    message: "Preparing review summary.",
    scoutSummary: "Review changed authorization paths.",
    chapters: [
      { chapterId: "qa-api", title: "QA labeling API", status: "done" as const, message: "Done.", findingCount: 0 },
      { chapterId: "tests", title: "Tests", status: "failed" as const, message: "Model failed.", findingCount: 0 },
    ],
  };

  const result = (finalize as (options: Record<string, unknown>) => {
    analysis: ReturnType<typeof analysisWithFinding>;
    progress: typeof progress;
  })({
    analysis,
    progress,
    completedChapterCount: 1,
    failedChapterCount: 1,
    finalNotes: [],
  });

  assert.equal(result.analysis.status, "failed");
  assert.equal(result.progress.status, "failed");
  assert.equal(result.analysis.approvalPacket.suggestedVerdict, "comment");
  assert.match(result.analysis.message, /incomplete.*1 review area.*failed/i);
  assert.match(result.analysis.approvalPacket.summary, /incomplete/i);
  assert.match(result.analysis.approvalPacket.body, /manual review.*failed/i);
});

test("synthesis normalization falls back for invalid packet fields", () => {
  const fallback = {
    summary: "Fallback summary.",
    reviewedChapters: ["qa-api"],
    acceptedRisks: ["Known risk."],
    unresolvedFindings: [],
    suggestedVerdict: "comment" as const,
    body: "Fallback body.",
  };

  const synthesis = normalizeSynthesisJson(JSON.stringify({
    summary: "Synthesized summary.",
    suggestedVerdict: "merge",
    acceptedRisks: [123, "Risk accepted."],
    body: "",
  }), fallback);

  assert.equal(synthesis.summary, "Synthesized summary.");
  assert.equal(synthesis.suggestedVerdict, "comment");
  assert.deepEqual(synthesis.acceptedRisks, ["Risk accepted."]);
  assert.equal(synthesis.body, "Fallback body.");
});

test("synthesis cannot override the deterministic verdict for unresolved findings", () => {
  const cases = [
    { unresolvedFindings: ["high"], invariantVerdict: "request-changes" as const, modelVerdict: "approve" },
    { unresolvedFindings: ["medium"], invariantVerdict: "comment" as const, modelVerdict: "request-changes" },
    { unresolvedFindings: [], invariantVerdict: "approve" as const, modelVerdict: "comment" },
  ];

  for (const { unresolvedFindings, invariantVerdict, modelVerdict } of cases) {
    const fallback = {
      summary: "Validated summary.",
      reviewedChapters: ["qa-api"],
      acceptedRisks: [],
      unresolvedFindings,
      suggestedVerdict: invariantVerdict,
      body: "Validated body.",
    };
    const synthesis = normalizeSynthesisJson(JSON.stringify({
      summary: "Synthesized summary.",
      suggestedVerdict: modelVerdict,
      acceptedRisks: [],
      body: "Synthesized body.",
    }), fallback);

    assert.equal(synthesis.suggestedVerdict, invariantVerdict);
  }
});
