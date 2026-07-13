import assert from "node:assert/strict";
import test from "node:test";
import {
  collapseDisclosure,
  expandDisclosure,
  isDisclosureExpanded,
  toggleDisclosure,
} from "../web/review-disclosure-state.js";

test("review disclosures are expanded until explicitly collapsed", () => {
  const collapsed = new Set<string>();

  assert.equal(isDisclosureExpanded(collapsed, "finding-1"), true);
  collapseDisclosure(collapsed, "finding-1");
  assert.equal(isDisclosureExpanded(collapsed, "finding-1"), false);
});

test("review disclosures toggle independently and can be reopened by navigation", () => {
  const collapsed = new Set(["finding-1", "finding-2"]);

  toggleDisclosure(collapsed, "finding-1");
  assert.deepEqual([...collapsed], ["finding-2"]);

  expandDisclosure(collapsed, "finding-2");
  assert.equal(collapsed.size, 0);
});

