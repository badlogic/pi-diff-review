import assert from "node:assert/strict";
import test from "node:test";
import { createSessionSaveScheduler } from "../web/session-save-scheduler.js";

test("session save scheduling coalesces edits and flushes the latest state on close", () => {
  const callbacks = new Map<number, () => void>();
  let sequence = 0;
  let saves = 0;
  const scheduler = createSessionSaveScheduler(
    () => { saves += 1; },
    500,
    {
      setTimeout(callback: () => void) {
        const id = ++sequence;
        callbacks.set(id, callback);
        return id;
      },
      clearTimeout(id: number) {
        callbacks.delete(id);
      },
    } as any,
  );

  scheduler.schedule();
  scheduler.schedule();
  assert.equal(callbacks.size, 1);
  assert.equal(saves, 0);

  scheduler.flush();
  assert.equal(callbacks.size, 0);
  assert.equal(saves, 1);

  scheduler.flush();
  assert.equal(saves, 1);
});
