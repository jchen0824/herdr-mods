import { test } from "node:test";
import assert from "node:assert/strict";
import * as K from "../mods/kube/kube.js";
import { calls, replies } from "./herdr-stub.mjs";

test("context labels", () => {
  assert.deepEqual(K.contextLabel("gke_proj_europe-west1_shop"), { title: "shop", sub: "GKE · europe-west1" });
  assert.deepEqual(K.contextLabel("arn:aws:eks:us-east-1:123456789012:cluster/api"), { title: "api", sub: "EKS · us-east-1" });
  assert.equal(K.contextLabel("kind-dev").title, "kind-dev");
});

test("production names", () => {
  for (const n of ["prod", "shop-prod", "gke_p_us_production", "live-eu"]) assert.ok(K.isProd(n), n);
  for (const n of ["product-dev", "staging", "kind-dev"]) assert.ok(!K.isProd(n), n);
});

test("quantities", () => {
  assert.equal(K.cores("250m"), 0.25);
  assert.ok(Math.abs(K.cores("123456789n") - 0.123456789) < 1e-12);
  assert.equal(K.cores("2"), 2);
  assert.equal(K.bytes("1Ki"), 1024);
  assert.equal(K.bytes("1Gi"), 2 ** 30);
  assert.equal(K.bytes("500M"), 5e8);
  assert.equal(K.fmtCores(0.25), "250m");
  assert.equal(K.fmtCores(2.5), "2.5");
  assert.equal(K.fmtBytes(300 * 2 ** 20), "300Mi");
});

test("pod status words and health", () => {
  const pod = (s) => ({ status: s, spec: { containers: [{ name: "app" }] } });
  assert.equal(K.podStatus(pod({ phase: "Running", containerStatuses: [{ ready: true, state: { running: {} } }] })), "Running");
  assert.equal(K.podStatus(pod({ phase: "Running", containerStatuses: [{ state: { waiting: { reason: "CrashLoopBackOff" } } }] })), "CrashLoopBackOff");
  assert.equal(K.health("Running"), "ok");
  assert.equal(K.health("Pending"), "warn");
  assert.equal(K.health("CrashLoopBackOff"), "bad");
  assert.equal(K.health("Succeeded"), "done");
});

test("secret values never survive listing", () => {
  const s = K.redactSecret({ kind: "Secret", data: { password: "c2VjcmV0" }, stringData: { x: "y" },
    metadata: { name: "s", annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{\"data\":{\"password\":\"c2VjcmV0\"}}" } } });
  assert.equal(s.data.password, "<hidden: 6 bytes>");
  assert.equal(s.stringData, undefined);
  assert.equal(s.metadata.annotations["kubectl.kubernetes.io/last-applied-configuration"], "<hidden>");
  assert.ok(!JSON.stringify(s).includes("c2VjcmV0"));
});

test("every column copes with an empty object", () => {
  for (const k of K.KINDS) for (const c of k.cols) assert.equal(typeof c.get({ metadata: {} }), "string", `${k.id}/${c.title}`);
});

test("YAML drops managedFields and quotes what needs it", () => {
  const y = K.toYaml({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "c", managedFields: [{ a: 1 }] }, data: { a: "yes", b: "x: y", c: "line1\nline2" } });
  assert.ok(!y.includes("managedFields"));
  assert.ok(y.includes('a: "yes"'));
  assert.ok(y.includes('b: "x: y"'));
  assert.ok(y.includes("c: |-\n    line1\n    line2"));
});

test("pod requests and limits add up", () => {
  const r = K.podResources({ spec: { containers: [
    { resources: { requests: { cpu: "100m", memory: "64Mi" }, limits: { cpu: "1" } } },
    { resources: { requests: { cpu: "50m", memory: "64Mi" } } },
  ] } });
  assert.ok(Math.abs(r.cpuReq - 0.15) < 1e-9);
  assert.equal(r.memReq, 128 * 2 ** 20);
  assert.equal(r.cpuLim, null);
});

test("kubectl runs with the extra PATH, the context and a request timeout", async () => {
  replies.push({ code: 0, stdout: "/opt/sdk/bin\n/usr/bin:/bin", stderr: "" });  // the PATH probe
  replies.push({ code: 0, stdout: "ok", stderr: "" });
  assert.equal(await K.kubectl(["get", "ns"], { context: "dev" }), "ok");
  const run = calls.at(-1);
  assert.equal(run[0], "/usr/bin/env");
  assert.match(run[1], /^PATH=\/opt\/sdk\/bin:.*\/home\/test\/google-cloud-sdk\/bin/);
  assert.deepEqual(run.slice(3), ["--context", "dev", "--request-timeout=20s", "get", "ns"]);
});

test("errors are sorted into sign-in, missing helper and other", () => {
  assert.ok(new K.KubeError("error: Reauthentication failed. Please run gcloud auth login").auth);
  const plugin = new K.KubeError("getting credentials: exec: executable gke-gcloud-auth-plugin not found");
  assert.ok(plugin.plugin && !plugin.auth);
  const other = new K.KubeError("dial tcp 10.0.0.1:443: i/o timeout");
  assert.ok(!other.auth && !other.plugin && !other.missing);
});
