import type { ReviewMap } from "./types.js";

export function reviewMapNeedsPresentationGate(map: ReviewMap): boolean {
  return map.status !== "semantic" && map.status !== "semantic-repaired";
}

export interface CompleteReviewMapPresentationOptions {
  map: ReviewMap;
  canPresent: () => boolean;
  apply: (map: ReviewMap) => void;
  persist: () => Promise<boolean>;
  updateProtocol: (map: ReviewMap) => void;
  deliver: (map: ReviewMap) => boolean;
  release: () => void;
}

export async function completeReviewMapPresentation(
  options: CompleteReviewMapPresentationOptions,
): Promise<boolean> {
  if (!options.canPresent()) return false;
  options.apply(options.map);
  if (!await options.persist() || !options.canPresent()) return false;
  options.updateProtocol(options.map);
  if (!options.deliver(options.map) || !options.canPresent()) return false;
  options.release();
  return true;
}
