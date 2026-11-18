// Kubernetes: an OpenLens-style cluster view for Herdr.
// Left: cluster(s) and namespace pickers and the resource tree. Middle: the resource table.
// Right: the selected object's details, usage, YAML and actions. Logs open in a log viewer
// pane (props { logs }); shells, port-forwards and describe open as terminals split below.
// Changes (restart, scale) are confirmed first; nothing deletes or edits YAML.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Popover, Scrollbar, v_virtual_list, Editor, EditorState } from "gpui-base";
import { theme, run, panes, spaces, focused, notify, settings, props, exec, layout } from "herdr";
import * as K from "./kube.js";
import { LogPanel } from "./logview.js";
import * as Demo from "./demo.js";

const SIDEBAR_W = 216;
const ROW_H = 30;
const ICON = (n) => `mods/kube/icons/${n}.svg`;
const SHELL = "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* none */ } },
};
const CLUSTER_COL = { title: "Cluster", w: 120, cluster: true, get: (o) => K.contextLabel(o._ctx ?? "").title };
const msg = (e) => String(e?.message ?? e).split("\n").filter((l) => l.trim()).slice(0, 6).join("\n");

export default class Kube extends View {
  init(_props, cx) {
    // A log viewer pane: everything else here is the cluster view.
    const p = props();
    if (p?.logs) { this.lp = new LogPanel(p.logs, cx); return; }
    this.demo = Boolean(p?.demo);   // made-up clusters (demo.js), for screenshots and trying it out
    this.ctxs = [];
    this.sel = [];                // the clusters shown together; sel[0] is the primary
    this.ctxErrors = {};          // per cluster, when only some fail
    this.hasUse = false;          // metrics-server answered for the shown list
    this.usage = null;            // usage for the drawer: Map from K.usage
    this.ctx = null;
    this.nsList = [];
    this.ns = null;               // null: all namespaces
    this.kindId = store.get("kube.kind") ?? "pods";
    this.items = [];
    this.loading = false;
    this.error = null;
    this.updatedAt = null;
    this.gen = 0;
    this.sort = null;             // { col, dir }
    this.q = "";
    this.detail = null;           // the object in the drawer
    this.tab = "overview";
    this.events = null;
    this.related = null;
    this.confirm = null;          // { title, verb, run }
    this.scaling = false;
    this.width = 1200;
    this.open = { ctx: false, ns: false, aws: false };
    this.aws = null;              // { profiles, pick } once an AWS sign-in error is shown
    this.signingIn = 0;           // when a sign-in tab was opened: retry until the cluster answers
    this.focusH = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search…" });
    this.input.on("change", (_e, cx) => { this.q = this.input.value().trim().toLowerCase(); cx.notify(); });
    this.input.on("focus", () => { this.typing = true; });
    this.input.on("blur", () => { this.typing = false; });
    // Filters at the top of the cluster and namespace pickers.
    this.ctxQ = ""; this.nsQ = "";
    this.ctxFilter = InputState.new({ placeholder: "Filter clusters…" });
    this.ctxFilter.on("change", (_e, cx) => { this.ctxQ = this.ctxFilter.value().trim().toLowerCase(); cx.notify(); });
    this.ctxFilter.on("submit", (_e, cx) => { const c = this.ctxMatches()[0]; if (c) { this.open.ctx = false; this.useContext(c.name, cx); } cx.notify(); });
    this.nsFilter = InputState.new({ placeholder: "Filter namespaces…" });
    this.nsFilter.on("change", (_e, cx) => { this.nsQ = this.nsFilter.value().trim().toLowerCase(); cx.notify(); });
    this.nsFilter.on("submit", (_e, cx) => { const n = this.nsMatches(); if (n.length) { this.open.ns = false; const pick = n[0]; if (pick !== this.ns) this.useNamespace(pick, cx); } cx.notify(); });
    for (const f of [this.ctxFilter, this.nsFilter]) { f.on("focus", () => { this.typing = true; }); f.on("blur", () => { this.typing = false; }); }
    this.scaleInput = InputState.new({ placeholder: "replicas" });
    this.scaleInput.on("submit", (_e, cx) => this.askScale(cx));
    this.scaleInput.on("focus", () => { this.typing = true; });
    this.scaleInput.on("blur", () => { this.typing = false; });
    const t = theme();
    this.yaml = EditorState.new({ language: "yaml", readonly: true, value: "", font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 } });
    this.yamlKey = null;
    this.loadContexts(cx);
    cx.timer.every(5000, (cx) => { if (this.ctx && this.visible() && !this.error?.auth) this.refresh(cx, true); });
  }

  // ---- where this copy is ----

  // A copy isn't told where it is. Docked in the layout: always shown (unless hidden).
  // Otherwise it is a tab pane: refresh while a kube pane is in the shown tab.
  visible() {
    const docked = (n) => n && !n.hidden && ((n.content?.mod === "kube") || (n.children ?? []).some(docked));
    try { if (docked(layout()?.root ?? layout())) return true; } catch { /* no layout yet */ }
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
    return panes().some((p) => p.mod === "kube" && p.tab === tab);
  }

  // The layout block holding this copy, when it is the docked one.
  dockId() {
    if (!props()?.docked) return null;
    const find = (n) => (n?.content?.mod === "kube" && n.content.props?.docked ? n : (n?.children ?? []).map(find).find(Boolean));
    try { return find(layout())?.id ?? null; } catch { return null; }
  }

  ctxMatches() {
    const q = this.ctxQ;
    return this.ctxs.filter((c) => !q || `${c.name} ${K.contextLabel(c.name).title} ${K.contextLabel(c.name).sub}`.toLowerCase().includes(q));
  }
  // null is "All namespaces"; it stays first while nothing is typed.
  nsMatches() {
    const q = this.nsQ;
    return q ? this.nsList.filter((n) => n.toLowerCase().includes(q)) : [null, ...this.nsList];
  }
  // Opening a picker clears its filter and puts the cursor in it.
  openPicker(which, open) {
    this.open[which] = open;
    const f = which === "ctx" ? this.ctxFilter : this.nsFilter;
    if (open) { f.set_value(""); this[which === "ctx" ? "ctxQ" : "nsQ"] = ""; f.focus(); }
  }

  kind() { return K.kindById(this.kindId); }
  multi() { return this.sel.length > 1; }
  prod() { return this.sel.some((c) => K.isProd(c)); }
  ctxOf(o) { return o?._ctx ?? this.ctx; }
  keyOf(o) { return `${o?._ctx ?? ""}|${o?.metadata?.uid ?? ""}`; }

  // ---- loading ----

  loadContexts(cx, attempt = 1) {
    // A first read can be lost when the panel restarts mid-call (a layout switch): retry a few
    // times rather than say "Loading clusters…" forever.
    if (attempt < 4) cx.timer.after(20000, (cx) => { if (!this.ctx && !this.error) this.loadContexts(cx, attempt + 1); });
    cx.spawn(async (cx) => {
      try {
        const { list, current } = this.demo ? Demo.contexts() : await K.contexts();
        this.ctxs = list;
        let saved = [];
        try { saved = JSON.parse(store.get("kube.ctxs") ?? "[]"); } catch { /* none */ }
        if (!saved.length && store.get("kube.ctx")) saved = [store.get("kube.ctx")];
        saved = saved.filter((n) => list.some((c) => c.name === n));
        // Demo props can name the starting cluster: { demo: { context: "demo:..." } }.
        const demoStart = this.demo && props()?.demo?.context;
        if (demoStart && list.some((c) => c.name === demoStart)) saved = [demoStart];
        const pick = saved.length ? saved : [current ?? list[0]?.name].filter(Boolean);
        if (!pick.length) this.error = new K.KubeError("No clusters in your kubeconfig (~/.kube/config).");
        else this.useContexts(pick, cx);
      } catch (e) { this.error = e instanceof K.KubeError ? e : new K.KubeError(msg(e)); }
      cx.notify();
    });
  }

  useContext(name, cx) { this.useContexts([name], cx); }

  // Adds or removes one cluster from those shown together (at least one stays).
  toggleContext(name, cx) {
    const next = this.sel.includes(name) ? this.sel.filter((n) => n !== name) : [...this.sel, name];
    if (next.length) this.useContexts(next, cx);
  }

  useContexts(names, cx) {
    this.sel = names;
    this.ctx = names[0];
    store.set("kube.ctxs", JSON.stringify(names));
    store.set("kube.ctx", names[0]);
    const key = `kube.ns.${names.join("+")}`;
    const saved = store.get(key);
    this.ns = saved == null || saved === "" ? (names.length === 1 ? this.ctxs.find((c) => c.name === names[0])?.namespace ?? null : null) : saved;
    if (saved === "*") this.ns = null;
    this.nsList = [];
    this.reset(cx);
    const sel = names.join("+");
    cx.spawn(async (cx) => {
      const all = await Promise.all(names.map((n) => K.namespaces(n).catch(() => [])));
      if (this.sel.join("+") === sel) { this.nsList = [...new Set(all.flat())].sort(); cx.notify(); }
    });
  }

  useNamespace(ns, cx) {
    this.ns = ns;
    store.set(`kube.ns.${this.sel.join("+")}`, ns ?? "*");
    this.reset(cx);
  }

  useKind(id, cx) {
    if (id === this.kindId) return;
    this.kindId = id;
    store.set("kube.kind", id);
    this.sort = null;
    this.reset(cx);
  }

  reset(cx) {
    this.gen++;
    this.items = [];
    this.error = null;
    this.ctxErrors = {};
    this.hasUse = false;
    this.updatedAt = null;
    this.closeDetail();
    this.refresh(cx);
    cx.notify();
  }

  refresh(cx, quiet = false) {
    if (!this.ctx) return;
    if (this.busy) { this.again = true; return; }
    const gen = this.gen, k = this.kind(), sel = [...this.sel], ns = this.ns;
    this.busy = true;
    if (!quiet) this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // Every shown cluster at once; one failing keeps the others' rows.
        const results = await Promise.allSettled(sel.map(async (ctx) => {
          const items = await K.list(k, { context: ctx, namespace: ns });
          let use = null;
          if (k.id === "pods" || k.id === "nodes") use = await K.usage(k.id, ctx, k.cluster ? null : ns).catch(() => null);
          for (const o of items) {
            o._ctx = ctx;
            if (use) o._use = use.get(k.cluster ? o.metadata?.name : `${o.metadata?.namespace}/${o.metadata?.name}`) ?? null;
          }
          return { items, use: Boolean(use) };
        }));
        if (gen === this.gen) {
          const ok = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
          const errs = {};
          results.forEach((r, i) => { if (r.status === "rejected") errs[sel[i]] = r.reason instanceof K.KubeError ? r.reason : new K.KubeError(msg(r.reason)); });
          this.ctxErrors = errs;
          if (!ok.length) {
            this.error = Object.values(errs)[0];
            if (this.error?.aws || this.authOf(this.ctx)?.provider === "aws") this.loadAws(cx);
          } else {
            this.signingIn = 0;
            this.aws = null;
            this.items = ok.flatMap((v) => v.items);
            this.hasUse = ok.some((v) => v.use);
            this.error = null;
            this.updatedAt = Date.now();
            this.syncDetail();
          }
        }
      } finally {
        this.busy = false;
        this.loading = false;
      }
      if (this.again) { this.again = false; this.refresh(cx); }
      else if (this.detail && gen === this.gen) this.loadExtras(cx);
      cx.notify();
    });
  }

  // ---- the drawer ----

  select(o, cx) {
    const same = this.keyOf(this.detail) === this.keyOf(o);
    this.detail = o;
    this.confirm = null;
    this.scaling = false;
    if (!same) { this.events = null; this.related = null; this.usage = null; }
    this.syncYaml();
    this.focusH.focus();
    this.loadExtras(cx);
    cx.notify();
  }
  closeDetail() { this.detail = null; this.events = null; this.related = null; this.usage = null; this.confirm = null; this.scaling = false; }

  syncDetail() {
    if (!this.detail) return;
    const fresh = this.items.find((o) => this.keyOf(o) === this.keyOf(this.detail));
    if (fresh) this.detail = fresh;
    this.syncYaml();
  }

  loadExtras(cx) {
    const o = this.detail;
    if (!o || this.extrasBusy) return;
    this.extrasBusy = true;
    const ctx = this.ctxOf(o), key = this.keyOf(o);
    const pods = ["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "Service"].includes(o.kind);
    cx.spawn(async (cx) => {
      try {
        const [events, related, usage] = await Promise.all([
          o.kind === "Event" ? Promise.resolve([]) : K.eventsFor(o, ctx).catch(() => null),
          pods ? K.podsFor(o, ctx).catch(() => null) : Promise.resolve(null),
          o.kind === "Node" ? K.usage("nodes", ctx).catch(() => null)
            : pods || o.kind === "Pod" ? K.usage("pods", ctx, o.metadata?.namespace).catch(() => null) : Promise.resolve(null),
        ]);
        if (this.keyOf(this.detail) === key) {
          this.events = events;
          for (const p of related ?? []) { p._ctx = ctx; p._use = usage?.get(`${p.metadata?.namespace}/${p.metadata?.name}`) ?? null; }
          this.related = related;
          this.usage = usage;
        }
      } finally { this.extrasBusy = false; }
      cx.notify();
    });
  }

  // ---- terminals and actions ----

  base(o) { return [...K.kubeCmd(), "--context", this.ctxOf(o), ...(o.metadata?.namespace ? ["-n", o.metadata.namespace] : [])]; }

  // Open a terminal where the person is looking. A copy isn't told which pane it is (a docked
  // copy has none), so split the focused pane: clicking this panel's tab focuses its pane, and
  // a click in a docked copy leaves focus on the pane being worked in. Nothing focused: a tab.
  term(argv, name) {
    if (argv.some((a) => K.isDemo(a))) { notify({ title: "Demo clusters have no terminals", body: "Shell, port-forward and describe need a real cluster.", level: "info", timeout: 4000 }); return; }
    const fp = focused()?.pane;
    if (fp) run("pane.split", { direction: "down", pane: fp, argv });
    else run("tab.new", { name: name ?? "kubectl", argv });
  }
  // The log viewer, as a kube pane below the focused pane (or in a tab of its own).
  logs(o, container, previous = false) {
    const spec = {
      context: this.ctxOf(o), namespace: o.metadata?.namespace, kind: o.kind, name: o.metadata?.name,
      selector: o.kind === "Service" ? o.spec?.selector ?? null : o.spec?.selector?.matchLabels ?? null,
      container: container ?? null, previous: Boolean(previous),
    };
    const fp = focused()?.pane;
    if (fp) run("pane.split", { direction: "down", pane: fp, mod: "kube", props: { logs: spec } });
    else run("tab.new", { name: `Logs ${o.metadata?.name}`, mod: "kube", props: { logs: spec } });
  }
  shell(o, container) {
    this.term([...this.base(o), "exec", "-it", o.metadata.name, ...(container ? ["-c", container] : []), "--", "sh", "-c", SHELL]);
  }
  forward(o, port) {
    const local = port >= 1024 ? `${port}:${port}` : `:${port}`;
    this.term([...this.base(o), "port-forward", `${o.kind === "Service" ? "svc" : "pod"}/${o.metadata.name}`, local]);
  }
  describe(o) {
    const k = K.kindByName(o.kind)?.res ?? o.kind.toLowerCase();
    this.term(["sh", "-c", '"$0" "$@" | less -R', ...this.base(o), "describe", k, o.metadata.name]);
  }

  ask(title, verb, fn, cx) { this.confirm = { title, verb, run: fn }; this.scaling = false; cx.notify(); }

  askRestart(o, cx) {
    const k = K.kindByName(o.kind).res;
    this.ask(`Restart ${o.kind.toLowerCase()} ${o.metadata.name}? Its pods are replaced one by one.`, "Restart",
      this.change(o, `Restarted ${o.metadata.name}`, ["-n", o.metadata.namespace, "rollout", "restart", `${k}/${o.metadata.name}`]), cx);
  }
  askScale(cx) {
    const o = this.detail;
    const n = Number(this.scaleInput.value().trim());
    if (!o || !Number.isInteger(n) || n < 0 || n > 500) { notify({ title: "Replicas must be a whole number from 0 to 500", level: "warning" }); return; }
    const k = K.kindByName(o.kind).res;
    this.ask(`Scale ${o.kind.toLowerCase()} ${o.metadata.name} from ${o.spec?.replicas ?? 0} to ${n} replicas?`, "Scale",
      this.change(o, `Scaled ${o.metadata.name} to ${n}`, ["-n", o.metadata.namespace, "scale", `${k}/${o.metadata.name}`, `--replicas=${n}`]), cx);
  }
  // The confirmed change, on the object's own cluster.
  change(o, done, args) {
    const context = this.ctxOf(o);
    return (cx) => {
      this.confirm = null;
      this.scaling = false;
      this.acting = true;
      cx.spawn(async (cx) => {
        try {
          await K.kubectl(args, { context });
          notify({ title: done, body: K.contextLabel(context).title, level: "success", timeout: 5000 });
        } catch (e) {
          notify({ title: "Kubernetes change failed", body: msg(e), level: "error" });
        } finally { this.acting = false; }
        this.refresh(cx, true);
        cx.notify();
      });
    };
  }

  // ---- table data ----

  cols(tableW) {
    const cols = this.kind().cols.filter((c) => (!c.hide || tableW >= c.hide) && !(c.ns && this.ns) && !(c.use && !this.hasUse));
    // Several clusters: say whose row it is, right after the name.
    if (this.multi()) cols.splice(Math.max(0, cols.findIndex((c) => c.w === "flex") + 1), 0, CLUSTER_COL);
    return cols;
  }
  rows() {
    const k = this.kind();
    let out = this.items;
    if (this.q) {
      const st = k.cols.find((c) => c.status);
      out = out.filter((o) => {
        const hay = `${o.metadata?.name ?? ""} ${o.metadata?.namespace ?? ""} ${st ? st.get(o) : ""} ${o.message ?? ""} ${o.involvedObject?.name ?? ""}`.toLowerCase();
        return hay.includes(this.q);
      });
    }
    if (this.sort) {
      const c = this.sort.col === -2 ? CLUSTER_COL : k.cols[this.sort.col];
      const key = c.sort ?? c.get;
      const d = this.sort.dir;
      out = [...out].sort((a, b) => {
        const x = key(a), y = key(b);
        return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * d;
      });
    }
    return out;
  }

  // ---- keys ----

  key(e, cx) {
    if (this.lp) return;
    const k = e.key;
    if (this.typing) { if (k === "escape") { this.focusH.focus(); cx.notify(); } return; }
    if (k === "escape" && this.detail) { this.closeDetail(); cx.notify(); return; }
    if (k === "/") { this.input.focus(); return; }
    if (k === "r") { this.error = null; this.refresh(cx); cx.notify(); return; }
    const o = this.detail;
    if (o) {
      const kd = K.kindByName(o.kind) ?? {};
      if (k === "l" && kd.logs) { this.logs(o); return; }
      if (k === "s" && o.kind === "Pod") { this.shell(o); return; }
      if (k === "d") { this.describe(o); return; }
      if (k === "y") { this.tab = this.tab === "yaml" ? "overview" : "yaml"; this.syncYaml(); cx.notify(); return; }
    }
    if (k === "down" || k === "up" || k === "j" || k === "k") {
      const list = this.rows();
      if (!list.length) return;
      const at = this.detail ? list.findIndex((o) => this.keyOf(o) === this.keyOf(this.detail)) : -1;
      const next = k === "down" || k === "j" ? Math.min(list.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
      this.select(list[next], cx);
    }
  }

  // ---- drawing ----

  render() {
    const t = theme();
    if (this.lp) return this.lp.view(t);
    // Narrow: a slimmer sidebar, and the details take the table's place when both don't fit.
    const sideW = this.width < 760 ? 172 : SIDEBAR_W;
    let drawerW = this.detail ? Math.max(380, Math.min(620, Math.round((this.width - sideW) * 0.44))) : 0;
    let tableW = this.width - sideW - drawerW;
    const solo = Boolean(this.detail) && tableW < 380;
    if (solo) { drawerW = this.width - sideW; tableW = 0; }
    return h_flex().id("kube-root").size_full().min_w(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .track_focus(this.focusH).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(this.sidebar(t, sideW))
      .when(!solo, (el) => el.child(this.main(t, tableW)))
      .when(Boolean(this.detail), (el) => el.child(this.drawer(t, drawerW)));
  }

  status(t, word) {
    const h = K.health(word);
    return h === "ok" ? t.ansi2 : h === "warn" ? t.ansi3 : h === "bad" ? t.ansi1 : h === "done" ? t.dim : t.muted;
  }

  // Left column: cluster, namespace, resource tree.
  sidebar(t, sideW = SIDEBAR_W) {
    const one = this.ctx ? K.contextLabel(this.ctx) : { title: "No cluster", sub: "" };
    const label = this.multi()
      ? { title: `${this.sel.length} clusters`, sub: this.sel.map((n) => K.contextLabel(n).title).join(", ") }
      : one;
    const prod = this.prod();
    const groups = [...new Set(K.KINDS.map((k) => k.group))];
    // A picker card: a fixed height (what a scroll area needs to scroll inside a popover), a
    // filter field, then the list scrolling under it. Typing filters; Enter picks the first.
    const picker = (id, w, height, title, filter, rows, empty) => v_flex().id(`${id}-card`).w(w).h(height).p(5).gap(4).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).shadow_md()
      .child(div().px(8).pt(4).text_size(10.5).text_color(t.dim).child(title))
      .child(h_flex().id(`${id}-filter`).h(28).flex_none().mx(3).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg(ICON("search")).size(12).text_color(t.dim))
        .child(Input.new(filter).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id(`${id}-list`).size_full().overflow_y_scroll().gap(1).children(rows)
          .when(!rows.length, (e) => e.child(div().p(8).text_size(11.5).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical(`${id}-list`).absolute().inset_0()));

    const ctxRows = this.ctxMatches().map((c) => {
      const l = K.contextLabel(c.name), p = K.isProd(c.name), on = this.sel.includes(c.name);
      return h_flex().id(`kube-ctx-${c.name}`).h(40).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
        .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.open.ctx = false; if (!(on && !this.multi())) this.useContext(c.name, cx); cx.notify(); })
        .child(this.badge(t, l.title, p))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(l.title))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(l.sub || c.name)))
        .when(p, (e) => e.child(div().px(5).rounded(4).bg(t.ansi1).text_color(t.background).text_size(9.5).font_semibold().child("PROD")))
        .child(div().id(`kube-ctx-tick-${c.name}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .border_1().border_color(on ? t.accent : t.input).bg(on ? t.accent : t.popover).text_color(t.accent_foreground).text_size(11)
          .tooltip(on ? "Stop showing this cluster" : "Show this cluster too")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleContext(c.name, cx); cx.notify(); })
          .child(on ? "✓" : ""));
    });
    const ctxList = picker("kube-ctx", 320, Math.min(440, 84 + Math.max(1, this.ctxs.length) * 41), "CLUSTERS · click to show one, tick to show several",
      this.ctxFilter, ctxRows, this.ctxs.length ? `No cluster matches “${this.ctxQ}”` : "No clusters");

    const nsRows = this.nsMatches().map((n) => h_flex().id(`kube-ns-${n ?? "*"}`).h(26).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .text_size(12).when(n === this.ns, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.open.ns = false; if (n !== this.ns) this.useNamespace(n, cx); cx.notify(); })
      .child(div().w(12).flex_none().text_color(t.accent).child(n === this.ns ? "✓" : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(n ? t.foreground : t.muted).child(n ?? "All namespaces")));
    const nsList = picker("kube-ns", 260, Math.min(420, 84 + (this.nsList.length + 1) * 27), "NAMESPACES",
      this.nsFilter, nsRows, !this.nsList.length ? (this.error ? "Can't list namespaces" : "Loading…") : `No namespace matches “${this.nsQ}”`);

    return v_flex().w(sideW).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border)
      .child(v_flex().p(8).gap(6).border_b(1).border_color(t.border)
        .child(Popover.new("kube-ctx-menu").open(this.open.ctx).on_open_change((o, cx) => { this.openPicker("ctx", o); cx.notify(); })
          .trigger(h_flex().id("kube-ctx").h(44).px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .border_1().border_color(prod ? t.ansi1 : this.open.ctx ? t.accent : t.border).hover((s) => s.bg(t.hover))
            .child(this.badge(t, label.title, prod))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().font_semibold().text_size(12.5).child(label.title))
              .child(div().truncate().text_size(10.5).text_color(prod ? t.ansi1 : t.dim).child(prod ? `PRODUCTION · ${label.sub}` : label.sub)))
            .child(div().text_size(9).text_color(t.dim).child("▾")))
          .content(ctxList))
        .child(Popover.new("kube-ns-menu").open(this.open.ns).on_open_change((o, cx) => { this.openPicker("ns", o); cx.notify(); })
          .trigger(h_flex().id("kube-ns").h(28).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(12)
            .border_1().border_color(this.open.ns ? t.accent : t.border).hover((s) => s.bg(t.hover))
            .child(div().text_color(t.dim).child("ns"))
            .child(div().flex_1().min_w(0).truncate().text_color(this.ns ? t.foreground : t.muted).child(this.ns ?? "All namespaces"))
            .child(div().text_size(9).text_color(t.dim).child("▾")))
          .content(nsList)))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("kube-nav").size_full().overflow_y_scroll().p(6).gap(1)
          .children(groups.flatMap((g) => [
            div().px(8).pt(10).pb(3).text_size(10.5).text_color(t.dim).font_semibold().child(g.toUpperCase()),
            ...K.KINDS.filter((k) => k.group === g).map((k) => {
              const on = k.id === this.kindId;
              return h_flex().id(`kube-kind-${k.id}`).h(26).px(8).gap(6).items_center().rounded(5).cursor_pointer().text_size(12.5)
                .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click((_e, cx) => this.useKind(k.id, cx))
                .child(div().flex_1().min_w(0).truncate().child(k.label))
                .when(on && this.updatedAt != null, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(this.items.length))));
            }),
          ])))
        .child(Scrollbar.vertical("kube-nav").absolute().inset_0()));
  }

  hue(t, title) {
    const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3];
    return palette[[...title].reduce((n, c) => n + c.charCodeAt(0), 0) % palette.length];
  }
  // A cluster's colour in tables: red for production, else its badge colour.
  ctxColor(t, name) { return K.isProd(name) ? t.ansi1 : this.hue(t, K.contextLabel(name ?? "").title); }

  // A cluster's coloured initials, like OpenLens's hotbar.
  badge(t, title, prod) {
    const letters = title.replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "K";
    const color = prod ? t.ansi1 : this.hue(t, title);
    return div().size(28).flex_none().flex().items_center().justify_center().rounded(6).bg(color).text_color(t.background)
      .text_size(11).font_semibold().child(letters);
  }

  // Middle: header, table or a notice.
  main(t, tableW) {
    const k = this.kind();
    const list = this.rows();
    const cols = this.cols(tableW);
    const header = h_flex().h(46).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().text_size(14).font_semibold().child(k.label))
      .when(this.updatedAt != null, (e) => e.child(div().text_size(12).text_color(t.dim).child(this.q ? `${list.length} of ${this.items.length}` : String(this.items.length))))
      .child(div().flex_1())
      .child(h_flex().id("kube-search").w(220).h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg(ICON("search")).size(13).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(h_flex().id("kube-refresh").size(28).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh (every 5 s while shown)")
        .on_click((_e, cx) => { this.error = null; this.refresh(cx); cx.notify(); })
        .child(this.loading || this.busy ? svg(ICON("spinner")).size(14).text_color(t.accent).spin(900) : svg(ICON("refresh")).size(14)))
      // Docked in the layout (props { docked: true }): a way to put the panel away. The top-bar
      // button or layout.show brings it back.
      .when(Boolean(this.dockId()), (e) => e.child(h_flex().id("kube-hide-panel").size(28).flex_none().items_center().justify_center().rounded(6)
        .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Hide panel")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("layout.hide", { id: this.dockId() }))
        .child(svg(ICON("close")).size(13))));

    let body;
    if (this.error && !this.items.length) body = this.notice(t);
    else if (!this.ctx) body = this.empty(t, "Loading clusters…");
    else if (this.updatedAt == null) body = this.empty(t, `Loading ${k.label.toLowerCase()}…`);
    else if (!list.length) body = this.empty(t, this.q ? `Nothing matches “${this.q}”` : `No ${k.label.toLowerCase()}${this.ns ? ` in ${this.ns}` : ""}`);
    else body = this.table(t, cols, list);

    return v_flex().flex_1().min_w(0).h_full()
      .child(header)
      .when(Boolean(this.error && this.items.length), (e) => e.child(div().px(14).py(6).text_size(11.5).text_color(t.ansi1).bg(t.surface).border_b(1).border_color(t.border).child(`Refresh failed: ${msg(this.error)}`)))
      // One cluster failing while others answer; when all failed, the notice says it instead.
      .children((this.error ? [] : Object.entries(this.ctxErrors)).map(([n, err]) => div().px(14).py(6).text_size(11.5).text_color(t.ansi3).bg(t.surface).border_b(1).border_color(t.border)
        .child(`${K.contextLabel(n).title}: ${msg(err).split("\n")[0]}`)))
      .child(body);
  }

  empty(t, text) {
    return div().flex_1().flex().items_center().justify_center().text_color(t.dim).child(text);
  }

  // ---- signing in ----

  authOf(name) { return this.ctxs.find((c) => c.name === name)?.auth ?? null; }

  // Read ~/.aws/config once an AWS sign-in is needed; pick the cluster's own profile, else the
  // first SSO profile.
  loadAws(cx) {
    if (this.aws) return;
    this.aws = { profiles: null, pick: null };
    const ctx = this.ctx;
    cx.spawn(async (cx) => {
      const profiles = await K.awsProfiles(ctx);
      const want = this.authOf(ctx)?.profile;
      this.aws = { profiles, pick: (profiles.find((p) => p.name === want) ?? profiles.find((p) => p.sso) ?? profiles[0])?.name ?? want ?? null };
      cx.notify();
    });
  }

  // A sign-in runs in a terminal tab (it may open a browser). Meanwhile retry every 5 s for
  // 3 minutes, so the panel comes back by itself once the sign-in finishes.
  signIn(name, argv, cx) {
    run("tab.new", { name, argv });
    const started = this.signingIn = Date.now();
    cx.timer.every(5000, (cx) => {
      if (this.signingIn !== started) return;
      if (Date.now() - started > 180000) { this.signingIn = 0; cx.notify(); return; }
      if (this.error && !this.busy) this.refresh(cx, true);
    });
    cx.notify();
  }

  awsBox(t) {
    const a = this.authOf(this.ctx) ?? {};
    const profiles = this.aws?.profiles;
    const pick = profiles?.find((p) => p.name === this.aws?.pick) ?? null;
    const mine = profiles?.find((p) => p.name === a.profile) ?? null;
    const uses = a.profile ? `This cluster signs in with AWS profile ${a.profile}` : "This cluster signs in with your default AWS profile";
    const where = [a.region, a.role ? `role ${a.role.split("/").pop()}` : null].filter(Boolean).join(" · ");
    const rows = (profiles ?? []).map((p) => h_flex().id(`kube-aws-${p.name}`).h(40).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
      .when(p.name === this.aws?.pick, (e) => e.bg(t.selected)).hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => { this.aws.pick = p.name; this.open.aws = false; cx.notify(); })
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(12.5).text_color(t.foreground).child(p.name))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child([p.session ? `session ${p.session}` : p.startUrl ? "legacy SSO" : "no SSO", p.account, p.role].filter(Boolean).join(" · "))))
      .when(p.name === a.profile, (e) => e.child(div().px(5).rounded(4).bg(t.raised).text_size(9.5).text_color(t.muted).child("CLUSTER")))
      .child(div().px(5).rounded(4).text_size(9.5).font_semibold().bg(p.sso ? t.accent : t.raised).text_color(p.sso ? t.accent_foreground : t.dim).child(p.sso ? "SSO" : "KEYS")));
    const list = v_flex().id("kube-aws-card").w(340).h(Math.min(360, 40 + Math.max(1, rows.length) * 41)).p(5).gap(4).rounded(8)
      .bg(t.popover).border_1().border_color(t.border).shadow_md()
      .child(div().px(8).pt(4).text_size(10.5).text_color(t.dim).child("AWS PROFILES · ~/.aws/config"))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("kube-aws-list").size_full().overflow_y_scroll().gap(1).children(rows))
        .child(Scrollbar.vertical("kube-aws-list").absolute().inset_0()));
    const warn = !pick ? null
      : !pick.sso ? `${pick.name} isn't an SSO profile: sign in to it another way (aws configure).`
      : mine && pick.name !== mine.name && (pick.session ?? pick.startUrl) !== (mine.session ?? mine.startUrl)
        ? `${pick.name} uses a different SSO session from ${mine.name}, so signing in to it won't refresh this cluster.` : null;
    return v_flex().gap(8).items_center().w_full().max_w(560)
      .child(div().text_size(12).text_color(t.muted).child(`${uses}${where ? ` (${where})` : ""}.`))
      .child(profiles == null ? div().text_size(12).text_color(t.dim).child("Reading ~/.aws/config…")
        : !profiles.length ? div().text_size(12).text_color(t.muted).child("No profiles in ~/.aws/config yet. Set one up with aws configure sso, then sign in.")
        : h_flex().gap(8).items_center()
          .child(div().text_size(12).text_color(t.dim).child("Profile"))
          .child(Popover.new("kube-aws-menu").open(this.open.aws).on_open_change((o, cx) => { this.open.aws = o; cx.notify(); })
            .trigger(h_flex().id("kube-aws-pick").h(30).min_w(220).px(10).gap(8).items_center().rounded(6).cursor_pointer()
              .border_1().border_color(this.open.aws ? t.accent : t.border).bg(t.background).hover((st) => st.bg(t.hover))
              .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(pick?.name ?? this.aws?.pick ?? "Choose a profile"))
              .when(Boolean(pick?.session), (e) => e.child(div().text_size(10.5).text_color(t.dim).child(pick.session)))
              .child(div().text_size(9).text_color(t.dim).child("▾")))
            .content(list)))
      .when(Boolean(warn), (e) => e.child(div().text_size(11.5).text_color(t.ansi3).child(warn)));
  }

  notice(t) {
    const e = this.error;
    const a = this.authOf(this.ctx);
    const aws = Boolean(e?.aws || (e?.auth && a?.provider === "aws"));
    const gcloud = !aws && Boolean(e?.auth) && (a?.provider === "gcloud" || /gcloud|gke/i.test(msg(e)));
    const auth = Boolean(e?.auth);
    const title = aws
      ? (e?.profileMissing ? "This cluster's AWS profile isn't set up" : /Unable to locate credentials/i.test(msg(e)) ? "No AWS credentials for this cluster" : "Your AWS SSO session has expired")
      : auth ? "Your cluster sign-in has expired" : e?.plugin ? "kubectl can't find its sign-in helper" : e?.missing ? "kubectl isn't installed" : "Can't reach the cluster";
    const pick = this.aws?.profiles?.find((p) => p.name === this.aws?.pick);
    const noProfiles = aws && Array.isArray(this.aws?.profiles) && !this.aws.profiles.some((p) => p.sso);
    return v_flex().flex_1().items_center().justify_center().p(24).gap(10)
      .child(div().text_size(15).font_semibold().child(title))
      .when(aws, (el) => el.child(this.awsBox(t)))
      .child(div().max_w(560).text_size(12).text_color(t.muted).font_family(settings().font_family ?? "JetBrains Mono").child(msg(e)))
      .when(Boolean(this.signingIn), (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(svg(ICON("spinner")).size(13).text_color(t.accent).spin(900))
        .child("Waiting for the sign-in to finish… retrying every 5 s")))
      .child(h_flex().gap(8).pt(6).flex_wrap().justify_center()
        .when(aws && !noProfiles, (el) => el.child(this.button(t, "kube-aws-login", "Sign in with AWS SSO", Boolean(pick?.sso), (cx) => {
          if (!pick?.sso) return;
          this.signIn(`aws sso login · ${pick.name}`, ["aws", "sso", "login", "--profile", pick.name], cx);
        })))
        .when(noProfiles, (el) => el.child(this.button(t, "kube-aws-setup", "Set up SSO", true, (cx) => {
          run("tab.new", { name: "aws configure sso", argv: ["aws", "configure", "sso"] });
          this.aws = null; cx.notify();
        })))
        .when(gcloud, (el) => el.child(this.button(t, "kube-login", "Sign in with gcloud", true, (cx) => {
          this.signIn("gcloud auth login", ["gcloud", "auth", "login"], cx);
        })))
        .child(this.button(t, "kube-copy", this.copied ? "Copied" : "Copy error", false, (cx) => this.copyError(cx)))
        .child(this.button(t, "kube-retry", "Retry", !auth, (cx) => { this.error = null; this.aws = null; this.refresh(cx); cx.notify(); })));
  }

  // No clipboard API for mods: hand the text to pbcopy (macOS) or wl-copy/xclip.
  copyError(cx) {
    const text = msg(this.error);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("/bin/sh", ["-c", 'if command -v pbcopy >/dev/null; then printf "%s" "$1" | pbcopy; elif command -v wl-copy >/dev/null; then printf "%s" "$1" | wl-copy; else printf "%s" "$1" | xclip -selection clipboard; fi', "sh", text]);
        if (r.code !== 0) throw new Error(r.stderr);
        this.copied = true; cx.notify();
        cx.timer.after(2000, (cx) => { this.copied = false; cx.notify(); });
      } catch (err) { notify({ title: "Couldn't copy", body: String(err?.message ?? err), level: "error" }); }
    });
  }

  button(t, id, label, primary, fn, danger = false) {
    return h_flex().id(id).h(28).px(12).items_center().rounded(6).cursor_pointer().text_size(12)
      .bg(danger ? t.ansi1 : primary ? t.solid : t.raised).text_color(danger ? t.background : primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => fn(cx))
      .child(label);
  }

  table(t, cols, list) {
    const k = this.kind();
    const head = h_flex().h(30).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .children(cols.map((c) => {
        const idx = c.cluster ? -2 : k.cols.indexOf(c);
        const on = this.sort?.col === idx;
        const cell = h_flex().id(`kube-h-${idx}`).gap(4).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
          .when(on, (e) => e.text_color(t.foreground))
          .on_click((_e, cx) => { this.sort = on ? (this.sort.dir === 1 ? { col: idx, dir: -1 } : null) : { col: idx, dir: 1 }; cx.notify(); })
          .when(Boolean(c.use), (e) => e.tooltip("Live usage from metrics-server"))
          .child(div().truncate().child(c.title))
          .when(on, (e) => e.child(div().text_size(9).child(this.sort.dir === 1 ? "▲" : "▼")));
        return c.w === "flex" ? cell.flex_1().min_w(80) : cell.w(c.w).flex_none();
      }));
    const sel = this.detail ? this.keyOf(this.detail) : null;
    const row = (o, i) => {
      const on = this.keyOf(o) === sel;
      return h_flex().id(`kube-row-${i}`).h(ROW_H).px(14).gap(10).items_center().cursor_pointer()
        .border_b(1).border_color(t.border)
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .children(cols.map((c) => {
          const text = c.get(o);
          let cell = div().truncate();
          if (c.cluster) cell = cell.text_color(this.ctxColor(t, o._ctx)).child(text);
          else if (c.status) {
            cell = h_flex().gap(6).items_center().min_w(0)
              .child(div().size(7).flex_none().rounded(4).bg(this.status(t, text)))
              .child(div().truncate().text_color(this.status(t, text)).child(text));
          } else cell = cell.text_color(c.w === "flex" ? t.foreground : t.muted).child(text);
          return c.w === "flex" ? cell.flex_1().min_w(80) : cell.w(c.w).flex_none();
        }));
    };
    return v_flex().flex_1().min_h(0)
      .child(head)
      .child(div().flex_1().min_h(0).relative()
        // A new list id per cluster/namespace/kind: the old scroll offset would otherwise sit past the end of a shorter list.
        .child(v_virtual_list(`kube-rows-${this.gen}`, list.length, ROW_H, (i) => (list[i] ? this.keyOf(list[i]) : String(i)),
          (range) => list.slice(range.start, range.end).map((o, j) => row(o, range.start + j))).size_full()
          // Rows are drawn during layout, where per-row handlers throw: one click handler for the list.
          .on_item_click((key, cx) => {
            const o = list.find((x) => this.keyOf(x) === key);
            if (!o) return;
            if (this.detail && this.keyOf(o) === this.keyOf(this.detail)) { this.closeDetail(); cx.notify(); } else this.select(o, cx);
          }))
        .child(Scrollbar.vertical(`kube-rows-${this.gen}`).viewport_from_layout().absolute().inset_0()));
  }

  // ---- the drawer ----

  drawer(t, w) {
    const o = this.detail;
    const k = K.kindByName(o.kind) ?? {};
    const prod = K.isProd(this.ctxOf(o));
    const acts = [];
    if (k.logs) acts.push(this.button(t, "kube-a-logs", "Logs", false, () => this.logs(o)));
    if (o.kind === "Pod") acts.push(this.button(t, "kube-a-shell", "Shell", false, () => this.shell(o)));
    acts.push(this.button(t, "kube-a-describe", "Describe", false, () => this.describe(o)));
    if (k.restart) acts.push(this.button(t, "kube-a-restart", "Restart", false, (cx) => this.askRestart(o, cx)));
    if (k.scale) acts.push(this.button(t, "kube-a-scale", "Scale", false, (cx) => {
      this.scaling = !this.scaling; this.confirm = null;
      if (this.scaling) { this.scaleInput.set_value(String(o.spec?.replicas ?? 0)); this.scaleInput.focus(); }
      cx.notify();
    }));

    const tabs = h_flex().px(14).gap(14).border_b(1).border_color(t.border).children(["overview", "yaml"].map((id) =>
      div().id(`kube-tab-${id}`).py(8).cursor_pointer().text_size(12).border_b(2)
        .border_color(this.tab === id ? t.accent : t.surface).text_color(this.tab === id ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.tab = id; this.syncYaml(); cx.notify(); })
        .child(id === "yaml" ? "YAML" : "Overview")));

    return v_flex().w(w).flex_none().h_full().bg(t.surface).border_l(1).border_color(t.border)
      .child(h_flex().h(46).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child(o.kind))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(13).child(o.metadata?.name ?? ""))
        .when(this.multi(), (e) => e.child(div().flex_none().text_size(11).text_color(this.ctxColor(t, this.ctxOf(o))).child(K.contextLabel(this.ctxOf(o)).title)))
        .child(h_flex().id("kube-close").size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
          .on_click((_e, cx) => { this.closeDetail(); cx.notify(); })
          .child(svg(ICON("close")).size(12))))
      .child(h_flex().px(14).py(8).gap(6).flex_wrap().border_b(1).border_color(t.border).children(acts)
        .when(Boolean(this.acting), (e) => e.child(svg(ICON("spinner")).size(14).text_color(t.accent).spin(900))))
      .when(this.scaling, (e) => e.child(h_flex().px(14).py(8).gap(8).items_center().border_b(1).border_color(t.border).bg(t.raised)
        .child(div().text_size(12).text_color(t.muted).child("Replicas"))
        .child(div().id("kube-scale-box").w(90).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.scaleInput).h_full().text_size(12).text_color(t.foreground)))
        .child(this.button(t, "kube-scale-go", "Scale…", true, (cx) => this.askScale(cx)))
        .child(this.button(t, "kube-scale-cancel", "Cancel", false, (cx) => { this.scaling = false; cx.notify(); }))))
      .when(Boolean(this.confirm), (e) => e.child(v_flex().px(14).py(10).gap(8).border_b(1).border_color(prod ? t.ansi1 : t.border)
        .bg(t.raised)
        .when(prod, (el) => el.child(div().text_size(11).font_semibold().text_color(t.ansi1).child(`PRODUCTION · ${K.contextLabel(this.ctxOf(o)).title}`)))
        .child(div().text_size(12.5).child(this.confirm.title))
        .child(h_flex().gap(8)
          .child(this.button(t, "kube-confirm-go", this.confirm.verb, true, (cx) => this.confirm.run(cx), prod))
          .child(this.button(t, "kube-confirm-cancel", "Cancel", false, (cx) => { this.confirm = null; cx.notify(); })))))
      .child(tabs)
      .child(this.tab === "yaml" ? this.yamlView(t, o) : div().flex_1().min_h(0).relative()
        .child(v_flex().id("kube-detail").size_full().overflow_y_scroll().px(14).py(10).gap(14).children(this.overview(t, o)))
        .child(Scrollbar.vertical("kube-detail").absolute().inset_0()));
  }

  // The YAML editor is made once (in init) and refilled from handlers: not during render.
  syncYaml() {
    const o = this.detail;
    if (!o || this.tab !== "yaml") return;
    const key = `${o.metadata?.uid}:${o.metadata?.resourceVersion}`;
    if (this.yamlKey === key) return;
    this.yamlKey = key;
    this.yaml.set_value(K.toYaml(o));
  }

  yamlView(t, o) {
    return v_flex().flex_1().min_h(0)
      .when(o.kind === "Secret", (e) => e.child(div().px(14).py(6).text_size(11).text_color(t.dim).child("Secret values are hidden. Only key names and sizes are shown.")))
      .child(Editor.new(this.yaml).flex_1().min_h(0));
  }

  // ---- overview sections ----

  section(t, title, rows) {
    const list = rows.filter(Boolean);
    if (!list.length) return null;
    return v_flex().gap(6)
      .child(div().text_size(10.5).font_semibold().text_color(t.dim).child(title.toUpperCase()))
      .children(list);
  }
  kv(t, label, value) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return null;
    const v = typeof value === "string" || typeof value === "number" ? div().flex_1().min_w(0).text_color(t.foreground).child(String(value)) : div().flex_1().min_w(0).child(value);
    return h_flex().gap(10).items_start().text_size(12)
      .child(div().w(112).flex_none().text_color(t.muted).child(label))
      .child(v);
  }
  chips(t, obj) {
    const e = Object.entries(obj ?? {});
    if (!e.length) return null;
    return h_flex().flex_wrap().gap(4).min_w(0).children(e.map(([k, v]) => div().max_w_full().truncate().px(6).py(1).rounded(4).bg(t.raised).text_size(11).text_color(t.muted).tooltip(`${k}=${v}`).child(`${k}=${v}`)));
  }
  mono(t, text) {
    return div().p(8).rounded(6).bg(t.background).text_size(11).font_family(settings().font_family ?? "JetBrains Mono").text_color(t.foreground).child(text);
  }
  link(t, id, label, fn) {
    return div().id(id).px(6).py(1).rounded(4).cursor_pointer().text_size(11).text_color(t.accent).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => fn(cx)).child(label);
  }

  overview(t, o) {
    const m = o.metadata ?? {};
    const ann = Object.keys(m.annotations ?? {}).filter((a) => a !== "kubectl.kubernetes.io/last-applied-configuration");
    const out = [
      this.section(t, "Properties", [
        this.kv(t, "Created", m.creationTimestamp ? `${K.age(m.creationTimestamp)} ago · ${new Date(m.creationTimestamp).toLocaleString()}` : null),
        this.kv(t, "Namespace", m.namespace),
        this.kv(t, "Controlled by", (m.ownerReferences ?? []).map((r) => `${r.kind}/${r.name}`).join(", ")),
        this.kv(t, "Labels", this.chips(t, m.labels)),
        this.kv(t, "Annotations", ann.length ? v_flex().gap(2).children(ann.map((a) => div().truncate().text_size(11).text_color(t.muted).child(`${a}: ${String(m.annotations[a]).replace(/\s+/g, " ").slice(0, 200)}`))) : null),
      ]),
      this.usageSection(t, o),
      ...this.specific(t, o),
    ];
    if (o.kind !== "Event") out.push(this.eventsSection(t));
    return out.filter(Boolean);
  }

  specific(t, o) {
    const s = o.spec ?? {}, st = o.status ?? {};
    switch (o.kind) {
      case "Pod": return [
        this.section(t, "Status", [
          this.kv(t, "Status", h_flex().gap(6).items_center().child(div().size(7).rounded(4).bg(this.status(t, K.podStatus(o)))).child(div().text_color(this.status(t, K.podStatus(o))).child(K.podStatus(o)))),
          this.kv(t, "Node", s.nodeName), this.kv(t, "Pod IP", st.podIP), this.kv(t, "QoS class", st.qosClass),
          this.kv(t, "Service account", s.serviceAccountName), this.kv(t, "Restarts", String(K.podRestarts(o))),
        ]),
        this.section(t, "Containers", [...(s.initContainers ?? []).map((c) => this.container(t, o, c, true)), ...(s.containers ?? []).map((c) => this.container(t, o, c, false))]),
      ];
      case "Deployment": case "StatefulSet": case "ReplicaSet": case "DaemonSet": return [
        this.section(t, "Replicas", [
          o.kind === "DaemonSet"
            ? this.kv(t, "Pods", `${st.numberReady ?? 0} ready of ${st.desiredNumberScheduled ?? 0} scheduled`)
            : this.kv(t, "Pods", `${st.readyReplicas ?? 0} ready, ${st.updatedReplicas ?? 0} up to date, ${st.availableReplicas ?? 0} available of ${s.replicas ?? 0}`),
          this.kv(t, "Strategy", s.strategy?.type ?? s.updateStrategy?.type),
          this.kv(t, "Selector", this.chips(t, s.selector?.matchLabels)),
          this.kv(t, "Images", (s.template?.spec?.containers ?? []).map((c) => c.image).join("\n")),
          ...(st.conditions ?? []).map((c) => this.kv(t, c.type, `${c.status}${c.reason ? ` · ${c.reason}` : ""}${c.message ? ` · ${c.message}` : ""}`)),
        ]),
        this.podsSection(t),
      ];
      case "Job": return [
        this.section(t, "Job", [
          this.kv(t, "Completions", `${st.succeeded ?? 0}/${s.completions ?? 1}`), this.kv(t, "Parallelism", s.parallelism),
          this.kv(t, "Active", st.active), this.kv(t, "Failed", st.failed),
          this.kv(t, "Started", st.startTime ? `${K.age(st.startTime)} ago` : null), this.kv(t, "Finished", st.completionTime ? `${K.age(st.completionTime)} ago` : null),
        ]),
        this.podsSection(t),
      ];
      case "CronJob": return [this.section(t, "Schedule", [
        this.kv(t, "Schedule", s.schedule), this.kv(t, "Time zone", s.timeZone), this.kv(t, "Suspended", s.suspend ? "Yes" : "No"),
        this.kv(t, "Last run", st.lastScheduleTime ? `${K.age(st.lastScheduleTime)} ago` : "Never"),
        this.kv(t, "Last success", st.lastSuccessfulTime ? `${K.age(st.lastSuccessfulTime)} ago` : null),
        this.kv(t, "Active jobs", (st.active ?? []).map((j) => j.name).join(", ")),
      ])];
      case "Service": return [
        this.section(t, "Connection", [
          this.kv(t, "Type", s.type), this.kv(t, "Cluster IP", s.clusterIP),
          this.kv(t, "External", (st.loadBalancer?.ingress ?? []).map((i) => i.ip ?? i.hostname).join(", ")),
          this.kv(t, "Selector", this.chips(t, s.selector)),
          this.kv(t, "Ports", (s.ports ?? []).length ? v_flex().gap(4).children((s.ports ?? []).map((p, i) => h_flex().gap(8).items_center()
            .child(div().text_color(t.foreground).child(`${p.name ? `${p.name}: ` : ""}${p.port}${p.targetPort ? ` → ${p.targetPort}` : ""}/${p.protocol ?? "TCP"}`))
            .child(this.link(t, `kube-svc-fwd-${i}`, "Forward", () => this.forward(o, p.port))))) : null),
        ]),
        this.podsSection(t),
      ];
      case "Ingress": return [this.section(t, "Rules", [
        this.kv(t, "Class", s.ingressClassName),
        ...(s.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => this.kv(t, `${r.host ?? "*"}${p.path ?? "/"}`, `${p.backend?.service?.name ?? ""}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? ""}`))),
        this.kv(t, "TLS", (s.tls ?? []).map((x) => `${(x.hosts ?? []).join(", ")} (${x.secretName ?? ""})`).join("\n")),
      ])];
      case "ConfigMap": return [this.section(t, "Data", Object.entries(o.data ?? {}).map(([k, v]) => v_flex().gap(4)
        .child(div().text_size(12).text_color(t.muted).child(k))
        .child(this.mono(t, String(v).length > 4000 ? `${String(v).slice(0, 4000)}\n… (${String(v).length} chars, see YAML)` : String(v)))))];
      case "Secret": return [this.section(t, "Data", [
        this.kv(t, "Type", o.type),
        ...Object.entries(o.data ?? {}).map(([k, v]) => this.kv(t, k, v)),
        div().text_size(11).text_color(t.dim).child("Values stay hidden here. Read one with kubectl in a terminal if you need it."),
      ])];
      case "Node": return [this.section(t, "Node", [
        this.kv(t, "Capacity", `CPU ${K.cpu(st.capacity?.cpu)} · Memory ${K.mem(st.capacity?.memory)} · Pods ${st.capacity?.pods ?? ""}`),
        this.kv(t, "Allocatable", `CPU ${K.cpu(st.allocatable?.cpu)} · Memory ${K.mem(st.allocatable?.memory)} · Pods ${st.allocatable?.pods ?? ""}`),
        this.kv(t, "Addresses", (st.addresses ?? []).map((a) => `${a.type}: ${a.address}`).join("\n")),
        this.kv(t, "OS", `${st.nodeInfo?.osImage ?? ""} · ${st.nodeInfo?.architecture ?? ""}`),
        this.kv(t, "Kubelet", st.nodeInfo?.kubeletVersion), this.kv(t, "Runtime", st.nodeInfo?.containerRuntimeVersion),
        this.kv(t, "Taints", (s.taints ?? []).map((x) => `${x.key}${x.value ? `=${x.value}` : ""}:${x.effect}`).join("\n")),
        ...(st.conditions ?? []).map((c) => this.kv(t, c.type, h_flex().gap(6).child(div().text_color(c.type === "Ready" ? (c.status === "True" ? t.ansi2 : t.ansi1) : c.status === "True" ? t.ansi1 : t.muted).child(c.status)).child(div().text_color(t.dim).child(c.reason ?? "")))),
      ])];
      case "PersistentVolumeClaim": return [this.section(t, "Claim", [
        this.kv(t, "Status", st.phase), this.kv(t, "Volume", s.volumeName), this.kv(t, "Class", s.storageClassName),
        this.kv(t, "Requested", s.resources?.requests?.storage), this.kv(t, "Capacity", st.capacity?.storage), this.kv(t, "Access", (s.accessModes ?? []).join(", ")),
      ])];
      case "Event": return [this.section(t, "Event", [
        this.kv(t, "Type", h_flex().child(div().text_color(this.status(t, o.type)).child(o.type ?? ""))),
        this.kv(t, "Reason", o.reason), this.kv(t, "Message", o.message),
        this.kv(t, "Object", `${o.involvedObject?.kind ?? ""}/${o.involvedObject?.name ?? ""}`),
        this.kv(t, "Source", o.source?.component ?? o.reportingComponent), this.kv(t, "Count", o.count),
        this.kv(t, "Last seen", `${K.age(K.lastSeen(o))} ago`),
      ])];
      default: return [];
    }
  }

  // ---- usage (metrics-server) ----

  meter(t, used, total, text) {
    const f = total ? Math.min(1, used / total) : null;
    const color = f == null ? t.accent : f > 0.9 ? t.ansi1 : f > 0.75 ? t.ansi3 : t.ansi2;
    return h_flex().gap_x(8).gap_y(4).items_center().flex_wrap().min_w(0)
      .child(div().w(120).h(6).flex_none().rounded(3).bg(t.raised)
        .child(div().h_full().rounded(3).bg(color).w(f == null ? 0 : Math.max(2, Math.round(120 * f)))))
      .child(div().min_w(0).text_size(11.5).text_color(t.foreground).child(text));
  }

  // "120m of 1 (12%) · request 250m" style text and a bar against the limit, else the request.
  usageRows(t, use, res) {
    const part = (used, req, lim, fmt) => {
      const total = lim ?? req;
      const pc = total ? ` (${Math.round((used / total) * 100)}% of ${lim != null ? "limit" : "request"})` : "";
      const extra = [req != null ? `request ${fmt(req)}` : null, lim != null ? `limit ${fmt(lim)}` : null].filter(Boolean).join(" · ");
      return [total, `${fmt(used)}${pc}${extra ? ` · ${extra}` : ""}`];
    };
    const [ct, ctext] = part(use.cpu ?? 0, res.cpuReq, res.cpuLim, K.fmtCores);
    const [mt, mtext] = part(use.mem ?? 0, res.memReq, res.memLim, K.fmtBytes);
    return [this.kv(t, "CPU", this.meter(t, use.cpu ?? 0, ct, ctext)), this.kv(t, "Memory", this.meter(t, use.mem ?? 0, mt, mtext))];
  }

  usageSection(t, o) {
    const loading = this.events == null;
    const none = (why) => this.section(t, "Usage", [div().text_size(12).text_color(t.dim).child(why)]);
    if (o.kind === "Pod") {
      const use = o._use ?? this.usage?.get(`${o.metadata?.namespace}/${o.metadata?.name}`);
      if (!use) return loading ? null : none("No usage data (needs metrics-server)");
      return this.section(t, "Usage", this.usageRows(t, use, K.podResources(o)));
    }
    if (o.kind === "Node") {
      const use = this.usage?.get(o.metadata?.name) ?? o._use;
      if (!use) return loading ? null : none("No usage data (needs metrics-server)");
      const a = o.status?.allocatable ?? {};
      const cpuT = K.cores(a.cpu), memT = K.bytes(a.memory);
      return this.section(t, "Usage", [
        this.kv(t, "CPU", this.meter(t, use.cpu, cpuT, `${K.fmtCores(use.cpu)} of ${K.fmtCores(cpuT)} allocatable${cpuT ? ` (${Math.round((use.cpu / cpuT) * 100)}%)` : ""}`)),
        this.kv(t, "Memory", this.meter(t, use.mem, memT, `${K.fmtBytes(use.mem)} of ${K.fmtBytes(memT)} allocatable${memT ? ` (${Math.round((use.mem / memT) * 100)}%)` : ""}`)),
      ]);
    }
    if (["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "Service"].includes(o.kind)) {
      const pods = (this.related ?? []).filter((p) => p._use);
      if (!pods.length) return this.related == null || loading ? null : this.related.length ? none("No usage data (needs metrics-server)") : null;
      const sum = (f) => pods.reduce((n, p) => n + (f(p) ?? 0), 0);
      const res = pods.map((p) => K.podResources(p));
      const add = (key) => (res.some((r) => r[key] == null) ? null : res.reduce((n, r) => n + r[key], 0));
      return this.section(t, `Usage · ${pods.length} pod${pods.length === 1 ? "" : "s"}`,
        this.usageRows(t, { cpu: sum((p) => p._use.cpu), mem: sum((p) => p._use.mem) }, { cpuReq: add("cpuReq"), cpuLim: add("cpuLim"), memReq: add("memReq"), memLim: add("memLim") }));
    }
    return null;
  }

  container(t, pod, c, init) {
    const cs = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])].find((x) => x.name === c.name);
    const state = cs?.state?.running ? "Running" : cs?.state?.waiting?.reason ?? cs?.state?.terminated?.reason ?? (cs?.state?.waiting ? "Waiting" : "Unknown");
    const word = cs?.ready ? "Running" : state;
    const id = `${init ? "i" : "c"}-${c.name}`;
    return v_flex().gap(6).p(10).rounded(8).bg(t.background).border_1().border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).flex_none().rounded(4).bg(this.status(t, word)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(`${c.name}${init ? " (init)" : ""}`))
        .child(div().text_size(11).text_color(this.status(t, word)).child(state)))
      .child(div().text_size(11).text_color(t.muted).truncate().child(c.image))
      .when(Boolean(this.usage?.get(`${pod.metadata?.namespace}/${pod.metadata?.name}`)?.containers?.[c.name]), (e) => {
        const u = this.usage.get(`${pod.metadata?.namespace}/${pod.metadata?.name}`).containers[c.name];
        return e.child(div().text_size(11).text_color(t.foreground).child(`Using ${K.fmtCores(u.cpu)} CPU · ${K.fmtBytes(u.mem)} memory`));
      })
      .child(div().text_size(11).text_color(t.dim).child(`Restarts ${cs?.restartCount ?? 0}${c.resources?.requests ? ` · requests ${K.cpu(c.resources.requests.cpu) || "-"} CPU / ${K.mem(c.resources.requests.memory) || "-"}` : ""}${c.resources?.limits ? ` · limits ${K.cpu(c.resources.limits.cpu) || "-"} CPU / ${K.mem(c.resources.limits.memory) || "-"}` : ""}`))
      .when(Boolean(cs?.lastState?.terminated), (e) => e.child(div().text_size(11).text_color(t.ansi3).child(`Last exit: ${cs.lastState.terminated.reason ?? ""} (code ${cs.lastState.terminated.exitCode}) ${K.age(cs.lastState.terminated.finishedAt)} ago`)))
      .child(h_flex().gap(4).flex_wrap().items_center()
        .child(this.link(t, `kube-${id}-logs`, "Logs", () => this.logs(pod, c.name)))
        .when((cs?.restartCount ?? 0) > 0, (e) => e.child(this.link(t, `kube-${id}-prev`, "Previous logs", () => this.logs(pod, c.name, true))))
        .when(!init && Boolean(cs?.state?.running), (e) => e.child(this.link(t, `kube-${id}-shell`, "Shell", () => this.shell(pod, c.name))))
        .children((c.ports ?? []).map((p) => this.link(t, `kube-${id}-fwd-${p.containerPort}`, `Forward ${p.containerPort}${p.name ? ` (${p.name})` : ""}`, () => this.forward(pod, p.containerPort)))));
  }

  podsSection(t) {
    if (this.related == null) return this.section(t, "Pods", [div().text_size(12).text_color(t.dim).child("Loading…")]);
    if (!this.related.length) return this.section(t, "Pods", [div().text_size(12).text_color(t.dim).child("No pods")]);
    return this.section(t, `Pods (${this.related.length})`, this.related.map((p) => {
      const w = K.podStatus(p);
      return h_flex().id(`kube-rel-${p.metadata.uid}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().bg(t.background)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.select(p, cx))
        .tooltip(p.metadata.name)
        .child(div().size(7).flex_none().rounded(4).bg(this.status(t, w)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(p.metadata.name))
        .child(div().text_size(11).text_color(t.muted).child(K.podReady(p)))
        .when(Boolean(p._use), (e) => e.child(div().w(92).flex_none().text_size(11).text_color(t.dim).child(`${K.fmtCores(p._use.cpu)} · ${K.fmtBytes(p._use.mem)}`)))
        .child(div().w(84).flex_none().truncate().text_size(11).text_color(this.status(t, w)).child(w))
        .child(div().w(40).flex_none().text_size(11).text_color(t.dim).child(K.age(p.metadata.creationTimestamp)));
    }));
  }

  eventsSection(t) {
    if (this.events == null) return this.section(t, "Events", [div().text_size(12).text_color(t.dim).child("Loading…")]);
    if (!this.events.length) return this.section(t, "Events", [div().text_size(12).text_color(t.dim).child("No recent events")]);
    return this.section(t, "Events", this.events.slice(0, 12).map((e) => v_flex().gap(2).p(8).rounded(6).bg(t.background)
      .child(h_flex().gap(8).items_center().text_size(11)
        .child(div().text_color(e.type === "Warning" ? t.ansi3 : t.ansi2).child(e.type ?? ""))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).font_semibold().child(e.reason ?? ""))
        .child(div().text_color(t.dim).child(`${(e.count ?? 1) > 1 ? `×${e.count} · ` : ""}${K.age(K.lastSeen(e))} ago`)))
      .child(div().text_size(11.5).text_color(t.muted).child(e.message ?? ""))));
  }
}
