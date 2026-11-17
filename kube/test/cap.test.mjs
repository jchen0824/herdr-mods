// Regression: a list bigger than Herdr's 8 MiB exec cap. Before the fix the panel read it with
// one `kubectl get -A -o json`, Herdr cut the output off, and the panel failed to parse it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as K from "../mods/kube/kube.js";
import { setHandler } from "./herdr-stub.mjs";
import { EXEC_CAP } from "./cap.mjs";

const POD_COUNT = 1200;
const pods = Array.from({ length: POD_COUNT }, (_, i) => ({
  metadata: { name: `pod-${i}`, namespace: `ns-${i % 7}`, uid: `u${i}`, managedFields: [{ manager: "x".repeat(4000) }] },
  spec: { containers: [{ name: "app", image: "app:1", env: [{ name: "PAD", value: "y".repeat(6000) }] }] },
  status: { phase: "Running" },
}));

// A fake API server behind `kubectl get --raw <path>?limit=&continue=`; continue is an offset.
const outputs = [];
setHandler((cmd, args) => {
  if (cmd === "/bin/sh") return { code: 0, stdout: "/usr/bin:/bin", stderr: "" };     // the PATH probe
  const url = args.at(-1);
  if (args.includes("--raw") && url.startsWith("/api/v1/pods?")) {
    const q = new URLSearchParams(url.split("?")[1]);
    const from = Number(q.get("continue") ?? 0), limit = Number(q.get("limit"));
    const next = from + limit < pods.length ? String(from + limit) : "";
    const stdout = JSON.stringify({ kind: "PodList", items: pods.slice(from, from + limit), metadata: next ? { continue: next } : {} });
    outputs.push(stdout.length);
    return { code: 0, stdout, stderr: "" };
  }
  // Anything else is the old one-shot read: kubectl's pretty-printed JSON of the whole list.
  return { code: 0, stdout: JSON.stringify({ items: pods }, null, 4), stderr: "" };
});

test("the whole list is over the cap as one kubectl -o json", () => {
  assert.ok(JSON.stringify({ items: pods }, null, 4).length > EXEC_CAP);
});

test("list() reads it in pages, every one under the cap, and gets every object", async () => {
  const items = await K.list(K.kindById("pods"), { context: "big", namespace: null });
  assert.equal(items.length, POD_COUNT);
  assert.equal(new Set(items.map((o) => o.metadata.uid)).size, POD_COUNT);
  assert.ok(outputs.length > 1, "more than one page");
  assert.ok(Math.max(...outputs) < EXEC_CAP);
  assert.ok(items.every((o) => !o.metadata.managedFields));
});
