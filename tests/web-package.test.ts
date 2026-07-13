import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { open } from "glimpseui";
import { createReviewWindowController } from "../src/review-window.js";
import { getReviewShellPath } from "../src/ui.js";
import type { RendererProtocolContext } from "../src/renderer-protocol.js";
import type { ReviewWindowData } from "../src/types.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const execFileAsync = promisify(execFile);

function npm(...args: string[]): string {
  return execFileSync("npm", args, { cwd: root, encoding: "utf8" });
}

function localAssetReferences(html: string): string[] {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith("#"));
}

test("web build preserves both primary and staging cleanup failures", () => {
  const buildScript = readFileSync(resolve(root, "scripts/build-web.mjs"), "utf8");
  assert.match(buildScript, /AggregateError/);
  assert.match(buildScript, /primaryError/);
  assert.match(buildScript, /cleanupError/);
});

test("web build produces a CSP-protected shell that references only bundled local assets", () => {
  npm("run", "build:web");
  const shellPath = resolve(root, "web/index.html");
  const shell = readFileSync(shellPath, "utf8");
  const references = localAssetReferences(shell);

  assert.match(shell, /Content-Security-Policy/);
  assert.match(shell, /connect-src 'none'/);
  assert.match(shell, /object-src 'none'/);
  assert.match(shell, /frame-src 'none'/);
  assert.match(shell, /form-action 'none'/);
  assert.match(shell, /base-uri 'none'/);
  assert.match(shell, /script-src 'self'/);
  assert.match(shell, /style-src 'self' 'unsafe-inline'/);
  assert.match(shell, /worker-src blob:/);
  assert.doesNotMatch(shell, /worker-src[^;]*'self'/);
  assert.equal(shell.includes("<script>"), false);
  assert.equal(references.some((reference) => /^https?:/i.test(reference)), false);
  assert.deepEqual(references.sort(), ["./csp-monitor.js", "./dist/review.js"]);
  for (const reference of references) assert.equal(existsSync(resolve(root, "web", reference)), true, reference);
  assert.doesNotMatch(shell, /dist\/review\.css/);
  assert.match(readFileSync(resolve(root, "web/dist/review.js"), "utf8"), /pi-diff-review-styles/);
});

test("concurrent web builds atomically replace one artifact without removing the live dist", { timeout: 30_000 }, async () => {
  npm("run", "build:web");
  const dist = resolve(root, "web/dist");
  const liveArtifact = join(dist, "review.js");
  const distInode = statSync(dist).ino;
  let observedMissingArtifact = false;
  const monitor = setInterval(() => {
    try {
      if (statSync(liveArtifact).size === 0) observedMissingArtifact = true;
    } catch {
      observedMissingArtifact = true;
    }
  }, 1);

  const builds = await Promise.all(Array.from({ length: 3 }, async () => {
    return await execFileAsync("npm", ["run", "build:web"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    });
  })).finally(() => clearInterval(monitor));
  const ownedStagingDirectories = new Set(builds.flatMap(({ stderr }) => (
    [...stderr.matchAll(/web[\\/]([.]dist-build-[^\\/\r\n]+)[\\/]/g)].map((match) => match[1])
  )));

  assert.equal(observedMissingArtifact, false);
  assert.equal(statSync(dist).ino, distInode);
  assert.deepEqual(readdirSync(dist).sort(), ["review.js"]);
  assert.ok(readFileSync(liveArtifact).byteLength > 0);
  assert.match(readFileSync(liveArtifact, "utf8"), /pi-diff-review-styles/);
  assert.equal(ownedStagingDirectories.size, 3);
  for (const directory of ownedStagingDirectories) {
    assert.equal(existsSync(resolve(root, "web", directory)), false, directory);
  }
});

test("npm pack includes the shell and every local asset it references", () => {
  const shell = readFileSync(resolve(root, "web/index.html"), "utf8");
  const packageContents = JSON.parse(npm("pack", "--dry-run", "--json")) as Array<{ files: Array<{ path: string; mode: number }> }>;
  const packed = new Set(packageContents[0]?.files.map((file) => file.path));

  assert.equal(packed.has("web/index.html"), true);
  for (const reference of localAssetReferences(shell)) {
    assert.equal(packed.has(`web/${reference.replace(/^\.\//, "")}`), true, reference);
  }
  for (const asset of readdirSync(resolve(root, "web/dist"))) {
    assert.equal(packed.has(`web/dist/${asset}`), true, asset);
  }
  assert.equal(packageContents[0]?.files.find((file) => file.path === "web/dist/review.js")?.mode, 0o644);
});

test("an isolated production tarball install ships runtime assets without build dependencies", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-diff-review-pack-"));
  try {
    const packRoot = join(tempRoot, "pack");
    const installRoot = join(tempRoot, "install");
    mkdirSync(packRoot);
    mkdirSync(installRoot);
    const packed = JSON.parse(npm("pack", "--json", "--pack-destination", packRoot)) as Array<{ filename: string }>;
    const tarball = join(packRoot, packed[0].filename);
    writeFileSync(join(installRoot, "package.json"), JSON.stringify({ name: "isolated-review-install", private: true }));
    execFileSync("npm", [
      "install",
      "--omit=dev",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      tarball,
    ], { cwd: installRoot, encoding: "utf8" });

    const installedPackage = join(installRoot, "node_modules", "pi-diff-review-cockpit");
    const installedManifest = JSON.parse(readFileSync(join(installedPackage, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const buildDependencies = ["@tailwindcss/cli", "esbuild", "monaco-editor", "tailwindcss"];
    assert.deepEqual(Object.keys(installedManifest.dependencies ?? {}).sort(), ["glimpseui"]);
    for (const dependency of buildDependencies) {
      assert.equal(installedManifest.dependencies?.[dependency], undefined, dependency);
      assert.equal(typeof installedManifest.devDependencies?.[dependency], "string", dependency);
      assert.equal(existsSync(join(installRoot, "node_modules", ...dependency.split("/"))), false, dependency);
    }
    assert.deepEqual(readdirSync(join(installedPackage, "web", "dist")).sort(), ["review.js"]);
    assert.match(readFileSync(join(installedPackage, "web", "dist", "review.js"), "utf8"), /pi-diff-review-styles/);
    assert.equal(existsSync(join(installedPackage, "web", "index.html")), true);
    assert.equal(existsSync(join(installedPackage, "web", "csp-monitor.js")), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("the packed source contract rebuilds web dist with installed dev dependencies", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-diff-review-source-"));
  try {
    const packRoot = join(tempRoot, "pack");
    const sourceRoot = join(tempRoot, "source");
    mkdirSync(packRoot);
    mkdirSync(sourceRoot);
    const packed = JSON.parse(npm("pack", "--json", "--pack-destination", packRoot)) as Array<{ filename: string }>;
    const tarball = join(packRoot, packed[0].filename);
    execFileSync("tar", ["-xzf", tarball, "-C", sourceRoot]);

    const extractedPackage = join(sourceRoot, "package");
    rmSync(join(extractedPackage, "web", "dist"), { recursive: true, force: true });
    execFileSync("npm", [
      "install",
      "--ignore-scripts",
      "--include=dev",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
    ], { cwd: extractedPackage, encoding: "utf8" });
    execFileSync("npm", ["run", "prepare"], { cwd: extractedPackage, encoding: "utf8" });

    assert.deepEqual(readdirSync(join(extractedPackage, "web", "dist")).sort(), ["review.js"]);
    assert.match(readFileSync(join(extractedPackage, "web", "dist", "review.js"), "utf8"), /pi-diff-review-styles/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("macOS native shell loads local assets and completes the hidden boot handshake", {
  skip: process.platform !== "darwin",
  timeout: 20_000,
}, async () => {
  npm("run", "build:web");
  const nativeWindow = open("", { hidden: true, width: 320, height: 240, title: "Review shell smoke" });
  let nativeClosed = false;
  const closed = new Promise<void>((resolveClosed) => {
    nativeWindow.once("closed", () => {
      nativeClosed = true;
      resolveClosed();
    });
  });
  let showReached = false;
  const adapter = {
    on(event: "message" | "closed" | "error", listener: (...args: any[]) => void): unknown {
      return (nativeWindow.on as (...args: any[]) => unknown)(event, listener);
    },
    once(event: "ready", listener: () => void): unknown {
      return nativeWindow.once(event, listener);
    },
    removeListener(event: string, listener: (...args: any[]) => void): unknown {
      return nativeWindow.removeListener(event, listener);
    },
    loadFile(path: string): void {
      nativeWindow.loadFile(path);
    },
    send(source: string): void {
      nativeWindow.send(source);
    },
    show(): void {
      showReached = true;
      nativeWindow.send(`void (async () => {
        let workers = [];
        let workerError = null;
        let workerObjectUrlsBeforeDispose = -1;
        let workerObjectUrlsAfterDispose = -1;
        try {
          const diagnostics = window.__reviewWorkerDiagnostics;
          if (typeof diagnostics?.verifyLocalWorkers !== "function") {
            throw new Error("Monaco worker diagnostics are unavailable.");
          }
          workers = await diagnostics.verifyLocalWorkers();
          workerObjectUrlsBeforeDispose = diagnostics.activeObjectUrlCount();
          diagnostics.dispose();
          workerObjectUrlsAfterDispose = diagnostics.activeObjectUrlCount();
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error) {
          workerError = error instanceof Error ? error.message : String(error);
        }
        window.glimpse.send({
          type: "local-shell-smoke",
          styles: Array.from(document.styleSheets, (sheet) => sheet.href).filter(Boolean),
          scripts: Array.from(document.scripts, (script) => script.src).filter(Boolean),
          resources: performance.getEntriesByType("resource").map((entry) => entry.name),
          workers,
          workerError,
          workerObjectUrlsBeforeDispose,
          workerObjectUrlsAfterDispose,
          securityPolicyViolations: window.__reviewSecurityPolicyViolations ?? [{
            violatedDirective: "monitor-unavailable",
            blockedURI: "",
          }],
        });
      })();`);
    },
    close(): void {
      nativeWindow.close();
    },
  };
  const bootstrap: ReviewWindowData = {
    repoRoot: "/tmp/review-smoke",
    workingRoot: "/tmp/review-smoke",
    files: [],
    analysisFileIds: [],
    commits: [],
    source: {
      kind: "local-working-tree",
      label: "Local smoke",
      repoRoot: "/tmp/review-smoke",
      workingRoot: "/tmp/review-smoke",
      baseRevision: "HEAD",
      headRevision: null,
      canPublishGitHubReview: false,
    },
    map: {
      version: 2,
      status: "provisional",
      sourceFingerprint: "sha256:smoke",
      strategyVersion: "provisional-map-v1",
      story: {
        intent: "Smoke test",
        behaviorBefore: "",
        behaviorAfter: "",
        primaryFlows: [],
        removedOrReplacedBehavior: [],
      },
      changeUnits: [],
      chapters: [],
      coverage: {
        fileCount: 0,
        originalLineCount: 0,
        modifiedLineCount: 0,
        unmappedFileCount: 0,
        unmappedOriginalLineCount: 0,
        unmappedModifiedLineCount: 0,
        overlappingOriginalLineCount: 0,
        overlappingModifiedLineCount: 0,
      },
      diagnostics: [],
    },
    analysis: {
      status: "ready",
      message: "Smoke",
      chapters: [],
      findings: [],
      coverage: {
        fileCount: 0,
        originalLineCount: 0,
        modifiedLineCount: 0,
        unmappedFileCount: 0,
        unmappedOriginalLineCount: 0,
        unmappedModifiedLineCount: 0,
      },
      approvalPacket: {
        summary: "",
        reviewedChapters: [],
        acceptedRisks: [],
        unresolvedFindings: [],
        suggestedVerdict: "comment",
        body: "",
      },
    },
  };
  const protocol: Omit<RendererProtocolContext, "sessionId" | "capability"> = {
    files: new Map(),
    commitShas: new Set(),
    findingIds: new Set(),
    chapterIds: new Set(),
  };
  let rejectBoot: (error: Error) => void = () => {};
  const resultPromise = new Promise<{
    styles: string[];
    scripts: string[];
    resources: string[];
    workers: string[];
    workerError: string | null;
    workerObjectUrlsBeforeDispose: number;
    workerObjectUrlsAfterDispose: number;
    securityPolicyViolations: Array<{ violatedDirective: string; blockedURI: string }>;
  }>((resolveResult, reject) => {
    rejectBoot = reject;
    nativeWindow.on("message", (data: unknown) => {
      if (data == null || typeof data !== "object" || Array.isArray(data)) return;
      const message = data as Record<string, unknown>;
      if (message.type !== "local-shell-smoke") return;
      resolveResult({
        styles: message.styles as string[],
        scripts: message.scripts as string[],
        resources: message.resources as string[],
        workers: message.workers as string[],
        workerError: message.workerError as string | null,
        workerObjectUrlsBeforeDispose: message.workerObjectUrlsBeforeDispose as number,
        workerObjectUrlsAfterDispose: message.workerObjectUrlsAfterDispose as number,
        securityPolicyViolations: message.securityPolicyViolations as Array<{ violatedDirective: string; blockedURI: string }>,
      });
    });
  });
  const controller = createReviewWindowController({
    window: adapter,
    shellPath: getReviewShellPath(),
    title: "Review shell smoke",
    bootstrap,
    protocol,
    bootTimeoutMs: 12_000,
    onMessage: () => {},
    onClosed: () => rejectBoot(new Error("Native shell closed before boot completed.")),
    onError: rejectBoot,
  });
  controller.start();

  try {
    const result = await resultPromise;

    assert.equal(showReached, true);
    assert.equal(result.styles.some((url) => url.endsWith("/dist/review.css")), false);
    assert.equal(result.scripts.some((url) => url.endsWith("/dist/review.js")), true);
    assert.equal(result.resources.some((url) => url.endsWith("/dist/review.css")), false);
    assert.equal([...result.styles, ...result.scripts, ...result.resources].some((url) => /^https?:/i.test(url)), false);
    assert.equal(result.workerError, null);
    assert.deepEqual(result.workers.sort(), ["css", "editor", "html", "json", "typescript"]);
    assert.equal(result.workerObjectUrlsBeforeDispose, 5);
    assert.equal(result.workerObjectUrlsAfterDispose, 0);
    assert.deepEqual(result.securityPolicyViolations, []);
  } finally {
    controller.dispose();
    if (!nativeClosed) nativeWindow.close();
    await closed;
  }
});
