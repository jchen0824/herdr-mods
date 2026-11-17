// Demo clusters: made-up kubectl answers for contexts named "demo:…", so the panel can be shown
// (screenshots, trying it out, development) without a cluster. Open with props { demo: true }.
// Everything the panel reads goes through kubectl(), which hands demo contexts here.

const NOW = () => Date.now();
const ago = (ms) => new Date(NOW() - ms).toISOString();
const D = 86400000, H = 3600000;
const hash = (s) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
// Kubernetes-looking random parts ("7f78c9d4b", "x2k9p"), fixed per name.
const ALPHA = "bcdfghjklmnpqrstvwxz2456789";
const suffix = (s, n = 5) => { let h = hash(s), out = ""; for (let i = 0; i < n; i++) { out += ALPHA[h % ALPHA.length]; h = Math.floor(h / ALPHA.length) || hash(s + i); } return out; };

export const CONTEXTS = ["demo:gke_acme_us-central1_shop-prod", "demo:gke_acme_us-central1_shop-staging", "demo:kind-dev"];

// Per cluster: namespace -> deployments [name, replicas, cpu (m), mem (Mi), trouble?]
const APPS = {
  "demo:gke_acme_us-central1_shop-prod": {
    shop: [["storefront", 3, 42, 180], ["checkout-api", 2, 85, 240], ["cart", 2, 18, 96], ["search", 2, 120, 610]],
    payments: [["payments-api", 2, 64, 210], ["payments-worker", 1, 3, 40, "crash"]],
    "ingress-nginx": [["ingress-nginx-controller", 2, 30, 150]],
  },
  "demo:gke_acme_us-central1_shop-staging": {
    shop: [["storefront", 1, 12, 150], ["checkout-api", 1, 20, 200], ["cart", 1, 6, 80], ["search", 1, 35, 420]],
    payments: [["payments-api", 1, 15, 190], ["payments-worker", 1, 9, 70]],
  },
  "demo:kind-dev": {
    dev: [["api", 1, 25, 130], ["web", 1, 8, 90], ["worker", 0, 0, 0]],
  },
};

function deployments(ctx) {
  const out = [];
  for (const [ns, list] of Object.entries(APPS[ctx] ?? {})) {
    for (const [name, replicas, , , trouble] of list) {
      const ready = trouble ? 0 : replicas;
      out.push({
        apiVersion: "apps/v1", kind: "Deployment",
        metadata: { name, namespace: ns, uid: `d-${ctx}-${ns}-${name}`, creationTimestamp: ago(42 * D + hash(name) % 9 * D),
          labels: { app: name, "app.kubernetes.io/part-of": ns }, annotations: { "deployment.kubernetes.io/revision": String(3 + hash(name) % 7) } },
        spec: { replicas, selector: { matchLabels: { app: name } }, strategy: { type: "RollingUpdate" },
          template: { spec: { containers: [{ name: "app", image: `ghcr.io/acme/${name}:1.${hash(name) % 20}.${hash(ns) % 9}` }] } } },
        status: { replicas, readyReplicas: ready, updatedReplicas: replicas, availableReplicas: ready,
          conditions: [{ type: "Available", status: ready === replicas ? "True" : "False", reason: ready === replicas ? "MinimumReplicasAvailable" : "MinimumReplicasUnavailable" }] },
      });
    }
  }
  return out;
}

function pods(ctx) {
  const out = [];
  for (const [ns, list] of Object.entries(APPS[ctx] ?? {})) {
    for (const [name, replicas, cpu, mem, trouble] of list) {
      const rs = suffix(`${ctx}${name}`, 9);
      for (let i = 0; i < replicas; i++) {
        const pod = `${name}-${rs}-${suffix(`${name}${i}${ctx}`)}`;
        const crash = trouble === "crash";
        out.push({
          apiVersion: "v1", kind: "Pod",
          metadata: { name: pod, namespace: ns, uid: `p-${ctx}-${pod}`, creationTimestamp: ago(crash ? 3 * H : (6 + i) * D + hash(pod) % 20 * H),
            labels: { app: name }, ownerReferences: [{ kind: "ReplicaSet", name: `${name}-${rs}` }] },
          spec: { nodeName: `${ctx.split("_").pop()}-pool-${1 + (hash(pod) % 3)}`, serviceAccountName: "default",
            containers: [{ name: "app", image: `ghcr.io/acme/${name}:1.${hash(name) % 20}.${hash(ns) % 9}`,
              ports: [{ containerPort: 8080, name: "http" }],
              resources: { requests: { cpu: `${Math.max(50, Math.round(cpu * 1.5 / 50) * 50)}m`, memory: `${Math.max(64, Math.round(mem * 1.3 / 64) * 64)}Mi` },
                limits: { cpu: "1", memory: `${Math.max(128, Math.round(mem * 2 / 128) * 128)}Mi` } } }] },
          status: {
            phase: "Running", podIP: `10.4.${hash(ns) % 200}.${hash(pod) % 250}`, qosClass: "Burstable",
            containerStatuses: [crash
              ? { name: "app", ready: false, restartCount: 14, state: { waiting: { reason: "CrashLoopBackOff" } },
                lastState: { terminated: { reason: "Error", exitCode: 1, finishedAt: ago(70000) } } }
              : { name: "app", ready: true, restartCount: hash(pod) % 7 === 0 ? 1 : 0, state: { running: { startedAt: ago(5 * D) } } }],
          },
        });
      }
    }
  }
  return out;
}

function nodes(ctx) {
  const base = ctx.split("_").pop();
  return [1, 2, 3].map((i) => ({
    apiVersion: "v1", kind: "Node",
    metadata: { name: `${base}-pool-${i}`, uid: `n-${ctx}-${i}`, creationTimestamp: ago(60 * D), labels: { "node-role.kubernetes.io/worker": "" } },
    spec: {},
    status: { capacity: { cpu: "4", memory: "16Gi", pods: "110" }, allocatable: { cpu: "3920m", memory: "13Gi", pods: "110" },
      conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
      addresses: [{ type: "InternalIP", address: `10.0.0.${10 + i}` }],
      nodeInfo: { kubeletVersion: "v1.31.4", osImage: "Container-Optimized OS", architecture: "amd64", containerRuntimeVersion: "containerd://1.7.24" } },
  }));
}

function services(ctx) {
  return deployments(ctx).map((d) => ({
    apiVersion: "v1", kind: "Service",
    metadata: { name: d.metadata.name, namespace: d.metadata.namespace, uid: `s-${d.metadata.uid}`, creationTimestamp: d.metadata.creationTimestamp },
    spec: { type: d.metadata.name.startsWith("ingress") ? "LoadBalancer" : "ClusterIP", clusterIP: `10.8.${hash(d.metadata.name) % 200}.${hash(d.metadata.namespace) % 250}`,
      selector: { app: d.metadata.name }, ports: [{ name: "http", port: 80, targetPort: 8080, protocol: "TCP" }] },
    status: d.metadata.name.startsWith("ingress") ? { loadBalancer: { ingress: [{ ip: "34.120.18.7" }] } } : {},
  }));
}

function events(ctx) {
  const p = pods(ctx).find((x) => x.status.containerStatuses[0].state.waiting);
  if (!p) return [];
  return [
    { type: "Warning", reason: "BackOff", message: "Back-off restarting failed container app in pod", count: 52 },
    { type: "Normal", reason: "Pulled", message: `Container image "${p.spec.containers[0].image}" already present on machine`, count: 14 },
  ].map((e, i) => ({ apiVersion: "v1", kind: "Event", ...e,
    metadata: { name: `${p.metadata.name}.${i}`, namespace: p.metadata.namespace, uid: `e-${p.metadata.uid}-${i}`, creationTimestamp: ago(3 * H) },
    involvedObject: { kind: "Pod", name: p.metadata.name, namespace: p.metadata.namespace }, lastTimestamp: ago(40000 + i * 9000), source: { component: "kubelet" } }));
}

const LISTS = { pods, deployments, nodes, services, events, namespaces: (ctx) => Object.keys(APPS[ctx] ?? {}).map((n) => ({
  apiVersion: "v1", kind: "Namespace", metadata: { name: n, uid: `ns-${ctx}-${n}`, creationTimestamp: ago(90 * D) }, status: { phase: "Active" } })) };

// CPU and memory that move a little between reads.
function usageOf(ctx, p) {
  const [name] = p.metadata.name.split(/-(?=[a-z0-9]{9}-)/);
  const app = Object.values(APPS[ctx] ?? {}).flat().find((a) => a[0] === name);
  const wobble = 0.8 + ((hash(p.metadata.name) + Math.floor(NOW() / 5000)) % 40) / 100;
  return { cpu: `${Math.round((app?.[2] ?? 5) * wobble)}m`, mem: `${Math.round((app?.[3] ?? 40) * (0.95 + wobble / 20))}Mi` };
}

// ---- logs ----

const ROUTES = ["/api/cart", "/api/products", "/api/checkout", "/api/search?q=shoes", "/healthz", "/api/orders/1842"];
function line(app, t, seed) {
  const r = hash(`${app}${seed}`) % 100;
  if (app === "payments-worker") {
    if (r < 35) return `level=error msg="charge failed" provider=stripe err="connection reset by peer" attempt=${1 + (r % 3)}`;
    if (r < 60) return `level=warn msg="retrying job" queue=payments delay=${2 ** (r % 5)}s`;
    return `level=info msg="processing job" queue=payments id=job_${hash(String(seed)).toString(36)}`;
  }
  if (app.startsWith("ingress")) return `10.4.0.${r} - - [${new Date(t).toUTCString()}] "GET ${ROUTES[r % ROUTES.length]} HTTP/1.1" ${r < 3 ? 502 : 200} ${400 + r * 37} ${(r % 9) / 100 + 0.004}s`;
  if (r < 3) return `{"level":"error","msg":"upstream timeout","route":"${ROUTES[r % ROUTES.length]}","ms":${3000 + r}}`;
  if (r < 9) return `{"level":"warn","msg":"slow request","route":"${ROUTES[r % ROUTES.length]}","ms":${800 + r * 13}}`;
  return `{"level":"info","msg":"request","method":"GET","route":"${ROUTES[r % ROUTES.length]}","status":200,"ms":${4 + (r % 40)}}`;
}

function logs(ctx, args) {
  const ns = args[args.indexOf("-n") + 1];
  const li = args.indexOf("logs");
  let list = pods(ctx).filter((p) => p.metadata.namespace === ns);
  const sel = args.indexOf("-l") >= 0 ? args[args.indexOf("-l") + 1] : null;
  if (sel) { const [k, v] = sel.split(",")[0].split("="); list = list.filter((p) => p.metadata.labels?.[k] === v); }
  else list = list.filter((p) => p.metadata.name === args[li + 1]);
  const since = args.find((a) => a.startsWith("--since-time="))?.slice(13);
  const sinceDur = args.find((a) => a.startsWith("--since="))?.slice(8);
  const from = since ? Date.parse(since) : sinceDur ? NOW() - ({ m: 60000, h: H }[sinceDur.slice(-1)] * parseInt(sinceDur, 10)) : NOW() - 25 * 60000;
  const out = [];
  for (const p of list) {
    const app = p.metadata.labels.app;
    const every = app === "payments-worker" ? 4000 : 1500 + (hash(p.metadata.name) % 1500);
    const start = Math.ceil(from / every) * every;
    const lines = [];
    for (let t = start; t <= NOW(); t += every) lines.push(`[pod/${p.metadata.name}/app] ${new Date(t + (hash(String(t)) % 997)).toISOString()} ${line(app, t, t + p.metadata.name)}`);
    out.push(...(args.includes("--tail=500") ? lines.slice(-500) : lines.slice(-4000)));
  }
  return out.join("\n");
}

// ---- kubectl ----

// The answer kubectl would print for these arguments on demo context `ctx`.
export function kubectl(ctx, args) {
  const a = args.filter((x) => !x.startsWith("--request-timeout"));
  if (a.includes("logs")) return logs(ctx, a);
  if (a.includes("rollout") || a.includes("scale")) return "ok (demo: nothing changed)\n";
  if (a[0] === "get" && a[1] === "--raw") {
    const path = a[2];
    if (path.endsWith("/nodes")) return JSON.stringify({ items: nodes(ctx).map((n, i) => ({ metadata: { name: n.metadata.name }, usage: { cpu: `${900 + i * 610 + (Math.floor(NOW() / 5000) % 7) * 20}m`, memory: `${5 + i * 2}Gi` } })) });
    const ns = /namespaces\/([^/]+)\/pods/.exec(path)?.[1];
    return JSON.stringify({ items: pods(ctx).filter((p) => !ns || p.metadata.namespace === ns).map((p) => {
      const u = usageOf(ctx, p);
      return { metadata: { name: p.metadata.name, namespace: p.metadata.namespace }, containers: [{ name: "app", usage: { cpu: u.cpu, memory: u.mem } }] };
    }) });
  }
  if (a[0] === "get") {
    const res = a[1];
    const ns = a.includes("-n") ? a[a.indexOf("-n") + 1] : null;
    let items = (LISTS[res] ?? (() => []))(ctx);
    if (ns && res !== "namespaces") items = items.filter((o) => o.metadata.namespace === ns);
    const l = a.includes("-l") ? a[a.indexOf("-l") + 1] : null;
    if (l) { const [k, v] = l.split(",")[0].split("="); items = items.filter((o) => o.metadata.labels?.[k] === v); }
    const fs = a.includes("--field-selector") ? a[a.indexOf("--field-selector") + 1] : null;
    if (fs) { const name = /involvedObject\.name=([^,]+)/.exec(fs)?.[1]; items = items.filter((e) => e.involvedObject?.name === name); }
    return JSON.stringify({ items });
  }
  throw new Error(`demo: kubectl ${a.join(" ")} isn't available in demo mode`);
}

export function contexts() {
  return { list: CONTEXTS.map((name) => ({ name, cluster: name, namespace: null, user: "demo" })), current: CONTEXTS[0] };
}
