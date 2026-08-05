import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(root, "web");
const distRoot = join(webRoot, "dist");
const monaco = (path) => require.resolve(`monaco-editor/${path}`);
const tailwindCli = join(dirname(require.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");
const MAX_REVIEW_ARTIFACT_BYTES = 6 * 1024 * 1024;

async function replaceReviewArtifact(contents) {
  await mkdir(distRoot, { recursive: true });
  const destination = join(distRoot, "review.js");
  const tempPath = join(distRoot, `.review.js.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const tempHandle = await open(tempPath, "wx", 0o644);
    try {
      await tempHandle.writeFile(contents, "utf8");
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }

    await rename(tempPath, destination);
    renamed = true;
    await rm(join(distRoot, "review.css"), { force: true });

    const directoryHandle = await open(distRoot, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (!renamed) await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const stagedDistRoot = await mkdtemp(join(webRoot, ".dist-build-"));
let primaryError = null;
try {
  const workerEntries = {
    editor: monaco("esm/vs/editor/editor.worker.js"),
    json: monaco("esm/vs/language/json/json.worker.js"),
  };
  const workerBuild = await build({
    absWorkingDir: root,
    entryPoints: workerEntries,
    bundle: true,
    format: "iife",
    target: "es2022",
    outdir: join(stagedDistRoot, "worker-sources"),
    entryNames: "[name]",
    minify: true,
    sourcemap: false,
    write: false,
    logLevel: "silent",
  });

  const workerProbePrelude = `self.addEventListener("message",event=>{const message=event.data;if(message&&message.__piDiffReviewWorkerProbe==="v1"){event.stopImmediatePropagation();self.postMessage({__piDiffReviewWorkerProbe:"v1"});}});\n`;
  const workerSources = new Map(
    workerBuild.outputFiles
      .filter((output) => output.path.endsWith(".js"))
      .map((output) => [basename(output.path, ".js"), `${workerProbePrelude}${output.text}`]),
  );
  for (const name of Object.keys(workerEntries)) {
    if (!workerSources.has(name)) throw new Error(`Missing bundled Monaco worker source: ${name}`);
  }

  const localWorkerSources = {
    name: "local-monaco-worker-sources",
    setup(esbuild) {
      esbuild.onResolve({ filter: /^review-worker:/ }, (args) => ({
        path: args.path.slice("review-worker:".length),
        namespace: "review-worker",
      }));
      esbuild.onLoad({ filter: /.*/, namespace: "review-worker" }, (args) => {
        const source = workerSources.get(args.path);
        if (source == null) throw new Error(`Unknown Monaco worker source: ${args.path}`);
        return { contents: `export default ${JSON.stringify(source)};`, loader: "js" };
      });
    },
  };

  await build({
    absWorkingDir: root,
    entryPoints: { review: "web/app.js" },
    bundle: true,
    format: "iife",
    target: "es2022",
    outdir: stagedDistRoot,
    entryNames: "[name]",
    loader: {
      ".ttf": "dataurl",
    },
    plugins: [localWorkerSources],
    minify: true,
    sourcemap: false,
    logLevel: "info",
  });

  const tailwindPath = join(stagedDistRoot, "tailwind.css");
  await execFileAsync(process.execPath, [
    tailwindCli,
    "--input", join(webRoot, "review.css"),
    "--output", tailwindPath,
    "--minify",
  ], { cwd: root });

  const [tailwindCss, monacoCss, reviewJavaScript] = await Promise.all([
    readFile(tailwindPath, "utf8"),
    readFile(join(stagedDistRoot, "review.css"), "utf8"),
    readFile(join(stagedDistRoot, "review.js"), "utf8"),
  ]);
  const styles = `${tailwindCss}\n${monacoCss}`;
  const styleBootstrap = `(()=>{const marker="pi-diff-review-styles";if(document.querySelector("style[data-pi-diff-review-styles]"))return;const style=document.createElement("style");style.setAttribute("data-pi-diff-review-styles",marker);style.textContent=${JSON.stringify(styles)};document.head.append(style)})();\n`;
  const reviewArtifact = `${styleBootstrap}${reviewJavaScript}`;
  const artifactBytes = Buffer.byteLength(reviewArtifact, "utf8");
  if (artifactBytes > MAX_REVIEW_ARTIFACT_BYTES) {
    throw new Error(`web/dist/review.js is ${artifactBytes} bytes; limit is ${MAX_REVIEW_ARTIFACT_BYTES} bytes (6 MiB).`);
  }
  await replaceReviewArtifact(reviewArtifact);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await rm(stagedDistRoot, { recursive: true, force: true });
  } catch (cleanupError) {
    if (primaryError == null) throw cleanupError;
    throw new AggregateError(
      [primaryError, cleanupError],
      "The web build failed and its staging directory could not be removed.",
      { cause: primaryError },
    );
  }
}
