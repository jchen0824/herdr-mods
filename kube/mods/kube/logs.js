// Log lines for the kube log viewer: the kubectl arguments, parsing, levels, merging and
// filtering. Nothing here runs programs or draws, so it can be tested with plain Node.

export const RANGES = [
  { id: "tail", label: "tail 500", args: ["--tail=500"] },
  { id: "5m", label: "5m", args: ["--since=5m"] },
  { id: "15m", label: "15m", args: ["--since=15m"] },
  { id: "1h", label: "1h", args: ["--since=1h"] },
  { id: "6h", label: "6h", args: ["--since=6h"] },
  { id: "24h", label: "24h", args: ["--since=24h"] },
];
export const rangeById = (id) => RANGES.find((r) => r.id === id) ?? RANGES[0];

export const LEVELS = ["all", "warn", "error"];
export const MAX_LINES = 20000;

// What to read: a pod (optionally one container) or every pod a workload selects.
// spec: { context, namespace, kind, name, selector?, container?, previous? }
export function target(spec) {
  if (spec.kind === "Pod") return [spec.name, ...(spec.container ? ["-c", spec.container] : ["--all-containers"])];
  const sel = spec.selector && Object.keys(spec.selector).length
    ? Object.entries(spec.selector).map(([k, v]) => `${k}=${v}`).join(",") : null;
  return [...(sel ? ["-l", sel] : [`${spec.kind.toLowerCase()}/${spec.name}`]), "--all-containers", "--max-log-requests=30"];
}

// One read. `since` (an RFC 3339 time) asks only for lines from then on, for following.
export function args(spec, { range = "tail", since = null } = {}) {
  const when = since ? [`--since-time=${since}`] : spec.previous ? ["--tail=2000"] : rangeById(range).args;
  return [
    "-n", spec.namespace, "logs", ...target(spec),
    "--prefix", "--timestamps", "--ignore-errors", "--limit-bytes=8000000",
    ...(spec.previous ? ["--previous"] : []), ...when,
  ];
}

// "[pod/name/container] 2026-11-16T15:42:42.123456789Z message"
const LINE = /^(?:\[([^\]]+)\] )?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)) ?(.*)$/;

export function parse(raw) {
  const m = LINE.exec(raw);
  if (!m) return { src: "", ts: null, at: "", text: raw, level: level(raw) };
  const src = (m[1] ?? "").replace(/^pod\//, "");
  return { src, ts: m[2], at: sortable(m[2]), text: m[3], level: level(m[3]) };
}

// Timestamps compare as text once their fraction has nine digits ("…:01Z" < "…:01.5Z").
export function sortable(ts) {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(.*)$/.exec(ts ?? "");
  return m ? `${m[1]}.${(m[2] ?? "").padEnd(9, "0").slice(0, 9)}${m[3]}` : "";
}

// error, warn, info, debug or null, from JSON ("level":"warn"), logfmt (level=warn) or words.
export function level(text) {
  const kv = /["']?(?:level|lvl|severity|loglevel)["']?\s*[:=]\s*["']?([A-Za-z]+)/i.exec(text);
  const w = (kv ? kv[1] : (/\b(FATAL|PANIC|CRIT(?:ICAL)?|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i.exec(text) ?? [])[1] ?? "").toLowerCase();
  if (/^(fatal|panic|crit|critical|error|err|e)$/.test(w)) return "error";
  if (/^(warn|warning|w)$/.test(w)) return "warn";
  if (/^(info|notice|i)$/.test(w)) return "info";
  if (/^(debug|trace|d)$/.test(w)) return "debug";
  if (/\b(Traceback|Exception|panic:)/.test(text)) return "error";
  return null;
}

export const lineKey = (l) => `${l.src}\u0000${l.ts}\u0000${l.text}`;

// Adds newly read lines to `lines` (kept in time order), skipping ones already there.
// `seen` holds the keys of the lines at the newest timestamp, the only ones a
// --since-time read can repeat. Returns how many were added.
export function merge(state, out) {
  const fresh = [];
  for (const raw of out.split("\n")) {
    if (!raw) continue;
    const l = parse(raw);
    const k = lineKey(l);
    if (state.seen.has(k)) continue;
    fresh.push(l);
  }
  if (!fresh.length) return 0;
  fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const l of fresh) {
    l.id = state.next++;
    state.lines.push(l);
    if (l.at && (!state.lastAt || l.at > state.lastAt)) { state.last = l.ts; state.lastAt = l.at; state.seen = new Set(); }
    if (l.at && l.at === state.lastAt) state.seen.add(lineKey(l));
  }
  if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
  if (state.lines.length > fresh.length && fresh[0].at) {
    // Lines from several pods can arrive out of order across reads: keep the whole list sorted.
    const before = state.lines[state.lines.length - fresh.length - 1];
    if (before?.at && fresh[0].at && fresh[0].at < before.at) state.lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
  }
  return fresh.length;
}
export const emptyState = () => ({ lines: [], seen: new Set(), last: null, lastAt: "", next: 0 });

// The lines to show: hidden sources, level and (with onlyMatches) the search.
export function visible(lines, { hidden = new Set(), lvl = "all", q = "", onlyMatches = false } = {}) {
  const needle = q.toLowerCase();
  return lines.filter((l) => {
    if (hidden.has(l.src)) return false;
    if (lvl === "error" && l.level !== "error") return false;
    if (lvl === "warn" && l.level !== "error" && l.level !== "warn") return false;
    if (onlyMatches && needle && !l.text.toLowerCase().includes(needle)) return false;
    return true;
  });
}

// Where the search matches inside one line's text: [[start, end], ...].
export function matches(text, q) {
  if (!q) return [];
  const out = [], hay = text.toLowerCase(), needle = q.toLowerCase();
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 50; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length]);
  return out;
}

// Sources in first-seen order, each with a stable colour and a line count.
export const COLORS = ["#4fb3ff", "#ffaf5f", "#d787d7", "#87d787", "#af87ff", "#ff875f", "#00d7ff", "#ffd700", "#ff5f87", "#87d7af"];
export function sources(lines) {
  const m = new Map();
  for (const l of lines) m.set(l.src, (m.get(l.src) ?? 0) + 1);
  return [...m.entries()].map(([src, count]) => ({ src, count }));
}
export function colorOf(order, src) {
  let i = order.indexOf(src);
  if (i < 0) { order.push(src); i = order.length - 1; }
  return COLORS[i % COLORS.length];
}

// "pod/container" -> a short label: the pod's random suffix and the container.
export function shortSrc(src) {
  const [pod, container] = src.split("/");
  const tail = (pod ?? "").split("-").slice(-2).join("-");
  return container ? `${tail}/${container}` : tail;
}

export function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// The text copied or handed to an agent.
export function asText(lines, { time = true, src = true } = {}) {
  return lines.map((l) => `${time && l.ts ? `${l.ts} ` : ""}${src && l.src ? `[${l.src}] ` : ""}${l.text}`).join("\n");
}
