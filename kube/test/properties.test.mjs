// Property-based tests (fast-check): rules that must hold for every input, checked on many
// random ones. A failure prints the smallest input that breaks the rule and a seed to replay it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { parse as parseYaml } from "yaml";
import * as L from "../mods/kube/logs.js";
import * as K from "../mods/kube/kube.js";
import { setHandler } from "./herdr-stub.mjs";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const PODS = ["a", "b", "c"];

// ---- logs ----

// A log line: which pod, when (ms after T0), and printable text.
const lineArb = fc.record({
  pod: fc.constantFrom(...PODS),
  ms: fc.nat({ max: 10_000 }),
  text: fc.stringMatching(/^[ -~]{0,24}$/),
});
const key = (l) => `${l.pod}|${l.ms}|${l.text}`;
const raw = (l) => `[pod/${l.pod}/app] ${new Date(T0 + l.ms).toISOString()} ${l.text}`;

// What following does: read k starts where kubectl's --since-time lands. The API keeps whole
// seconds, so a read repeats every line from the start of the previous read's last second.
function reads(lines, cuts, order) {
  const sorted = [...lines].sort((x, y) => x.ms - y.ms);
  const ends = [...new Set(cuts.map((c) => c % (sorted.length + 1)))].sort((x, y) => x - y).filter((e) => e > 0);
  if (ends.at(-1) !== sorted.length) ends.push(sorted.length);
  const out = [];
  let start = 0;
  for (const end of ends) {
    const chunk = sorted.slice(start, end);
    // kubectl --prefix interleaves pods: a read isn't in time order.
    out.push(chunk.map((l, i) => [order[i % Math.max(1, order.length)] ?? i, l]).sort((x, y) => x[0] - y[0]).map(([, l]) => l));
    if (end > 0) {
      const sec = Math.floor(sorted[end - 1].ms / 1000);
      start = sorted.findIndex((l) => Math.floor(l.ms / 1000) === sec);
    }
  }
  return out;
}

test("following never loses, repeats or misorders a log line", () => {
  fc.assert(fc.property(
    fc.uniqueArray(lineArb, { selector: key, maxLength: 40 }),
    fc.array(fc.nat(), { maxLength: 6 }),
    fc.array(fc.nat(), { maxLength: 40 }),
    (lines, cuts, order) => {
      const state = L.emptyState();
      for (const r of reads(lines, cuts, order)) L.merge(state, r.map(raw).join("\n"));
      const got = state.lines.map((l) => `${l.src.split("/")[0]}|${Date.parse(l.ts) - T0}|${l.text}`);
      assert.deepEqual([...got].sort(), lines.map(key).sort(), "every line exactly once");
      for (let i = 1; i < state.lines.length; i++) assert.ok(state.lines[i - 1].at <= state.lines[i].at, "time order");
    },
  ));
});

test("sortable timestamps keep time order", () => {
  const ts = fc.tuple(fc.integer({ min: 0, max: 4e12 }), fc.nat({ max: 999_999 }), fc.boolean()).map(([ms, nanos, whole]) => {
    const iso = new Date(ms).toISOString().replace(/\.\d+Z$/, "");
    const frac = whole ? "" : `.${String(ms % 1000).padStart(3, "0")}${String(nanos).padStart(6, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
    return { iso: `${iso}${frac}Z`, at: ms - (ms % 1000) + (whole ? 0 : (ms % 1000) + nanos / 1e6) };
  });
  fc.assert(fc.property(ts, ts, (x, y) => {
    const a = L.sortable(x.iso), b = L.sortable(y.iso);
    if (x.at < y.at) assert.ok(a < b, `${x.iso} < ${y.iso}`);
    if (x.at === y.at) assert.equal(a, b);
  }));
});

test("filters only narrow, and every search match is the search text", () => {
  const parsed = fc.uniqueArray(lineArb, { selector: key, maxLength: 30 }).map((ls) => {
    const s = L.emptyState(); L.merge(s, ls.map(raw).join("\n")); return s.lines;
  });
  fc.assert(fc.property(parsed, fc.stringMatching(/^[ -~]{0,3}$/), fc.subarray(PODS.map((p) => `${p}/app`)), (lines, q, hidden) => {
    const all = L.visible(lines, {});
    const warn = L.visible(lines, { lvl: "warn" });
    const err = L.visible(lines, { lvl: "error" });
    assert.ok(err.every((l) => warn.includes(l)) && warn.every((l) => all.includes(l)));
    const only = L.visible(lines, { q, onlyMatches: true, hidden: new Set(hidden) });
    for (const l of only) {
      assert.ok(!hidden.includes(l.src));
      assert.ok(l.text.toLowerCase().includes(q.toLowerCase()));
    }
    for (const l of lines) {
      let prev = -1;
      for (const [a, b] of L.matches(l.text, q)) {
        assert.equal(l.text.slice(a, b).toLowerCase(), q.toLowerCase());
        assert.ok(a >= prev, "in order, not overlapping");
        prev = b;
      }
    }
  }));
});

// ---- cluster reads ----

test("paged reads return exactly the server's objects, or an error past the page limit", async () => {
  await fc.assert(fc.asyncProperty(fc.nat({ max: 900 }), fc.integer({ min: 1, max: 60 }), async (n, page) => {
    setHandler((cmd, args) => {
      if (cmd === "/bin/sh") return { code: 0, stdout: "/usr/bin", stderr: "" };
      const q = new URLSearchParams(args.at(-1).split("?")[1]);
      const from = Number(q.get("continue") ?? 0), limit = Number(q.get("limit"));
      const next = from + limit < n ? String(from + limit) : "";
      const items = Array.from({ length: Math.max(0, Math.min(limit, n - from)) }, (_, i) => ({ metadata: { name: `o${from + i}` } }));
      return { code: 0, stdout: JSON.stringify({ items, metadata: next ? { continue: next } : {} }), stderr: "" };
    });
    K.setPage(page);
    const read = K.list(K.kindById("configmaps"), { context: "prop", namespace: null });
    if (Math.ceil(n / page) > K.MAX_PAGES) await assert.rejects(read, /not showing an incomplete list/);
    else assert.deepEqual((await read).map((o) => o.metadata.name), Array.from({ length: n }, (_, i) => `o${i}`));
  }), { numRuns: 60 });
  K.setPage(250);
});

test("no secret value survives redaction", () => {
  const value = fc.uint8Array({ minLength: 6, maxLength: 64 }).map((b) => Buffer.from(b).toString("base64"));
  fc.assert(fc.property(fc.dictionary(fc.stringMatching(/^[A-Za-z0-9_.-]{1,16}$/), value, { minKeys: 1, maxKeys: 6 }), (data) => {
    const secret = {
      kind: "Secret", data, stringData: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, `plain-${v}`])),
      metadata: { name: "s", annotations: { "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({ data }) } },
    };
    const out = K.redactSecret(secret);
    const text = JSON.stringify(out) + K.toYaml(out);
    for (const v of Object.values(data)) assert.ok(!text.includes(v), `value ${v} leaked`);
    assert.deepEqual(Object.keys(out.data).sort(), Object.keys(data).sort());
  }));
});

test("the details panel's YAML reads back as the same object", () => {
  // Kubernetes objects are JSON: any JSON values under ordinary and odd keys.
  const obj = fc.record({
    apiVersion: fc.constant("v1"), kind: fc.constant("ConfigMap"),
    metadata: fc.record({ name: fc.string({ minLength: 1 }), labels: fc.dictionary(fc.string(), fc.string()) }),
    data: fc.dictionary(fc.string(), fc.jsonValue()),
  });
  fc.assert(fc.property(obj, (o) => {
    const withManaged = { ...o, metadata: { ...o.metadata, managedFields: [{ manager: "kubectl" }] } };
    const back = parseYaml(K.toYaml(withManaged), { uniqueKeys: false, version: "1.2" });
    assert.deepEqual(back, JSON.parse(JSON.stringify(o)));
  }), { numRuns: 300 });
});
