import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const VERIFIED_READ_FLAGS = constants.O_RDONLY
  | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0)
  | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOutsideRoot(canonicalRoot: string, candidatePath: string): boolean {
  const candidateRelativePath = relative(canonicalRoot, candidatePath);
  return candidateRelativePath === ".." || candidateRelativePath.startsWith(`..${sep}`) || isAbsolute(candidateRelativePath);
}

export async function readRepositoryTextFile(repoRoot: string, repositoryPath: string): Promise<string> {
  if (isAbsolute(repositoryPath)) {
    throw new Error(`Cannot read absolute repository path "${repositoryPath}": paths must be relative to the repository root.`);
  }
  const canonicalRoot = await realpath(repoRoot).catch((error: unknown) => {
    throw new Error(`Cannot resolve repository root "${repoRoot}" while reading "${repositoryPath}": ${errorMessage(error)}`, { cause: error });
  });
  const resolvedPath = resolve(canonicalRoot, repositoryPath);
  if (isOutsideRoot(canonicalRoot, resolvedPath)) {
    throw new Error(`Cannot read outside the repository root: "${repositoryPath}" resolves beyond it.`);
  }
  const fileStat = await lstat(resolvedPath).catch((error: unknown) => {
    throw new Error(`Cannot inspect repository file "${repositoryPath}": ${errorMessage(error)}`, { cause: error });
  });
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Cannot read symbolic link "${repositoryPath}": the final repository path must name a regular file.`);
  }
  if (!fileStat.isFile() && !fileStat.isFIFO()) {
    throw new Error(`Cannot read non-regular file "${repositoryPath}": the repository path must name a regular file.`);
  }
  const canonicalPath = await realpath(resolvedPath).catch((error: unknown) => {
    throw new Error(`Cannot resolve repository file "${repositoryPath}": ${errorMessage(error)}`, { cause: error });
  });
  if (isOutsideRoot(canonicalRoot, canonicalPath)) {
    throw new Error(`Cannot read outside the repository root: "${repositoryPath}" resolves to "${canonicalPath}".`);
  }

  const file = await open(resolvedPath, VERIFIED_READ_FLAGS).catch((error: unknown) => {
    throw new Error(`Cannot open repository file "${repositoryPath}": ${errorMessage(error)}`, { cause: error });
  });
  try {
    const openedStat = await file.stat();
    if (!openedStat.isFile()) {
      throw new Error(`Cannot read non-regular file "${repositoryPath}": the opened repository path is not a regular file.`);
    }
    if (openedStat.dev !== fileStat.dev || openedStat.ino !== fileStat.ino) {
      throw new Error(`Cannot read repository file "${repositoryPath}": the path changed while it was being opened.`);
    }
    return await file.readFile("utf8").catch((error: unknown) => {
      throw new Error(`Cannot read repository file "${repositoryPath}": ${errorMessage(error)}`, { cause: error });
    });
  } finally {
    await file.close();
  }
}
