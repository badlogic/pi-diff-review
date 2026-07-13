import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readRepositoryTextFile } from "../src/repository-text.js";

function createFifo(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile("mkfifo", [path], (error, _stdout, stderr) => {
      if (error == null) {
        resolve(true);
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(new Error(`mkfifo failed: ${stderr || error.message}`, { cause: error }));
    });
  });
}

test("reads a regular UTF-8 file inside the repository", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(join(repoRoot, "src"));
  await writeFile(join(repoRoot, "src", "message.txt"), "cafe \u2615\n", "utf8");

  const content = await readRepositoryTextFile(repoRoot, "src/message.txt");

  assert.equal(content, "cafe \u2615\n");
});

test("rejects an absolute repository path", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  const absolutePath = join(repoRoot, "message.txt");
  await writeFile(absolutePath, "inside\n", "utf8");

  await assert.rejects(
    readRepositoryTextFile(repoRoot, absolutePath),
    /absolute.*message\.txt/i,
  );
});

test("rejects lexical traversal outside the repository", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(sandbox, { recursive: true, force: true }));
  const repoRoot = join(sandbox, "repo");
  await mkdir(repoRoot);
  await writeFile(join(sandbox, "outside.txt"), "outside\n", "utf8");

  await assert.rejects(
    readRepositoryTextFile(repoRoot, "../outside.txt"),
    /outside.*repository.*\.\.\/outside\.txt/i,
  );
});

test("rejects a final symlink whose target is inside the repository", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  await writeFile(join(repoRoot, "target.txt"), "inside\n", "utf8");
  await symlink("target.txt", join(repoRoot, "link.txt"));

  await assert.rejects(
    readRepositoryTextFile(repoRoot, "link.txt"),
    /symbolic link.*link\.txt/i,
  );
});

test("rejects a parent symlink that resolves outside the repository", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(sandbox, { recursive: true, force: true }));
  const repoRoot = join(sandbox, "repo");
  const outsideRoot = join(sandbox, "outside");
  await mkdir(repoRoot);
  await mkdir(outsideRoot);
  await writeFile(join(outsideRoot, "message.txt"), "outside\n", "utf8");
  await symlink(outsideRoot, join(repoRoot, "linked"));

  await assert.rejects(
    readRepositoryTextFile(repoRoot, "linked/message.txt"),
    (error: Error) => {
      assert.match(error.message, /outside.*repository/i);
      assert.match(error.message, /linked\/message\.txt/i);
      return true;
    },
  );
});

test("rejects a repository path that is not a regular file", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(join(repoRoot, "nested"));

  await assert.rejects(
    readRepositoryTextFile(repoRoot, "nested"),
    /regular file.*nested/i,
  );
});

test("rejects a FIFO from the nonblocking open before reading", { timeout: 2_000 }, async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));
  const fifoPath = join(repoRoot, "review.pipe");
  if (!await createFifo(fifoPath)) {
    t.skip("mkfifo is unavailable on this platform");
    return;
  }

  await assert.rejects(
    readRepositoryTextFile(repoRoot, "review.pipe"),
    (error: Error) => {
      assert.match(error.message, /opened repository path.*regular file/i);
      assert.match(error.message, /review\.pipe/i);
      return true;
    },
  );
});

test("reports an actionable error when the repository file is missing", async (t) => {
  const repoRoot = await mkdtemp(join(tmpdir(), "pi-review-repository-text-"));
  t.after(async () => rm(repoRoot, { recursive: true, force: true }));

  await assert.rejects(
    readRepositoryTextFile(repoRoot, "missing.txt"),
    (error: Error) => {
      assert.match(error.message, /cannot inspect repository file/i);
      assert.match(error.message, /missing\.txt/i);
      assert.match(error.message, /ENOENT|no such file/i);
      return true;
    },
  );
});
