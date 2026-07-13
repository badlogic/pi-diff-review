export type DiffReviewCommand =
  | { mode: "local"; resetReview: boolean }
  | { mode: "github-pr"; url: string; resetReview: boolean };

const RESET_REVIEW_FLAGS = new Set(["--reset-review", "--fresh"]);

function usage(): string {
  return "Usage: /diff-review [--reset-review] or /diff-review [--reset-review] pr <github-pr-url>";
}

export function parseDiffReviewArgs(args: string[]): DiffReviewCommand {
  const positionals: string[] = [];
  let resetReview = false;

  for (const arg of args) {
    if (RESET_REVIEW_FLAGS.has(arg)) {
      resetReview = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unsupported diff-review option "${arg}". ${usage()}`);
    }
    positionals.push(arg);
  }

  if (positionals.length === 0) {
    return { mode: "local", resetReview };
  }

  const [source, value] = positionals;
  if (source === "pr") {
    if (!value) {
      throw new Error(usage());
    }
    return { mode: "github-pr", url: value, resetReview };
  }

  throw new Error(`Unsupported diff-review source "${source}". ${usage()}`);
}
