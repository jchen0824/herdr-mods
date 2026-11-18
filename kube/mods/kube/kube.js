// Kubernetes data for the kube mod: kubectl calls, the resource kinds OpenLens shows, their
// table columns, and small formatters. Nothing here draws.
import { exec, home, checking } from "herdr";
import * as Demo from "./demo.js";

// ---- kubectl ----

const BINS = ["kubectl", "/opt/homebrew/bin/kubectl", "/usr/local/bin/kubectl"];
let kubectlBin = null; // the first one that started

export class KubeError extends Error {
  constructor(text) {
    const t = String(text ?? "").trim();
    super(t || "kubectl failed");
    // A credential plugin kubectl can't find (gke-gcloud-auth-plugin) is a setup problem, not an expired sign-in.
    this.plugin = /executable (\S+) not found|credential plugin that is not installed/i.test(t);
    this.auth = !this.plugin && /gcloud auth login|Reauthentication|refresh.*token|invalid_grant|Unauthorized|You must be logged in|token.*expired/i.test(t);
    this.missing = !this.plugin && /isn't installed|not found/i.test(t) && /kubectl/.test(t);
  }
}

// Herdr runs programs with the login shell's PATH, which can miss folders an interactive
// shell adds (the Google Cloud SDK's bin, where gke-gcloud-auth-plugin lives). kubectl
// runs credential plugins from its PATH, so give it those folders too.
let pathValue = null;
async function kubePath() {
  if (pathValue) return pathValue;
  const h = home();
  const dirs = [
    `${h}/google-cloud-sdk/bin`, "/opt/homebrew/share/google-cloud-sdk/bin", "/usr/local/share/google-cloud-sdk/bin",
    "/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin", "/usr/lib/google-cloud-sdk/bin", "/snap/bin",
    `${h}/.local/bin`, `${h}/bin`, `${h}/.krew/bin`, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
  ];
  try {
    // `herdr-app check` runs init for real: don't start an interactive shell there.
    if (checking()) throw new Error("checking");
    // Where the interactive shell finds the plugin, in case it's somewhere else. No terminal
    // input, so a shell that wants one can't wait for it.
    const sh = await exec("/bin/sh", ["-c", 'p=$("${SHELL:-/bin/zsh}" -ic "command -v gke-gcloud-auth-plugin" </dev/null 2>/dev/null | tail -n 1); [ -n "$p" ] && dirname "$p"; printf "%s" "$PATH"'], { timeout: 8000 });
    const lines = sh.stdout.split("\n");
    const base = lines.pop() ?? "";
    for (const l of lines) if (l.startsWith("/")) dirs.unshift(l.trim());
    pathValue = [...new Set([...dirs, ...base.split(":")].filter(Boolean))].join(":");
  } catch {
    pathValue = [...dirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  }
  return pathValue;
}

// argv prefix that runs kubectl with that PATH (for terminals too).
export const kubeCmd = () => ["/usr/bin/env", `PATH=${pathValue ?? ""}`, kubectlBin ?? "kubectl"];

export const isDemo = (context) => String(context ?? "").startsWith("demo:");

export async function kubectl(args, { context, timeout = 25000, requestTimeout = "20s" } = {}) {
  if (isDemo(context)) {
    try { return Demo.kubectl(context, args); } catch (e) { throw new KubeError(e.message); }
  }
  const full = [...(context ? ["--context", context] : []), `--request-timeout=${requestTimeout}`, ...args];
  const path = await kubePath();
  const order = kubectlBin ? [kubectlBin] : BINS;
  let last = null;
  for (const bin of order) {
    let r;
    try { r = await exec("/usr/bin/env", [`PATH=${path}`, bin, ...full], { timeout }); } catch (e) { last = e; continue; }
    if (r.code === 127) { last = new Error("not found"); continue; }
    kubectlBin = bin;
    if (r.code !== 0) throw new KubeError(r.stderr || r.stdout);
    return r.stdout;
  }
  throw new KubeError(`kubectl isn't installed or can't start (${String(last?.message ?? last)})`);
}

export const kubectlPath = () => kubectlBin ?? "kubectl";

// ---- contexts ----

export async function contexts() {
  const cfg = parseJSON(await kubectl(["config", "view", "-o", "json"]), "kubeconfig");
  const list = (cfg.contexts ?? []).map((c) => ({
    name: c.name, cluster: c.context?.cluster ?? "", namespace: c.context?.namespace ?? null, user: c.context?.user ?? "",
  }));
  return { list, current: cfg["current-context"] ?? null };
}

// A readable name: gke_<project>_<location>_<cluster> -> "cluster · location".
export function contextLabel(name) {
  if (isDemo(name)) name = name.slice(5);
  const gke = /^gke_([^_]+)_([^_]+)_(.+)$/.exec(name);
  if (gke) return { title: gke[3], sub: `GKE · ${gke[2]}` };
  const cg = /^connectgateway_([^_]+)_([^_]+)_(.+)$/.exec(name);
  if (cg) return { title: cg[3], sub: `Connect gateway · ${cg[2]}` };
  const eks = /^arn:aws:eks:([^:]+):\d+:cluster\/(.+)$/.exec(name);
  if (eks) return { title: eks[2], sub: `EKS · ${eks[1]}` };
  return { title: name, sub: "" };
}

export const isProd = (name) => /(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/i.test(name ?? "");

// ---- formatting ----

export function age(ts, now = Date.now()) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((now - Date.parse(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h < 10 && m ? `${h}h${m}m` : `${h}h`; }
  if (s < 86400 * 365) { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600); return d < 10 && h ? `${d}d${h}h` : `${d}d`; }
  return `${Math.floor(s / (86400 * 365))}y`;
}
const ageMs = (ts) => (ts ? Date.parse(ts) : 0);

export function cpu(q) {
  if (q == null) return "";
  const s = String(q);
  if (s.endsWith("m")) return `${(parseInt(s, 10) / 1000).toFixed(2).replace(/\.?0+$/, "")}`;
  return s;
}
export function mem(q) {
  if (q == null) return "";
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(q));
  if (!m) return String(q);
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] ?? 1;
  const b = parseFloat(m[1]) * mult;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)}GiB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)}MiB`;
  return `${Math.round(b / 1024)}KiB`;
}

// ---- pods ----

export function podStatus(p) {
  if (p.metadata?.deletionTimestamp) return "Terminating";
  const cs = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  for (const c of p.status?.containerStatuses ?? []) {
    if (c.state?.waiting?.reason) return c.state.waiting.reason;
    if (c.state?.terminated?.reason && p.status?.phase !== "Succeeded") return c.state.terminated.reason;
  }
  for (const c of p.status?.initContainerStatuses ?? []) {
    if (c.state?.waiting?.reason && c.state.waiting.reason !== "PodInitializing") return `Init:${c.state.waiting.reason}`;
  }
  if (p.status?.reason) return p.status.reason;
  void cs;
  return p.status?.phase ?? "Unknown";
}
export const podReady = (p) => {
  const cs = p.status?.containerStatuses ?? [];
  return `${cs.filter((c) => c.ready).length}/${(p.spec?.containers ?? []).length}`;
};
export const podRestarts = (p) => (p.status?.containerStatuses ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0);

// The health of a status word: ok, warn, bad, done or null (neutral).
export function health(word) {
  const w = String(word ?? "");
  if (/^(Running|Ready|Active|Bound|Available|Complete|True|Normal|Succeeded)$/.test(w)) return w === "Succeeded" || w === "Complete" ? "done" : "ok";
  if (/^(Pending|ContainerCreating|PodInitializing|Terminating|Progressing|Released|Init:|Suspended|Scaling)/.test(w)) return "warn";
  if (/(Err|Fail|BackOff|Crash|OOM|Evicted|Unknown|NotReady|Lost|Warning|Error|Invalid|Unschedulable|Degraded)/i.test(w)) return "bad";
  return null;
}

const owner = (o) => {
  const r = o.metadata?.ownerReferences?.[0];
  return r ? `${r.kind}/${r.name}` : "";
};
const condition = (o, type) => o.status?.conditions?.find((c) => c.type === type)?.status;
const nodeRoles = (n) => Object.keys(n.metadata?.labels ?? {}).filter((k) => k.startsWith("node-role.kubernetes.io/")).map((k) => k.split("/")[1]).join(",") || "<none>";
const svcPorts = (s) => (s.spec?.ports ?? []).map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`).join(", ");
const lbAddr = (o) => (o.status?.loadBalancer?.ingress ?? []).map((i) => i.ip ?? i.hostname).filter(Boolean).join(", ");

const pct = (used, total) => (used == null || !total ? "" : `${Math.round((used / total) * 100)}%`);

// ---- kinds ----
// Each column: title, w (px, or "flex"), get(o) -> text, sort?(o) -> value, status? (colour by health),
// hide? (px of table width below which it is left out).
const NAME = { title: "Name", w: "flex", get: (o) => o.metadata?.name ?? "" };
const NS = { title: "Namespace", w: 150, get: (o) => o.metadata?.namespace ?? "", hide: 760, ns: true };
const AGE = { title: "Age", w: 64, get: (o) => age(o.metadata?.creationTimestamp), sort: (o) => -ageMs(o.metadata?.creationTimestamp) };

export const KINDS = [
  { group: "Cluster", id: "nodes", label: "Nodes", res: "nodes", kind: "Node", cluster: true, cols: [
    NAME,
    // With metrics-server: use against allocatable; without, capacity.
    { title: "CPU", w: 76, hide: 640, get: (o) => (o._use ? pct(o._use.cpu, cores(o.status?.allocatable?.cpu)) : cpu(o.status?.capacity?.cpu)),
      sort: (o) => (o._use ? o._use.cpu / (cores(o.status?.allocatable?.cpu) || 1) : cores(o.status?.capacity?.cpu) ?? 0) },
    { title: "Memory", w: 80, hide: 640, get: (o) => (o._use ? pct(o._use.mem, bytes(o.status?.allocatable?.memory)) : mem(o.status?.capacity?.memory)),
      sort: (o) => (o._use ? o._use.mem / (bytes(o.status?.allocatable?.memory) || 1) : bytes(o.status?.capacity?.memory) ?? 0) },
    { title: "Roles", w: 110, get: nodeRoles, hide: 900 },
    { title: "Version", w: 120, get: (o) => o.status?.nodeInfo?.kubeletVersion ?? "", hide: 760 },
    AGE,
    { title: "Status", w: 100, status: true, get: (o) => (o.spec?.unschedulable ? "SchedulingDisabled" : condition(o, "Ready") === "True" ? "Ready" : "NotReady") },
  ] },
  { group: "Workloads", id: "pods", label: "Pods", res: "pods", kind: "Pod", logs: true, cols: [
    NAME, NS,
    { title: "Ready", w: 56, get: podReady },
    { title: "Restarts", w: 70, get: (o) => String(podRestarts(o)), sort: (o) => podRestarts(o) },
    { title: "CPU", w: 60, hide: 820, use: true, get: (o) => fmtCores(o._use?.cpu), sort: (o) => o._use?.cpu ?? -1 },
    { title: "Memory", w: 70, hide: 820, use: true, get: (o) => fmtBytes(o._use?.mem), sort: (o) => o._use?.mem ?? -1 },
    { title: "Controlled by", w: 170, get: owner, hide: 1080 },
    { title: "Node", w: 170, get: (o) => o.spec?.nodeName ?? "", hide: 960 },
    AGE,
    { title: "Status", w: 130, status: true, get: podStatus },
  ] },
  { group: "Workloads", id: "deployments", label: "Deployments", res: "deployments", kind: "Deployment", group_api: "apps/v1", logs: true, restart: true, scale: true, cols: [
    NAME, NS,
    { title: "Pods", w: 64, get: (o) => `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}` },
    { title: "Up to date", w: 80, get: (o) => String(o.status?.updatedReplicas ?? 0), hide: 760 },
    AGE,
    { title: "Status", w: 110, status: true, get: (o) => ((o.spec?.replicas ?? 0) === 0 ? "Scaled to 0" : condition(o, "Available") === "True" ? ((o.status?.readyReplicas ?? 0) < (o.spec?.replicas ?? 0) ? "Progressing" : "Available") : "Unavailable") },
  ] },
  { group: "Workloads", id: "statefulsets", label: "StatefulSets", res: "statefulsets", kind: "StatefulSet", logs: true, restart: true, scale: true, cols: [
    NAME, NS,
    { title: "Pods", w: 64, get: (o) => `${o.status?.readyReplicas ?? 0}/${o.spec?.replicas ?? 0}` },
    { title: "Service", w: 150, get: (o) => o.spec?.serviceName ?? "", hide: 900 },
    AGE,
  ] },
  { group: "Workloads", id: "daemonsets", label: "DaemonSets", res: "daemonsets", kind: "DaemonSet", logs: true, restart: true, cols: [
    NAME, NS,
    { title: "Pods", w: 64, get: (o) => `${o.status?.numberReady ?? 0}/${o.status?.desiredNumberScheduled ?? 0}` },
    { title: "Node selector", w: 180, get: (o) => Object.entries(o.spec?.template?.spec?.nodeSelector ?? {}).map(([k, v]) => `${k}=${v}`).join(", "), hide: 960 },
    AGE,
  ] },
  { group: "Workloads", id: "replicasets", label: "ReplicaSets", res: "replicasets", kind: "ReplicaSet", cols: [
    NAME, NS,
    { title: "Desired", w: 64, get: (o) => String(o.spec?.replicas ?? 0) },
    { title: "Ready", w: 56, get: (o) => String(o.status?.readyReplicas ?? 0) },
    { title: "Controlled by", w: 180, get: owner, hide: 960 },
    AGE,
  ] },
  { group: "Workloads", id: "jobs", label: "Jobs", res: "jobs", kind: "Job", logs: true, cols: [
    NAME, NS,
    { title: "Completions", w: 90, get: (o) => `${o.status?.succeeded ?? 0}/${o.spec?.completions ?? 1}` },
    { title: "Controlled by", w: 170, get: owner, hide: 960 },
    AGE,
    { title: "Status", w: 100, status: true, get: (o) => (condition(o, "Complete") === "True" ? "Complete" : condition(o, "Failed") === "True" ? "Failed" : o.status?.active ? "Running" : "Pending") },
  ] },
  { group: "Workloads", id: "cronjobs", label: "CronJobs", res: "cronjobs", kind: "CronJob", cols: [
    NAME, NS,
    { title: "Schedule", w: 120, get: (o) => o.spec?.schedule ?? "" },
    { title: "Active", w: 56, get: (o) => String((o.status?.active ?? []).length) },
    { title: "Last schedule", w: 100, get: (o) => age(o.status?.lastScheduleTime), sort: (o) => -ageMs(o.status?.lastScheduleTime), hide: 760 },
    AGE,
    { title: "Status", w: 90, status: true, get: (o) => (o.spec?.suspend ? "Suspended" : "Active") },
  ] },
  { group: "Config", id: "configmaps", label: "ConfigMaps", res: "configmaps", kind: "ConfigMap", cols: [
    NAME, NS,
    { title: "Keys", w: 220, get: (o) => Object.keys({ ...(o.data ?? {}), ...(o.binaryData ?? {}) }).join(", "), hide: 760 },
    AGE,
  ] },
  { group: "Config", id: "secrets", label: "Secrets", res: "secrets", kind: "Secret", secret: true, cols: [
    NAME, NS,
    { title: "Type", w: 200, get: (o) => o.type ?? "", hide: 760 },
    { title: "Keys", w: 56, get: (o) => String(Object.keys(o.data ?? {}).length) },
    AGE,
  ] },
  { group: "Config", id: "hpa", label: "HPA", res: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler", cols: [
    NAME, NS,
    { title: "Target", w: 170, get: (o) => `${o.spec?.scaleTargetRef?.kind ?? ""}/${o.spec?.scaleTargetRef?.name ?? ""}`, hide: 760 },
    { title: "Min", w: 44, get: (o) => String(o.spec?.minReplicas ?? 1) },
    { title: "Max", w: 44, get: (o) => String(o.spec?.maxReplicas ?? "") },
    { title: "Replicas", w: 70, get: (o) => String(o.status?.currentReplicas ?? 0) },
    AGE,
  ] },
  { group: "Network", id: "services", label: "Services", res: "services", kind: "Service", logs: true, cols: [
    NAME, NS,
    { title: "Type", w: 100, get: (o) => o.spec?.type ?? "" },
    { title: "Cluster IP", w: 120, get: (o) => o.spec?.clusterIP ?? "", hide: 900 },
    { title: "Ports", w: 160, get: svcPorts, hide: 760 },
    { title: "External IP", w: 130, get: (o) => lbAddr(o) || (o.spec?.externalIPs ?? []).join(", "), hide: 1080 },
    AGE,
  ] },
  { group: "Network", id: "ingresses", label: "Ingresses", res: "ingresses", kind: "Ingress", cols: [
    NAME, NS,
    { title: "Hosts", w: 220, get: (o) => (o.spec?.rules ?? []).map((r) => r.host).filter(Boolean).join(", "), hide: 760 },
    { title: "Address", w: 130, get: lbAddr, hide: 960 },
    AGE,
  ] },
  { group: "Storage", id: "pvcs", label: "PersistentVolumeClaims", res: "persistentvolumeclaims", kind: "PersistentVolumeClaim", cols: [
    NAME, NS,
    { title: "Class", w: 120, get: (o) => o.spec?.storageClassName ?? "", hide: 900 },
    { title: "Size", w: 70, get: (o) => o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage ?? "" },
    AGE,
    { title: "Status", w: 80, status: true, get: (o) => o.status?.phase ?? "" },
  ] },
  { group: "Storage", id: "pvs", label: "PersistentVolumes", res: "persistentvolumes", kind: "PersistentVolume", cluster: true, cols: [
    NAME,
    { title: "Capacity", w: 76, get: (o) => o.spec?.capacity?.storage ?? "" },
    { title: "Claim", w: 220, get: (o) => (o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : ""), hide: 760 },
    { title: "Class", w: 120, get: (o) => o.spec?.storageClassName ?? "", hide: 960 },
    AGE,
    { title: "Status", w: 80, status: true, get: (o) => o.status?.phase ?? "" },
  ] },
  { group: "Storage", id: "storageclasses", label: "StorageClasses", res: "storageclasses", kind: "StorageClass", cluster: true, cols: [
    NAME,
    { title: "Provisioner", w: 220, get: (o) => o.provisioner ?? "" },
    { title: "Reclaim", w: 80, get: (o) => o.reclaimPolicy ?? "", hide: 760 },
    { title: "Default", w: 64, get: (o) => (o.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ? "Yes" : "") },
    AGE,
  ] },
  { group: "Cluster", id: "namespaces", label: "Namespaces", res: "namespaces", kind: "Namespace", cluster: true, cols: [
    NAME,
    { title: "Labels", w: 260, get: (o) => Object.entries(o.metadata?.labels ?? {}).filter(([k]) => k !== "kubernetes.io/metadata.name").map(([k, v]) => `${k}=${v}`).join(", "), hide: 700 },
    AGE,
    { title: "Status", w: 80, status: true, get: (o) => o.status?.phase ?? "" },
  ] },
  { group: "Cluster", id: "events", label: "Events", res: "events", kind: "Event", events: true, cols: [
    { title: "Type", w: 70, status: true, get: (o) => o.type ?? "" },
    { title: "Message", w: "flex", get: (o) => (o.message ?? "").replace(/\s+/g, " ") },
    { title: "Namespace", w: 130, get: (o) => o.metadata?.namespace ?? "", hide: 900, ns: true },
    { title: "Object", w: 200, get: (o) => `${o.involvedObject?.kind ?? ""}/${o.involvedObject?.name ?? ""}`, hide: 760 },
    { title: "Count", w: 50, get: (o) => String(o.count ?? 1), sort: (o) => o.count ?? 1, hide: 640 },
    { title: "Last seen", w: 76, get: (o) => age(lastSeen(o)), sort: (o) => -ageMs(lastSeen(o)) },
  ] },
];

export const lastSeen = (e) => e.lastTimestamp ?? e.eventTime ?? e.series?.lastObservedTime ?? e.metadata?.creationTimestamp;
export const kindById = (id) => KINDS.find((k) => k.id === id) ?? KINDS[1];
export const kindByName = (kind) => KINDS.find((k) => k.kind === kind);

// Lists a kind. Secrets lose their values here: only key names are kept in memory.
// Herdr caps a program's output at 8 MiB, and `kubectl get -o json` pretty-prints (~22 KB a
// pod), so a big all-namespaces list was cut off mid-JSON. Ask the API server directly instead:
// compact JSON (~9 KB a pod), PAGE objects at a time with its continue token.
export let PAGE = 250; // let: tests page with small sizes
export const setPage = (n) => { PAGE = n; };
export const MAX_PAGES = 400; // 100,000 objects at the default page size

export function listPath(k, namespace) {
  const api = apiOf(k);
  const base = api === "v1" ? "/api/v1" : `/apis/${api}`;
  return !k.cluster && namespace ? `${base}/namespaces/${encodeURIComponent(namespace)}/${k.res}` : `${base}/${k.res}`;
}

// JSON from kubectl, with a clear error when it was cut short.
export function parseJSON(text, what) {
  try { return JSON.parse(text); }
  catch (e) { throw new KubeError(`kubectl returned unreadable JSON for ${what} (${text.length} bytes): ${e.message}`); }
}

// Every object at an API path, a page at a time (managedFields dropped as they arrive).
export async function rawList(context, path, params = {}, what = path) {
  const items = [];
  let cont = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    // Built by hand: Herdr's QuickJS may not have URLSearchParams.
    const q = Object.entries({ ...params, limit: String(PAGE), ...(cont ? { continue: cont } : {}) })
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const out = parseJSON(await kubectl(["get", "--raw", `${path}?${q}`], { context, timeout: 40000 }), what);
    for (const o of out.items ?? []) { if (o.metadata) delete o.metadata.managedFields; items.push(o); }
    cont = out.metadata?.continue ?? "";
    if (!cont) return items;
  }
  // The server still had more: never show a partial list as if it were all of it.
  throw new KubeError(`${what}: stopped after ${MAX_PAGES} pages (${items.length} objects) and the list was still going; not showing an incomplete list`);
}

export async function list(k, { context, namespace }) {
  let raw;
  if (isDemo(context)) {
    const scope = k.cluster ? [] : namespace ? ["-n", namespace] : ["-A"];
    raw = parseJSON(await kubectl(["get", k.res, ...scope, "-o", "json"], { context, timeout: 40000 }), k.res).items ?? [];
  } else {
    raw = await rawList(context, listPath(k, namespace), {}, k.res);
  }
  const items = raw.map((o) => {
    const x = { apiVersion: o.apiVersion ?? apiOf(k), kind: o.kind ?? k.kind, ...o };
    return k.secret ? redactSecret(x) : x;
  });
  if (k.events) items.sort((a, b) => ageMs(lastSeen(b)) - ageMs(lastSeen(a)));
  return items;
}

function apiOf(k) {
  return { Deployment: "apps/v1", StatefulSet: "apps/v1", DaemonSet: "apps/v1", ReplicaSet: "apps/v1", Job: "batch/v1", CronJob: "batch/v1",
    Ingress: "networking.k8s.io/v1", StorageClass: "storage.k8s.io/v1", HorizontalPodAutoscaler: "autoscaling/v2" }[k.kind] ?? "v1";
}

export function redactSecret(o) {
  const data = Object.fromEntries(Object.keys(o.data ?? {}).map((key) => [key, `<hidden: ${Math.floor(((o.data[key] ?? "").length * 3) / 4)} bytes>`]));
  const ann = { ...(o.metadata?.annotations ?? {}) };
  if (ann["kubectl.kubernetes.io/last-applied-configuration"]) ann["kubectl.kubernetes.io/last-applied-configuration"] = "<hidden>";
  const { stringData: _s, ...rest } = o;
  return { ...rest, data, metadata: { ...o.metadata, annotations: ann } };
}

export async function namespaces(context) {
  const out = parseJSON(await kubectl(["get", "namespaces", "-o", "json"], { context }), "namespaces");
  return (out.items ?? []).map((n) => n.metadata.name).sort();
}

export async function eventsFor(o, context) {
  const ns = o.metadata?.namespace;
  const sel = `involvedObject.name=${o.metadata?.name},involvedObject.kind=${o.kind}`;
  const out = parseJSON(await kubectl(["get", "events", ...(ns ? ["-n", ns] : ["-A"]), "--field-selector", sel, "-o", "json"], { context }), "events");
  return (out.items ?? []).sort((a, b) => ageMs(lastSeen(b)) - ageMs(lastSeen(a)));
}

// The pods a workload or service selects.
export async function podsFor(o, context) {
  const sel = o.kind === "Service" ? o.spec?.selector : o.spec?.selector?.matchLabels;
  if (!sel || !Object.keys(sel).length) return [];
  const label = Object.entries(sel).map(([k, v]) => `${k}=${v}`).join(",");
  if (isDemo(context)) {
    const out = parseJSON(await kubectl(["get", "pods", "-n", o.metadata.namespace, "-l", label, "-o", "json"], { context }), "pods");
    return (out.items ?? []).map((p) => ({ apiVersion: "v1", kind: "Pod", ...p }));
  }
  const pods = await rawList(context, `/api/v1/namespaces/${encodeURIComponent(o.metadata.namespace)}/pods`, { labelSelector: label }, "pods");
  return pods.map((p) => ({ apiVersion: "v1", kind: "Pod", ...p }));
}

// ---- usage (metrics-server) ----

// CPU in cores from "250m", "1", "123456789n", "5u".
export function cores(q) {
  if (q == null || q === "") return null;
  const m = /^(\d+(?:\.\d+)?)([numk]?)$/.exec(String(q));
  if (!m) return null;
  return parseFloat(m[1]) * ({ n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3 }[m[2]] ?? 1);
}
// Memory in bytes from "123Ki", "1Gi", "500M", "1e9".
export function bytes(q) {
  if (q == null || q === "") return null;
  const m = /^(\d+(?:\.\d+)?(?:e\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|k|K|M|G|T|P|E|m)?$/.exec(String(q));
  if (!m) return null;
  return parseFloat(m[1]) * ({ Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, m: 1e-3 }[m[2]] ?? 1);
}
export function fmtCores(c) {
  if (c == null) return "";
  return c < 1 ? `${Math.round(c * 1000)}m` : `${c.toFixed(c < 10 ? 2 : 1).replace(/\.?0+$/, "")}`;
}
export function fmtBytes(b) {
  if (b == null) return "";
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(1)}Gi`;
  if (b >= 2 ** 20) return `${Math.round(b / 2 ** 20)}Mi`;
  return `${Math.round(b / 2 ** 10)}Ki`;
}

// Live usage from metrics-server: Map of "namespace/name" (pods) or "name" (nodes) to
// { cpu: cores, mem: bytes }. Rejects when the cluster has no metrics API.
export async function usage(kind, context, namespace) {
  const path = kind === "nodes"
    ? "/apis/metrics.k8s.io/v1beta1/nodes"
    : `/apis/metrics.k8s.io/v1beta1/${namespace ? `namespaces/${namespace}/` : ""}pods`;
  const out = parseJSON(await kubectl(["get", "--raw", path], { context }), "metrics");
  const m = new Map();
  for (const it of out.items ?? []) {
    const key = it.metadata?.namespace ? `${it.metadata.namespace}/${it.metadata.name}` : it.metadata?.name;
    if (kind === "nodes") m.set(key, { cpu: cores(it.usage?.cpu), mem: bytes(it.usage?.memory) });
    else {
      const cs = it.containers ?? [];
      m.set(key, {
        cpu: cs.reduce((n, c) => n + (cores(c.usage?.cpu) ?? 0), 0),
        mem: cs.reduce((n, c) => n + (bytes(c.usage?.memory) ?? 0), 0),
        containers: Object.fromEntries(cs.map((c) => [c.name, { cpu: cores(c.usage?.cpu), mem: bytes(c.usage?.memory) }])),
      });
    }
  }
  return m;
}

// A pod's summed requests and limits, in cores and bytes (null when none are set).
export function podResources(p) {
  const sum = (which, res, parse) => {
    const vals = (p.spec?.containers ?? []).map((c) => parse(c.resources?.[which]?.[res]));
    return vals.some((v) => v == null) || !vals.length ? null : vals.reduce((a, b) => a + b, 0);
  };
  return {
    cpuReq: sum("requests", "cpu", cores), cpuLim: sum("limits", "cpu", cores),
    memReq: sum("requests", "memory", bytes), memLim: sum("limits", "memory", bytes),
  };
}

// ---- YAML, from the object already in hand (managedFields left out, as OpenLens does) ----

// A plain YAML scalar can't start with an indicator (@ and ` are reserved).
const PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9_ ./@:,()+=-]*$/;
// Words YAML 1.1 or 1.2 reads as something other than a string.
const RESERVED = /^(true|false|null|yes|no|on|off|y|n|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;
// Safe to write unquoted, as a key or a value: reads back as the same string.
// Anything number-shaped ("0.", "1_000", ".5", "1e3") is quoted rather than matched exactly
// against YAML's number grammars: extra quotes are harmless in a read-only view.
const NUMBERISH = /^[-+]?[\d._]*([eE][-+]?[\d_]*)?$/;
const plain = (s) => s !== "" && PLAIN.test(s) && !RESERVED.test(s) && !NUMBERISH.test(s) && !/: |:$| #|\s$/.test(s);
function scalar(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  return plain(s) ? s : JSON.stringify(s);
}
const keyOf = (k) => (plain(k) ? k : JSON.stringify(k));

function block(v, ind) {
  if (Array.isArray(v)) {
    if (!v.length) return null;
    return v.map((x) => {
      if (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length) {
        const inner = block(x, `${ind}  `);
        return `${ind}- ${inner.slice(ind.length + 2)}`;
      }
      if (Array.isArray(x) && x.length) return `${ind}-\n${block(x, `${ind}  `)}`;
      return `${ind}- ${inline(x, ind)}`;
    }).join("\n");
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (!keys.length) return null;
    return keys.map((k) => {
      const x = v[k];
      if (x && typeof x === "object") {
        const inner = block(x, Array.isArray(x) ? ind : `${ind}  `);
        return inner == null ? `${ind}${keyOf(k)}: ${Array.isArray(x) ? "[]" : "{}"}` : `${ind}${keyOf(k)}:\n${inner}`;
      }
      return `${ind}${keyOf(k)}: ${inline(x, ind)}`;
    }).join("\n");
  }
  return `${ind}${inline(v, ind)}`;
}
function inline(x, ind) {
  if (Array.isArray(x)) return "[]";
  if (x && typeof x === "object") return "{}";
  if (typeof x === "string" && x.includes("\n")) {
    const body = x.replace(/\n$/, "").split("\n").map((l) => (l ? `${ind}  ${l}` : "")).join("\n");
    return `|${x.endsWith("\n") ? "" : "-"}\n${body}`;
  }
  return scalar(x);
}
export function toYaml(o) {
  const { metadata, ...rest } = o;
  const { managedFields: _m, ...meta } = metadata ?? {};
  const ordered = { apiVersion: rest.apiVersion, kind: rest.kind, metadata: meta };
  for (const [k, v] of Object.entries(rest)) if (k !== "apiVersion" && k !== "kind") ordered[k] = v;
  return `${block(ordered, "")}\n`;
}
