#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runPi } from "@earendil-works/pi-coding-agent";

const binPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(binPath), "..");
const extensionPath = resolve(packageRoot, "src/index.ts");

const PI_FLAGS_WITH_VALUE = new Set([
  "--api-key",
  "--append-system-prompt",
  "--extension",
  "-e",
  "--fork",
  "--model",
  "-m",
  "--models",
  "--prompt-template",
  "--provider",
  "--session",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
]);

const PI_BOOLEAN_FLAGS = new Set([
  "--continue",
  "-c",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-prompt-templates",
  "--no-session",
  "--no-skills",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--verbose",
]);

function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
    return typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  console.log(`pi-diff-review ${readPackageVersion()}

Usage:
  pi-diff-review [options]
  pi-diff-review [options] pr <github-pr-url>

Examples:
  pi-diff-review
  pi-diff-review pr https://github.com/headout/magellan/pull/646
  pi-diff-review --reset-review pr https://github.com/headout/magellan/pull/646
  pi-diff-review --repo /Users/kewalzanzmeria/Desktop/ho-repos/magellan pr https://github.com/headout/magellan/pull/646
  pi-diff-review --model openai-codex/gpt-5 --thinking high pr https://github.com/headout/magellan/pull/646

Options:
  --repo, --cwd <path>       Run the review from this repository path
  --reset-review             Clear saved cockpit metadata for this review before opening
  --fresh                    Alias for --reset-review
  --abandon-ambiguous-publish
                             Preserve review progress but discard a blocked publish intent;
                             retrying may create a duplicate GitHub review
  --with-pi-extensions       Also load your configured Pi extensions
  -h, --help                 Show this help
  -v, --version              Show the version

Common Pi options are passed through:
  --model, --provider, --thinking, --models, --api-key, --session, --resume,
  --continue, --no-session, --offline, --verbose, --tools, --no-tools
`);
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value == null || value.length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function pushValueFlag(argv, index, flag, piArgs) {
  if (flag.includes("=")) {
    piArgs.push(flag);
    return index;
  }

  const value = readRequiredValue(argv, index, flag);
  piArgs.push(flag, value);
  return index + 1;
}

function parseCliArgs(argv) {
  const piArgs = [];
  const reviewArgs = [];
  let repoRoot = null;
  let loadConfiguredPiExtensions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      reviewArgs.push(...argv.slice(index + 1));
      break;
    }

    if (arg === "-h" || arg === "--help") {
      return { action: "help" };
    }

    if (arg === "-v" || arg === "--version") {
      return { action: "version" };
    }

    if (arg === "--with-pi-extensions") {
      loadConfiguredPiExtensions = true;
      continue;
    }

    if (arg === "--repo" || arg === "--cwd") {
      repoRoot = readRequiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("--repo=")) {
      repoRoot = arg.slice("--repo=".length);
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      repoRoot = arg.slice("--cwd=".length);
      continue;
    }

    const flagName = arg.split("=", 1)[0];
    if (PI_FLAGS_WITH_VALUE.has(flagName)) {
      index = pushValueFlag(argv, index, arg, piArgs);
      continue;
    }

    if (PI_BOOLEAN_FLAGS.has(arg)) {
      piArgs.push(arg);
      continue;
    }

    reviewArgs.push(arg);
  }

  return {
    action: "run",
    loadConfiguredPiExtensions,
    piArgs,
    repoRoot,
    reviewArgs,
  };
}

function buildDiffReviewPrompt(reviewArgs) {
  const normalizedArgs = [...reviewArgs];
  if (normalizedArgs[0] === "/diff-review" || normalizedArgs[0] === "diff-review") {
    normalizedArgs.shift();
  }

  if (normalizedArgs.length === 0) {
    return "/diff-review";
  }

  return `/diff-review ${normalizedArgs.join(" ")}`;
}

async function run(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.action === "help") {
    printHelp();
    return;
  }

  if (parsed.action === "version") {
    console.log(readPackageVersion());
    return;
  }

  if (parsed.repoRoot != null) {
    process.chdir(resolve(parsed.repoRoot));
  }

  const resourceArgs = parsed.loadConfiguredPiExtensions
    ? ["-e", extensionPath]
    : ["--no-extensions", "-e", extensionPath];

  await runPi([
    ...resourceArgs,
    ...parsed.piArgs,
    buildDiffReviewPrompt(parsed.reviewArgs),
  ]);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`pi-diff-review: ${message}`);
  process.exitCode = 1;
}
