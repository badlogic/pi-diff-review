import {
  reviewSessionRecordState,
  type GitHubPublishIntentTransition,
  type ReviewSessionRecord,
  type ReviewSessionRecordState,
} from "./session-store.js";
import type { GitHubReviewPublishIntent, ReviewSessionSnapshot } from "./types.js";

export interface ReviewSessionStartupState {
  snapshot: ReviewSessionSnapshot;
  recordState: ReviewSessionRecordState | null;
}

export async function runReviewSessionStartupPersistence(options: {
  confirmedIntent: GitHubReviewPublishIntent | null;
  snapshot: ReviewSessionSnapshot | null;
  recordState: ReviewSessionRecordState | null;
  persistConfirmedRetirement: (
    snapshot: ReviewSessionSnapshot,
    transition: GitHubPublishIntentTransition,
  ) => Promise<ReviewSessionRecord>;
  initializeRuntime: (state: ReviewSessionStartupState) => Promise<void>;
  persistInitialSnapshot: (state: ReviewSessionStartupState) => Promise<boolean>;
}): Promise<void> {
  let state: ReviewSessionStartupState = {
    snapshot: options.snapshot ?? {},
    recordState: options.recordState,
  };

  if (options.confirmedIntent != null) {
    if (options.confirmedIntent.status !== "confirmed") {
      throw new Error("Only a confirmed stale publish intent can be retired during review startup.");
    }
    if (state.recordState == null) {
      throw new Error("A stale confirmed publish intent cannot be retired without the saved record revision and hash.");
    }
    const persisted = await options.persistConfirmedRetirement(state.snapshot, {
      expected: options.confirmedIntent,
      next: null,
      expectedRecordState: state.recordState,
    });
    state = {
      snapshot: persisted.snapshot,
      recordState: reviewSessionRecordState(persisted),
    };
  }

  await options.initializeRuntime(state);
  if (!await options.persistInitialSnapshot(state)) {
    throw new Error("Could not durably save the initial review session snapshot.");
  }
}
