// End-to-end: the mod's data layer against a real cluster (kind in CI), with the real kubectl
// and Herdr's 8 MiB output cap. Needs a disposable cluster: it creates and deletes a namespace.
//   KUBE_E2E_CONTEXT  kube context to use (default: kind-kind)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as K from "../../mods/kube/kube.js";
import { calls } from "./herdr-real.mjs";
import { EXEC_CAP } from "../cap.mjs";

const ctx = process.env.KUBE_E2E_CONTEXT ?? "kind-kind";
const ns = "herdr-kube-e2e";
const kubectl = (args, input) => execFileSync("kubectl", ["--context", ctx, ...args], { input, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" });
const MAPS = 1000;          // ~10 KB each: about 10 MB of ConfigMaps, over the cap
const PAD = "z".repeat(10000);

before(() => {
  kubectl(["delete", "namespace", ns, "--ignore-not-found", "--wait=true"]);
  kubectl(["create", "namespace", ns]);
  // In batches: the API server takes about 3 MB per request.
  for (let i = 0; i < MAPS; i += 100) {
    const items = Array.from({ length: Math.min(100, MAPS - i) }, (_, j) => ({
      apiVersion: "v1", kind: "ConfigMap", metadata: { name: `cm-${i + j}`, namespace: ns }, data: { pad: PAD },
    }));
    kubectl(["apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  }
  kubectl(["-n", ns, "create", "secret", "generic", "e2e-secret", "--from-literal=password=hunter2-e2e"]);
});

after(() => { kubectl(["delete", "namespace", ns, "--wait=false"]); });

test("the old one-shot read is over the cap here", () => {
  assert.ok(kubectl(["get", "configmaps", "-n", ns, "-o", "json"]).length > EXEC_CAP);
});

test("list() reads more than 8 MiB of objects without any call over the cap", async () => {
  const start = calls.length;
  const items = await K.list(K.kindById("configmaps"), { context: ctx, namespace: ns });
  assert.equal(items.filter((o) => o.metadata.name.startsWith("cm-")).length, MAPS);
  const pages = calls.slice(start).filter((c) => c.includes("--raw"));
  assert.ok(pages.length >= 4, `paged (${pages.length} calls)`);
});

test("every resource kind lists, all namespaces and one namespace", async () => {
  for (const k of K.KINDS) {
    await K.list(k, { context: ctx, namespace: null });
    if (!k.cluster) await K.list(k, { context: ctx, namespace: ns });
  }
});

test("secret values never come back", async () => {
  const s = (await K.list(K.kindById("secrets"), { context: ctx, namespace: ns })).find((o) => o.metadata.name === "e2e-secret");
  assert.ok(s);
  assert.match(s.data.password, /^<hidden: \d+ bytes>$/);
  assert.ok(!JSON.stringify(s).includes("aHVudGVyMi1lMmU"));   // base64 of the value
});

test("namespaces, contexts and pods of a workload", async () => {
  assert.ok((await K.namespaces(ctx)).includes(ns));
  assert.ok((await K.contexts()).list.some((c) => c.name === ctx));
  const dep = (await K.list(K.kindById("deployments"), { context: ctx, namespace: "kube-system" })).find((d) => d.metadata.name === "coredns");
  assert.ok(dep, "kind runs coredns");
  assert.ok((await K.podsFor(dep, ctx)).length >= 1);
});
