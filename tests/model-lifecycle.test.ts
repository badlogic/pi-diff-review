import assert from "node:assert/strict";
import test from "node:test";
import { detachDiffEditorModels, replaceDiffEditorModels } from "../web/model-lifecycle.js";

test("diff models are detached before the active models are disposed", () => {
  const events: string[] = [];
  const oldOriginal = { dispose: () => events.push("dispose old original") };
  const oldModified = { dispose: () => events.push("dispose old modified") };
  const nextOriginal = { dispose: () => events.push("dispose next original") };
  const nextModified = { dispose: () => events.push("dispose next modified") };
  const editor = {
    setModel(model: unknown): void {
      events.push(model == null ? "detach" : "attach next");
    },
  };

  const next = replaceDiffEditorModels(
    editor,
    { original: oldOriginal, modified: oldModified },
    {
      createOriginal: () => nextOriginal,
      createModified: () => nextModified,
    },
  );

  assert.deepEqual(next, { original: nextOriginal, modified: nextModified });
  assert.deepEqual(events, [
    "detach",
    "dispose old original",
    "dispose old modified",
    "attach next",
  ]);
});

test("loading files detach and dispose the active diff models", () => {
  const events: string[] = [];
  const result = detachDiffEditorModels(
    { setModel: (model: unknown) => events.push(model == null ? "detach" : "attach") },
    {
      original: { dispose: () => events.push("dispose original") },
      modified: { dispose: () => events.push("dispose modified") },
    },
  );

  assert.deepEqual(result, { original: null, modified: null });
  assert.deepEqual(events, ["detach", "dispose original", "dispose modified"]);
});

test("partial next-model creation is cleaned up while current models stay attached and alive", () => {
  const events: string[] = [];
  const editor = { setModel: () => events.push("set model") };
  const oldOriginal = { dispose: () => events.push("dispose old original") };
  const oldModified = { dispose: () => events.push("dispose old modified") };
  const nextOriginal = { dispose: () => events.push("dispose next original") };

  assert.throws(() => replaceDiffEditorModels(
    editor,
    { original: oldOriginal, modified: oldModified },
    {
      createOriginal: () => {
        events.push("create next original");
        return nextOriginal;
      },
      createModified: () => { throw new Error("model creation failed"); },
    },
  ), /model creation failed/);
  assert.deepEqual(events, ["create next original", "dispose next original"]);
});
