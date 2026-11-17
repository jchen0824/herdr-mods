// The log viewer: a kube pane opened with props { logs: spec }. Reads `kubectl logs` for a pod
// or every pod of a workload, follows by re-reading from the newest timestamp every 2 s, and
// lets the person filter, search, pick lines, copy them and hand them to an agent.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, settings, notify, exec, knownAgents, panes, spaces, focused, appHome } from "herdr";
import * as fs from "fs/promises";
import * as K from "./kube.js";
import * as L from "./logs.js";

const ICON = (n) => `mods/kube/icons/${n}.svg`;
const FONT = 12;
const LH = 18;                 // one text line
const CHAR_W = FONT * 0.6;     // monospace advance, for wrapped row heights
const TIME_W = 92;
const SRC_W = 150;
const AGENT_LINES = 300;
// How many lines a text takes when broken at spaces into rows of `per` characters, as the
// wrapped view does (long words break anywhere).
function wrapCount(text, per) {
  if (text.length <= per) return 1;
  let rows = 1, col = 0;
  for (const word of text.split(" ")) {
    let w = word.length;
    if (col && col + 1 + w > per) { rows++; col = 0; }
    else if (col) col++;
    while (w > per) { rows++; w -= per; }
    col += w;
  }
  return rows;
}
const msg = (e) => String(e?.message ?? e).split("\n").filter((l) => l.trim()).slice(0, 6).join("\n");

export class LogPanel {
  // spec: { context, namespace, kind, name, selector?, container?, previous? }
  constructor(spec, cx) {
    this.spec = spec;
    this.range = "tail";
    this.state = L.emptyState();
    this.shown = [];
    this.hits = [];
    this.hitSet = new Set();
    this.at = -1;
    this.following = !spec.previous;
    this.hidden = new Set();
    this.order = [];
    this.lvl = "all";
    this.q = "";
    this.onlyMatches = false;
    this.showTime = true;
    this.wrap = false;
    this.picked = new Set();
    this.asking = false;
    this.width = 900;
    this.gen = 0;
    this.focusH = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.search = InputState.new({ placeholder: "Search logs   (Enter next · Shift-Enter previous)" });
    this.search.on("change", (_e, cx) => { this.q = this.search.value(); this.at = -1; this.recompute(); cx.notify(); });
    this.search.on("submit", (e, cx) => { this.step(e?.shift ? -1 : 1); cx.notify(); });
    this.search.on("focus", () => { this.typing = true; });
    this.search.on("blur", () => { this.typing = false; });
    this.askInput = InputState.new({ placeholder: "What should the agent look at?  (Enter to send)" });
    this.askInput.on("submit", (_e, cx) => this.sendAsk(cx));
    this.askInput.on("focus", () => { this.typing = true; });
    this.askInput.on("blur", () => { this.typing = false; });
    this.load(cx);
    cx.timer.every(2000, (cx) => {
      if (this.following && !this.spec.previous && !this.busy && !this.error && this.visible()) this.load(cx, true);
    });
  }

  // Follow only while a kube pane is in the shown tab: a pane in a background tab keeps quiet.
  visible() {
    const tab = spaces().find((s) => s.active)?.tabs.find((t) => t.active)?.id;
    return panes().some((p) => p.mod === "kube" && p.tab === tab);
  }

  title() {
    const s = this.spec;
    return `${s.kind === "Pod" ? "pod" : s.kind.toLowerCase()}/${s.name}${s.container ? ` · ${s.container}` : ""}`;
  }

  // ---- reading ----

  load(cx, more = false) {
    if (this.busy) return;
    if (more && !this.state.last) more = false;
    this.busy = true;
    if (!more) this.loading = true;
    const gen = this.gen;
    const fresh = !more;
    const a = L.args(this.spec, { range: this.range, since: more ? this.state.last : null });
    cx.spawn(async (cx) => {
      try {
        const out = await K.kubectl(a, { context: this.spec.context, timeout: 120000, requestTimeout: "90s" });
        if (gen !== this.gen) return;
        if (fresh) this.state = L.emptyState();
        const n = L.merge(this.state, out);
        this.error = null;
        this.updatedAt = Date.now();
        if (n || fresh) {
          this.recompute();
          if (this.following || fresh) this.scroll.scroll_to_bottom();
        }
      } catch (e) {
        if (gen === this.gen) this.error = e;
      } finally {
        if (gen === this.gen) { this.busy = false; this.loading = false; }
        cx.notify();
      }
    });
  }

  reload(cx) {
    this.gen++;
    this.busy = false;
    this.error = null;
    this.picked.clear();
    this.at = -1;
    this.state = L.emptyState();
    this.recompute();
    this.load(cx);
    cx.notify();
  }

  recompute() {
    this.shown = L.visible(this.state.lines, { hidden: this.hidden, lvl: this.lvl, q: this.q, onlyMatches: this.onlyMatches });
    const needle = this.q.toLowerCase();
    this.hits = [];
    if (needle) this.shown.forEach((l, i) => { if (l.text.toLowerCase().includes(needle)) this.hits.push(i); });
    this.hitSet = new Set(this.hits);
    if (this.at >= this.hits.length) this.at = this.hits.length - 1;
  }

  step(dir) {
    if (!this.hits.length) return;
    this.at = this.at < 0 ? (dir > 0 ? 0 : this.hits.length - 1) : (this.at + dir + this.hits.length) % this.hits.length;
    this.following = false;
    this.scroll.scroll_to_item(this.hits[this.at], "center");
  }

  setFollow(on) {
    this.following = on && !this.spec.previous;
    if (this.following) this.scroll.scroll_to_bottom();
  }

  // ---- copy and ask ----

  chosen() {
    return this.picked.size ? this.shown.filter((l) => this.picked.has(l.id)) : this.shown;
  }

  // Mods have no clipboard call: write the text to a file under data/, pipe it to the system's
  // clipboard tool, and delete the file.
  copy(cx) {
    const lines = this.chosen();
    if (!lines.length) return;
    const text = L.asText(lines, { time: this.showTime });
    cx.spawn(async (cx) => {
      const rel = "data/kube/clipboard.txt";
      const abs = `${appHome()}/${rel}`;
      try {
        await fs.mkdir("data/kube", { recursive: true });
        await fs.writeFile(rel, text);
        const r = await exec("/bin/sh", ["-c", 'if command -v pbcopy >/dev/null; then pbcopy < "$1"; elif command -v wl-copy >/dev/null; then wl-copy < "$1"; else xclip -selection clipboard < "$1"; fi', "sh", abs]);
        if (r.code !== 0) throw new Error(r.stderr || "no clipboard tool (pbcopy, wl-copy or xclip)");
        notify({ title: `Copied ${lines.length} line${lines.length === 1 ? "" : "s"}`, level: "success", timeout: 2500 });
      } catch (e) {
        notify({ title: "Couldn't copy", body: msg(e), level: "error" });
      } finally {
        await fs.rm(rel).catch(() => {});
      }
      cx.notify();
    });
  }

  sendAsk(cx) {
    const all = this.chosen();
    const lines = all.slice(-AGENT_LINES);
    if (!lines.length) { notify({ title: "No log lines to send", level: "warning" }); return; }
    const question = this.askInput.value().trim() || "Explain what is happening in these logs and point out anything that looks wrong.";
    const s = this.spec;
    let body = L.asText(lines, { time: true });
    if (body.length > 60000) body = body.slice(-60000);
    const task = [
      question,
      "",
      `Kubernetes logs from ${s.kind} ${s.name} in namespace ${s.namespace} (kube context ${s.context})${s.previous ? ", previous container" : ""}.`,
      `${lines.length}${all.length > lines.length ? ` of ${all.length}` : ""} lines, oldest first:`,
      "```",
      body,
      "```",
    ].join("\n");
    cx.spawn(async (cx) => {
      try {
        const agents = (await knownAgents()).filter((a) => a.installed);
        const agent = agents.find((a) => a.key === "claude") ?? agents[0];
        if (!agent) throw new Error("No coding agent is installed (see programs.json `run`).");
        run("tab.new", { name: `Logs: ${s.name}`, argv: agent.run, task });
        this.asking = false;
        this.askInput.set_value("");
      } catch (e) {
        notify({ title: "Couldn't start an agent", body: msg(e), level: "error" });
      }
      cx.notify();
    });
  }

  // The same logs, streamed by kubectl in a terminal under this pane.
  terminal() {
    if (K.isDemo(this.spec.context)) { notify({ title: "Demo clusters have no terminals", level: "info", timeout: 4000 }); return; }
    const a = L.args(this.spec, { range: this.range }).filter((x) => x !== "--timestamps" && !x.startsWith("--limit-bytes"));
    const argv = [...K.kubeCmd(), "--context", this.spec.context, ...a, ...(this.spec.previous ? [] : ["-f"])];
    const fp = focused()?.pane;
    if (fp) run("pane.split", { direction: "down", pane: fp, argv });
    else run("tab.new", { name: "kubectl logs", argv });
  }

  // ---- keys ----

  key(e, cx) {
    if (this.typing) {
      if (e.key === "escape") { this.focusH.focus(); this.asking = false; cx.notify(); }
      return;
    }
    const k = e.key;
    if (k === "/") { this.search.focus(); return; }
    if (k === "space") { this.setFollow(!this.following); cx.notify(); return; }
    if (k === "c") { this.copy(cx); return; }
    if (k === "w") { this.wrap = !this.wrap; cx.notify(); return; }
    if (k === "t") { this.showTime = !this.showTime; cx.notify(); return; }
    if (k === "n") { this.step(e.modifiers?.shift ? -1 : 1); cx.notify(); return; }
    if (k === "end" || k === "G") { this.setFollow(true); cx.notify(); return; }
    if (k === "escape") { this.picked.clear(); this.asking = false; cx.notify(); }
  }

  // ---- drawing ----

  view(t) {
    const font = settings().font_family ?? "JetBrains Mono";
    const s = this.spec;
    const multi = new Set(this.state.lines.map((l) => l.src)).size > 1;
    const live = s.previous ? "previous container" : this.following ? "live" : "paused";

    const chip = (id, label, on, fn, title) => h_flex().id(id).h(24).px(8).items_center().rounded(5).cursor_pointer().text_size(11.5)
      .bg(on ? t.selected : t.background).border_1().border_color(on ? t.accent : t.border)
      .text_color(on ? t.foreground : t.muted).hover((st) => st.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { fn(cx); cx.notify(); })
      .when(Boolean(title), (el) => el.tooltip(title))
      .child(label);
    const seg = (id, items, cur, fn, disabled = false) => h_flex().h(24).p(2).gap(2).rounded(6).bg(t.raised).children(items.map(([v, label]) =>
      h_flex().id(`${id}-${v}`).h_full().px(8).items_center().rounded(4).text_size(11.5)
        .bg(v === cur ? t.solid : t.raised).text_color(v === cur ? t.solid_foreground : disabled ? t.dim : t.muted)
        .when(!disabled, (el) => el.cursor_pointer().hover((st) => st.text_color(v === cur ? t.solid_foreground : t.foreground))
          .on_click((_e, cx) => { fn(v, cx); cx.notify(); }))
        .child(label)));

    const header = h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().px(6).py(1).rounded(4).bg(t.raised).text_size(10.5).text_color(t.muted).child("Logs"))
      .child(div().min_w(80).truncate().font_semibold().text_size(13).tooltip(this.title()).child(this.title()))
      .child(div().min_w(0).flex_shrink(1).truncate().text_size(11.5).text_color(K.isProd(s.context) ? t.ansi1 : t.dim).child(`${K.contextLabel(s.context).title} · ${s.namespace}`))
      .child(h_flex().gap(5).items_center().flex_none()
        .child(div().size(7).rounded(4).bg(live === "live" ? t.ansi2 : t.dim))
        .child(div().text_size(11.5).text_color(live === "live" ? t.ansi2 : t.muted).child(live)))
      .when(this.loading || this.busy, (el) => el.child(svg(ICON("spinner")).size(13).text_color(t.accent).spin(900)))
      .child(div().flex_1())
      .child(chip("kl-term", "Open in terminal", false, () => this.terminal(), "kubectl logs -f in a terminal below"))
      .child(h_flex().id("kl-reload").size(26).flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Read again")
        .on_click((_e, cx) => this.reload(cx))
        .child(svg(ICON("refresh")).size(13)));

    const toolbar = h_flex().flex_none().px(12).py(6).gap(8).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(seg("kl-range", L.RANGES.map((r) => [r.id, r.label]), this.range, (v, cx) => { if (v !== this.range) { this.range = v; this.reload(cx); } }, Boolean(s.previous)))
      .when(!s.previous, (el) => el.child(chip("kl-follow", this.following ? "Following" : "Paused", this.following, () => this.setFollow(!this.following), "Space")))
      .child(chip("kl-time", "Time", this.showTime, () => { this.showTime = !this.showTime; }, "t"))
      .child(chip("kl-wrap", "Wrap", this.wrap, () => { this.wrap = !this.wrap; }, "w"))
      .child(seg("kl-lvl", [["all", "All levels"], ["warn", "Warn+"], ["error", "Errors"]], this.lvl, (v) => { this.lvl = v; this.recompute(); }));

    const counter = this.q ? (this.hits.length ? `${this.at >= 0 ? this.at + 1 : 0}/${this.hits.length}` : "no match") : "";
    const searchRow = h_flex().flex_none().px(12).py(6).gap(8).items_center().flex_wrap().border_b(1).border_color(t.border)
      .child(h_flex().id("kl-search").flex_1().min_w(220).h(28).px(8).gap(6).items_center().rounded(6).border_1()
        .border_color(t.border).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg(ICON("search")).size(13).text_color(t.dim))
        .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(counter), (el) => el.child(div().text_size(11.5).text_color(this.hits.length ? t.muted : t.ansi3).child(counter))
        .child(chip("kl-prev", "↑", false, () => this.step(-1), "Shift-Enter"))
        .child(chip("kl-next", "↓", false, () => this.step(1), "Enter")))
      .child(chip("kl-only", "Only matches", this.onlyMatches, () => { this.onlyMatches = !this.onlyMatches; this.at = -1; this.recompute(); }))
      .when(this.picked.size > 0, (el) => el.child(chip("kl-unpick", `${this.picked.size} picked ✕`, true, () => this.picked.clear(), "Esc")))
      .child(chip("kl-copy", this.picked.size ? "Copy picked" : "Copy all", false, (cx) => this.copy(cx), "c"))
      .child(chip("kl-ask", "Ask agent", this.asking, () => { this.asking = !this.asking; if (this.asking) this.askInput.focus(); }));

    const askRow = h_flex().flex_none().px(12).py(6).gap(8).items_center().flex_wrap().border_b(1).border_color(t.border).bg(t.surface)
      .child(div().text_size(11.5).text_color(t.muted).flex_none()
        .child(this.picked.size ? `Ask about ${this.picked.size} picked lines` : `Ask about the last ${Math.min(AGENT_LINES, this.shown.length)} shown lines`))
      .child(h_flex().id("kl-askbox").flex_1().min_w(220).h(28).px(8).items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.askInput).flex_1().h_full().text_size(12).text_color(t.foreground)))
      .child(chip("kl-asksend", "Send to new session", true, (cx) => this.sendAsk(cx)));

    const srcs = L.sources(this.state.lines);
    const pills = h_flex().flex_none().px(12).py(5).gap(6).flex_wrap().border_b(1).border_color(t.border)
      .children(srcs.map(({ src, count }, i) => {
        const off = this.hidden.has(src);
        const color = L.colorOf(this.order, src);
        return h_flex().id(`kl-src-${i}`).h(22).px(8).gap(6).items_center().rounded(11).cursor_pointer().text_size(11)
          .border_1().border_color(off ? t.border : color).opacity(off ? 0.45 : 1).hover((st) => st.bg(t.hover))
          .tooltip(off ? `Show ${src}` : `Hide ${src}`)
          .on_click((_e, cx) => { off ? this.hidden.delete(src) : this.hidden.add(src); this.recompute(); cx.notify(); })
          .child(div().size(7).rounded(4).bg(color))
          .child(div().text_color(off ? t.dim : t.foreground).child(L.shortSrc(src)))
          .child(div().text_color(t.dim).child(String(count)));
      }));

    return v_flex().id("kube-logs").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
      .track_focus(this.focusH).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .child(header).child(toolbar).child(searchRow)
      .when(this.asking, (el) => el.child(askRow))
      .when(multi, (el) => el.child(pills))
      .child(this.body(t, font, multi))
      .child(h_flex().h(24).flex_none().px(12).gap(10).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
        .child(div().child(`${this.state.lines.length} lines${this.shown.length !== this.state.lines.length ? ` · ${this.shown.length} shown` : ""}`))
        .when(Boolean(this.error && this.state.lines.length), (el) => el.child(div().min_w(0).truncate().text_color(t.ansi1).child(`Read failed: ${msg(this.error).split("\n")[0]}`)))
        .child(div().flex_1())
        .child(div().child("click a line to pick · / search · space follow · c copy · w wrap · t time")));
  }

  body(t, font, multi) {
    if (this.error && !this.state.lines.length) {
      return v_flex().flex_1().items_center().justify_center().gap(8).p(24)
        .child(div().text_size(14).font_semibold().child(this.spec.previous ? "No previous container logs" : "Couldn't read the logs"))
        .child(div().max_w(640).text_size(12).text_color(t.muted).font_family(font).child(msg(this.error)));
    }
    if (!this.updatedAt) return div().flex_1().flex().items_center().justify_center().text_color(t.dim).child("Reading logs…");
    const list = this.shown;
    if (!list.length) {
      return div().flex_1().flex().items_center().justify_center().text_color(t.dim)
        .child(this.state.lines.length ? "No lines match the filters" : this.range === "tail" ? "No log lines" : `No log lines in the last ${this.range}`);
    }

    const srcW = Math.max(90, Math.min(SRC_W, Math.round(this.width * 0.2)));
    const textW = Math.max(120, this.width - 24 - 14 - (this.showTime ? TIME_W + 8 : 0) - (multi ? srcW + 8 : 0));
    const perLine = Math.max(10, Math.floor(textW / CHAR_W) - 1);
    const sizes = this.wrap ? list.map((l) => wrapCount(l.text, perLine) * LH + 4) : LH + 2;
    const cur = this.at >= 0 ? this.hits[this.at] : -1;
    const q = this.q;

    const textCell = (l, color, hit) => {
      if (this.wrap) return div().flex_1().min_w(0).text_color(color).child(l.text || " ");
      // Unwrapped: whole lines on one row; the list scrolls sideways to reach their ends.
      if (!hit) return div().flex_none().whitespace_nowrap().text_color(color).child(l.text || " ");
      const parts = [];
      let from = 0;
      for (const [a, b] of L.matches(l.text, q)) {
        if (a > from) parts.push(div().flex_none().whitespace_nowrap().text_color(color).child(l.text.slice(from, a)));
        parts.push(div().flex_none().whitespace_nowrap().rounded(2).bg(t.ansi3).text_color(t.background).child(l.text.slice(a, b)));
        from = b;
      }
      if (from < l.text.length) parts.push(div().flex_none().whitespace_nowrap().text_color(color).child(l.text.slice(from)));
      return h_flex().flex_none().children(parts);
    };

    const row = (l, i, h) => {
      const picked = this.picked.has(l.id);
      const hit = Boolean(q) && this.hitSet.has(i);
      const color = l.level === "error" ? t.ansi1 : l.level === "warn" ? t.ansi3 : l.level === "debug" ? t.dim : t.foreground;
      const bg = picked ? t.selected : i === cur ? t.hover : hit ? t.surface : t.background;
      return h_flex().h(h).w_full().px(10).gap(8).items_start().overflow_hidden().cursor_pointer()
        .bg(bg).border_l(2).border_color(picked ? t.accent : i === cur ? t.ansi3 : bg)
        .hover((st) => st.bg(picked ? t.selected : t.hover))
        .when(this.showTime, (el) => el.child(div().w(TIME_W).flex_none().text_color(t.dim).child(L.clock(l.ts))))
        .when(multi, (el) => el.child(div().w(srcW).flex_none().truncate().text_color(L.colorOf(this.order, l.src)).child(L.shortSrc(l.src))))
        .child(textCell(l, color, hit));
    };

    const id = `kube-log-lines-${this.gen}`;
    // Unwrapped, the rows are as wide as the longest shown line (capped), inside a sideways
    // scroll area; the virtual list keeps scrolling up and down inside it.
    let longest = 0;
    if (!this.wrap) for (const l of list) if (l.text.length > longest) longest = l.text.length;
    const rowW = 24 + (this.showTime ? TIME_W + 8 : 0) + (multi ? srcW + 8 : 0) + Math.ceil(Math.min(longest, 4000) * CHAR_W) + 16;
    const lines = v_virtual_list(id, list.length, sizes, (i) => String(list[i]?.id ?? i),
        (range) => list.slice(range.start, range.end).map((l, j) => row(l, range.start + j, Array.isArray(sizes) ? sizes[range.start + j] : sizes)))
        .size_full().track_scroll(this.scroll)
        .on_item_click((key, cx) => {
          const n = Number(key);
          this.picked.has(n) ? this.picked.delete(n) : this.picked.add(n);
          this.focusH.focus();
          cx.notify();
        });
    return div().flex_1().min_h(0).relative().font_family(font).text_size(FONT).line_height(`${LH}px`)
      .on_scroll_wheel((e, cx) => { if (this.following && (e.delta?.y ?? 0) > 0) { this.following = false; cx.notify(); } })
      .child(this.wrap ? lines : div().id(`${id}-x`).size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(rowW).h_full().child(lines)))
      .child(Scrollbar.vertical(id).viewport_from_layout().absolute().inset_0());
  }
}
