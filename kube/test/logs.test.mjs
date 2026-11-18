import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../mods/kube/logs.js";
const p = L.parse("[pod/api-7f78-abc12/app] 2026-11-16T15:42:42.123456789Z level=warn msg=slow");
assert.equal(p.src, "api-7f78-abc12/app"); assert.equal(p.ts, "2026-11-16T15:42:42.123456789Z"); assert.equal(p.text, "level=warn msg=slow"); assert.equal(p.level, "warn");
assert.equal(L.level('{"level":"error","msg":"x"}'), "error");
assert.equal(L.level("INFO started"), "info");
assert.equal(L.level("Traceback (most recent call last):"), "error");
assert.equal(L.level("hello"), null);
const s = L.emptyState();
assert.equal(L.merge(s, "[pod/a/c] 2026-01-01T00:00:01Z one\n[pod/a/c] 2026-01-01T00:00:02Z two\n"), 2);
// a --since-time read repeats the newest line
assert.equal(L.merge(s, "[pod/a/c] 2026-01-01T00:00:02Z two\n[pod/b/c] 2026-01-01T00:00:03Z three\n"), 1);
// out-of-order arrival from another pod gets sorted in
assert.equal(L.merge(s, "[pod/c/c] 2026-01-01T00:00:01.5Z middle\n"), 1);
assert.deepEqual(s.lines.map((l) => l.text), ["one", "middle", "two", "three"]);
assert.deepEqual(L.visible(s.lines, { hidden: new Set(["a/c"]) }).map((l) => l.text), ["middle", "three"]);
assert.deepEqual(L.visible(s.lines, { q: "TH", onlyMatches: true }).map((l) => l.text), ["three"]);
assert.deepEqual(L.matches("abcabc", "bc"), [[1, 3], [4, 6]]);
assert.deepEqual(L.args({ namespace: "ns", kind: "Deployment", name: "api", selector: { app: "api" } }, { range: "15m" }).slice(0, 4), ["-n", "ns", "logs", "-l"]);
assert.ok(L.args({ namespace: "ns", kind: "Pod", name: "p", container: "c" }, { since: "2026-01-01T00:00:00Z" }).includes("--since-time=2026-01-01T00:00:00Z"));
assert.ok(L.args({ namespace: "ns", kind: "Pod", name: "p", previous: true }).includes("--previous"));
assert.equal(L.shortSrc("api-7f78c9-abc12/app"), "7f78c9-abc12/app");
assert.equal(L.asText(s.lines.slice(0, 1), { time: false }), "[a/c] one");


test("a following read that repeats the newest second adds nothing twice", () => {
  // Found by fast-check: --since-time keeps whole seconds, so the next read repeats lines from
  // the start of the newest line's second, not only those at its exact timestamp.
  const s = L.emptyState();
  L.merge(s, "[pod/a/app] 2026-01-01T00:00:05.000Z one\n[pod/a/app] 2026-01-01T00:00:05.001Z two");
  L.merge(s, "[pod/a/app] 2026-01-01T00:00:05.000Z one\n[pod/a/app] 2026-01-01T00:00:05.001Z two\n[pod/a/app] 2026-01-01T00:00:05.900Z three");
  assert.deepEqual(s.lines.map((l) => l.text), ["one", "two", "three"]);
});
