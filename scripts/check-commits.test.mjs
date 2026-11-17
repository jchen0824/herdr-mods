import { test } from "node:test";
import assert from "node:assert/strict";
import { valid } from "./check-commits.mjs";

test("conventional subjects", () => {
  for (const s of ["fix(kube): retry loading clusters", "feat: add a mod", "ci!: drop node 18", "docs(topbar-actions): new size"]) assert.ok(valid(s), s);
  for (const s of ["Fix stuff", "fix: Capital start", "fix(kube): ends with period.", "feature: wrong type", "fix(Kube): upper scope", `fix: ${"x".repeat(70)}`]) assert.ok(!valid(s), s);
});
