import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  GitHubContextComment,
  GitHubReviewContextSnapshot,
  GitHubReviewSummary,
  GitHubReviewThread,
} from "./types.js";

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_RECORDS = 10_000;
const MAX_DIAGNOSTICS = 100;

export interface FetchGitHubReviewContextOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  reviewedHeadSha: string;
}

type RecordValue = Record<string, unknown>;

const CONVERSATION_QUERY = `query ConversationComments($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    headRefOid comments(first: 100, after: $cursor) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } }
  } }
}`;
const REVIEWS_QUERY = `query ReviewSummaries($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    headRefOid reviews(first: 100, after: $cursor) { nodes { id author { login } body createdAt url state } pageInfo { hasNextPage endCursor } }
  } }
}`;
const THREADS_QUERY = `query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    headRefOid reviewThreads(first: 100, after: $cursor) { nodes {
      id isResolved isOutdated path diffSide line originalLine
      comments(first: 100) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } }
    } pageInfo { hasNextPage endCursor } }
  } }
}`;
const THREAD_COMMENTS_QUERY = `query ThreadComments($threadId: ID!, $cursor: String) {
  node(id: $threadId) { ... on PullRequestReviewThread {
    comments(first: 100, after: $cursor) { nodes { id author { login } body createdAt url } pageInfo { hasNextPage endCursor } }
  } }
}`;

function isRecord(value: unknown): value is RecordValue {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeComment(value: unknown): GitHubContextComment | null {
  if (!isRecord(value)
    || !nonemptyString(value.id)
    || typeof value.body !== "string"
    || !nonemptyString(value.createdAt)
    || !nonemptyString(value.url)) return null;
  const author = isRecord(value.author) && typeof value.author.login === "string" ? value.author.login : "ghost";
  return { id: value.id, author, body: value.body, createdAt: value.createdAt, url: value.url };
}

function normalizeReview(value: unknown): GitHubReviewSummary | null {
  const comment = normalizeComment(value);
  if (comment == null || !isRecord(value)) return null;
  const states = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
  if (typeof value.state !== "string" || !states.has(value.state)) return null;
  return { ...comment, state: value.state as GitHubReviewSummary["state"] };
}

function normalizeSide(value: unknown): GitHubReviewThread["side"] | undefined {
  if (value === "LEFT") return "original";
  if (value === "RIGHT") return "modified";
  if (value === null) return null;
  return undefined;
}

function connectionFrom(value: unknown): { nodes: unknown[]; hasNextPage: boolean; endCursor: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !isRecord(value.pageInfo)) return null;
  const hasNextPage = value.pageInfo.hasNextPage;
  const endCursor = value.pageInfo.endCursor;
  if (typeof hasNextPage !== "boolean" || (endCursor !== null && typeof endCursor !== "string")) return null;
  if (hasNextPage && !nonemptyString(endCursor)) return null;
  return { nodes: value.nodes, hasNextPage, endCursor: endCursor as string | null };
}

async function runGraphql(
  pi: ExtensionAPI,
  cwd: string,
  query: string,
  variables: Record<string, string | number | null>,
): Promise<unknown> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value != null) args.push("-F", `${key}=${value}`);
  }
  const result = await pi.exec("gh", args, { cwd, timeout: COMMAND_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`GitHub review context request failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error("GitHub review context returned invalid JSON.", { cause: error });
  }
}

function pullRequestFrom(value: unknown): RecordValue | null {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.repository) || !isRecord(value.data.repository.pullRequest)) return null;
  return value.data.repository.pullRequest;
}

function pushDiagnostic(diagnostics: string[], message: string): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message.slice(0, 500));
}

async function fetchConnectionPages(options: {
  pi: ExtensionAPI;
  cwd: string;
  query: string;
  field: string;
  source: FetchGitHubReviewContextOptions;
  onNode: (node: unknown) => Promise<void> | void;
  onHead: (sha: string) => void;
}): Promise<void> {
  let cursor: string | null = null;
  const cursors = new Set<string>();
  let count = 0;
  do {
    const response = await runGraphql(options.pi, options.cwd, options.query, {
      owner: options.source.owner,
      repo: options.source.repo,
      number: options.source.pullNumber,
      cursor,
    });
    const pullRequest = pullRequestFrom(response);
    if (pullRequest == null || !nonemptyString(pullRequest.headRefOid)) throw new Error("GitHub returned incomplete pull request context.");
    options.onHead(pullRequest.headRefOid);
    const connection = connectionFrom(pullRequest[options.field]);
    if (connection == null) throw new Error(`GitHub returned an invalid ${options.field} connection.`);
    for (const node of connection.nodes) {
      if (++count > MAX_RECORDS) throw new Error(`GitHub ${options.field} exceeded ${MAX_RECORDS} records.`);
      await options.onNode(node);
    }
    cursor = connection.hasNextPage ? connection.endCursor : null;
    if (cursor != null && (cursors.has(cursor) || cursors.size >= MAX_RECORDS)) throw new Error(`GitHub ${options.field} pagination repeated a cursor.`);
    if (cursor != null) cursors.add(cursor);
  } while (cursor != null);
}

export async function fetchGitHubReviewContext(
  pi: ExtensionAPI,
  cwd: string,
  source: FetchGitHubReviewContextOptions,
): Promise<GitHubReviewContextSnapshot> {
  const diagnostics: string[] = [];
  const conversationComments = new Map<string, GitHubContextComment>();
  const reviews = new Map<string, GitHubReviewSummary>();
  const threads = new Map<string, GitHubReviewThread>();
  let remoteHeadSha = "";
  const onHead = (sha: string): void => {
    if (remoteHeadSha !== "" && remoteHeadSha !== sha) throw new Error("GitHub pull request head changed while review context was loading.");
    remoteHeadSha = sha;
  };

  await fetchConnectionPages({
    pi, cwd, query: CONVERSATION_QUERY, field: "comments", source, onHead,
    onNode: (node) => {
      const comment = normalizeComment(node);
      if (comment == null) pushDiagnostic(diagnostics, "Skipped malformed conversation comment.");
      else if (!conversationComments.has(comment.id)) conversationComments.set(comment.id, comment);
    },
  });
  await fetchConnectionPages({
    pi, cwd, query: REVIEWS_QUERY, field: "reviews", source, onHead,
    onNode: (node) => {
      const review = normalizeReview(node);
      if (review == null) pushDiagnostic(diagnostics, "Skipped malformed review summary.");
      else if (!reviews.has(review.id)) reviews.set(review.id, review);
    },
  });
  await fetchConnectionPages({
    pi, cwd, query: THREADS_QUERY, field: "reviewThreads", source, onHead,
    onNode: async (node) => {
      if (!isRecord(node)
        || !nonemptyString(node.id)
        || typeof node.isResolved !== "boolean"
        || typeof node.isOutdated !== "boolean"
        || !nonemptyString(node.path)) {
        pushDiagnostic(diagnostics, "Skipped malformed review thread.");
        return;
      }
      const side = normalizeSide(node.diffSide);
      const line = optionalPositiveInteger(node.line);
      const originalLine = optionalPositiveInteger(node.originalLine);
      const commentsConnection = connectionFrom(node.comments);
      if (side === undefined || line === undefined || originalLine === undefined || commentsConnection == null) {
        pushDiagnostic(diagnostics, `Skipped malformed review thread ${node.id}.`);
        return;
      }
      const comments = new Map<string, GitHubContextComment>();
      const addComments = (nodes: unknown[]): void => {
        for (const value of nodes) {
          const comment = normalizeComment(value);
          if (comment == null) pushDiagnostic(diagnostics, `Skipped malformed comment in review thread ${node.id}.`);
          else if (!comments.has(comment.id)) comments.set(comment.id, comment);
        }
      };
      addComments(commentsConnection.nodes);
      let cursor = commentsConnection.hasNextPage ? commentsConnection.endCursor : null;
      const cursors = new Set<string>();
      while (cursor != null) {
        if (cursors.has(cursor)) throw new Error(`GitHub review thread ${node.id} pagination repeated a cursor.`);
        cursors.add(cursor);
        const response = await runGraphql(pi, cwd, THREAD_COMMENTS_QUERY, { threadId: node.id, cursor });
        const connection = isRecord(response) && isRecord(response.data) && isRecord(response.data.node)
          ? connectionFrom(response.data.node.comments)
          : null;
        if (connection == null) throw new Error(`GitHub returned invalid comments for review thread ${node.id}.`);
        addComments(connection.nodes);
        if (comments.size > MAX_RECORDS) throw new Error(`GitHub review thread ${node.id} exceeded ${MAX_RECORDS} comments.`);
        cursor = connection.hasNextPage ? connection.endCursor : null;
      }
      if (!threads.has(node.id)) {
        threads.set(node.id, {
          id: node.id,
          isResolved: node.isResolved,
          isOutdated: node.isOutdated,
          path: node.path,
          side,
          line,
          originalLine,
          comments: [...comments.values()],
        });
      }
    },
  });

  return {
    owner: source.owner,
    repo: source.repo,
    pullNumber: source.pullNumber,
    reviewedHeadSha: source.reviewedHeadSha,
    remoteHeadSha,
    fetchedAt: new Date().toISOString(),
    conversationComments: [...conversationComments.values()],
    reviews: [...reviews.values()],
    threads: [...threads.values()],
    diagnostics,
  };
}
