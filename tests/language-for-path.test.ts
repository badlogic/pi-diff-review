import assert from "node:assert/strict";
import test from "node:test";
import { languageForPath } from "../web/language-for-path.js";

test("read-only Monaco keeps syntax highlighting for supported review files", () => {
  assert.deepEqual([
    "file.ts", "file.js", "file.json", "file.css", "file.html", "file.md", "file.sh",
    "file.yaml", "file.rs", "file.java", "file.kt", "file.py", "file.go",
  ].map(languageForPath), [
    "typescript", "javascript", "json", "css", "html", "markdown", "shell",
    "yaml", "rust", "java", "kotlin", "python", "go",
  ]);
});
