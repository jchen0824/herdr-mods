"use strict";

const $ = (s) => document.querySelector(s);
const SIZES = { desktop: [1280, 800], tablet: [768, 1024], phone: [390, 844] };
const PHONE_MAX_WIDTH = 820;
const LAYER_WAIT_MS = 6000;
const POLL_MS = 2500;
const ZOOM_MIN = 0.2, ZOOM_MAX = 1.5, ZOOM_STEP = 0.1, FIT_MIN = 0.35;
const BOARDS_SIDE_BY_SIDE = 2, STAGE_CHROME_HEIGHT = 74, STAGE_CHROME_WIDTH = 88;
const COMPOSER_GAP = 10, COMPOSER_MARGIN = 8, QUOTE_PREVIEW = 32;
const MINUTE = 60, HOUR = 3600, DAY = 86400, MS_PER_SECOND = 1000;

let boards = [];
let catalog = [];
let mode = "comment";
let width = "desktop";
let zoom = null;
let scale = 1;
let draft = null;
let selected = null;
let notice = "", failed = false;
let panelOpen = window.innerWidth > PHONE_MAX_WIDTH;
let filter = "open";
let query = "";
const folded = new Set();

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  fill(el, kids);
  return el;
}

function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false));
}

async function api(path, body) {
  const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const out = await r.json();
  if (!r.ok || out.error) throw new Error(out.error || `HTTP ${r.status}`);
  return out;
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / MS_PER_SECOND);
  return s < MINUTE ? "now" : s < HOUR ? `${Math.floor(s / MINUTE)}m` : s < DAY ? `${Math.floor(s / HOUR)}h` : `${Math.floor(s / DAY)}d`;
}

const say = (text, bad) => { notice = text; failed = Boolean(bad); renderPanel(); };
const url = (b, rest = "") => `/api/artifacts/${encodeURIComponent(b.id)}${rest}`;
const live = (b) => b.data.artifact.kind === "url";
const agentName = (b) => (b.data.agent ? `agent ${b.data.agent.terminal}` : "the agent");
const canSend = (b) => b.data.agent?.state === "agent";
const isPerson = (author) => author.kind === "person";
const agentState = (b) => (canSend(b) ? `(${b.data.agent.status})` : "(no agent running)");
const who = (b, author) => (isPerson(author) ? "You" : author.address === b.data.agent?.terminal ? agentName(b) : author.address);
const isSel = (b, c) => Boolean(selected && selected.board === b && selected.id === c.id);

function addBoard(id) {
  const b = { id, data: null, version: null, follow: true, ready: false, gone: new Set(), src: "" };
  b.frame = h("iframe", { title: "An artifact under review" });
  b.layer = h("div", { class: "layer" });
  b.shot = h("div", { class: "shot" }, b.frame, b.layer);
  b.strip = h("div", { class: "strip" });
  b.el = h("section", { class: "board" }, b.strip, b.shot);
  $("#stage").append(b.el);
  boards.push(b);
  return b;
}

function removeBoard(b) {
  if (draft?.board === b) draft = null;
  if (selected?.board === b) selected = null;
  b.el.remove();
  boards = boards.filter((x) => x !== b);
  syncAddress(); render();
}

const syncAddress = () => history.replaceState(null, "", `/review/${boards.map((b) => encodeURIComponent(b.id)).join(",")}`);

function loadFrame(b) {
  const f = b.data.frame, v = b.data.artifact.versions.find((x) => x.n === b.version);
  const src = f.path !== undefined ? f.origin + f.path : `${f.origin}/a/${encodeURIComponent(b.id)}/v${b.version}/${encodeURIComponent(v.file)}`;
  if (draft?.board === b) draft = null;
  b.ready = false; b.src = src; b.frame.src = src;
  setTimeout(() => {
    if (!b.ready && b.src === src) say(`Comments are unavailable on “${b.data.artifact.title}”: its comment layer did not load.${live(b) ? " Is the dev server running?" : ""}`, true);
  }, LAYER_WAIT_MS);
}

function push(b) {
  if (!b.ready || !b.data) return;
  b.frame.contentWindow.postMessage({ herdr: true, type: "state", mode, scale, selected: selected?.board === b ? selected.id : null,
    drafting: draft?.board === b,
    comments: b.data.comments.map((c, i) => ({ id: c.id, n: i + 1, open: c.open, anchor: c.anchor })) }, b.data.frame.origin);
}

window.addEventListener("message", (e) => {
  const b = boards.find((x) => x.data && e.source === x.frame.contentWindow && e.origin === x.data.frame.origin);
  if (!b || !e.data || e.data.herdr !== true) return;
  const m = e.data;
  if (m.type === "ready") { b.ready = true; if (failed) { notice = ""; failed = false; } renderPanel(); }
  else if (m.type === "select") {
    draft = { board: b, rect: m.rect, anchor: m.anchor, text: "", toAgent: canSend(b) }; selected = null; render();
    b.el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }
  else if (m.type === "rect" && draft?.board === b) draft.rect = m.rect;
  else if (m.type === "pin") { selected = { board: b, id: m.id }; draft = null; panelOpen = true; folded.delete(b.id); render(); showSelected(); }
  else if (m.type === "gone") { b.gone = new Set(m.ids); renderPanel(); }
  else if (m.type === "trouble") say(`“${b.data.artifact.title}” reported a problem: ${m.text}`, true);
  else if (m.type === "key") { if (m.key === "Escape") { draft = null; render(); } else setMode(mode === "comment" ? "page" : "comment"); }
});

function onKey(e) {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === "Escape" && draft) { draft = null; render(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "c" || e.key === "C") { setMode(mode === "comment" ? "page" : "comment"); e.preventDefault(); }
}
document.addEventListener("keydown", onKey);

function setMode(next) {
  mode = next;
  if (next === "page") draft = null;
  render();
}

function layout() {
  const stage = $("#stage"), solo = boards.length === 1 && width === "desktop" && zoom === null;
  const [w, hgt] = SIZES[width];
  const fitted = Math.min((stage.clientHeight - STAGE_CHROME_HEIGHT) / hgt, Math.max(FIT_MIN, (stage.clientWidth - STAGE_CHROME_WIDTH) / (Math.min(boards.length, BOARDS_SIDE_BY_SIDE) * w)));
  scale = solo ? 1 : zoom ?? Math.min(1, Math.max(ZOOM_MIN, fitted));
  stage.classList.toggle("solo", solo);
  for (const b of boards) {
    const css = solo ? ["", "", "100%", "100%", ""] : [`${w * scale}px`, `${hgt * scale}px`, `${w}px`, `${hgt}px`, `scale(${scale})`];
    b.el.style.width = css[0];
    Object.assign(b.shot.style, { width: css[0], height: css[1] });
    Object.assign(b.frame.style, { width: css[2], height: css[3], transform: css[4] });
  }
}
window.addEventListener("resize", layout);

function renderStrip(b) {
  const a = b.data.artifact, total = a.versions.length;
  const status = STATUS[a.status] || a.status;
  fill(b.strip,
    h("span", { class: "name" }, a.title),
    h("span", { class: "meta mono" }, `${live(b) ? "live" : `v${b.version}`}${b.data.agent ? ` · ${agentName(b)} ${agentState(b)}` : ""}`),
    h("span", { class: `pill ${a.status}` }, status),
    h("span", { class: "grow" }),
    !live(b) && total > 1 ? h("select", { class: "small", "aria-label": `Version of ${a.title}`,
      onchange: (e) => { b.version = Number(e.target.value); b.follow = b.version === total; loadFrame(b); render(); } },
      a.versions.map((v) => h("option", { value: String(v.n), selected: v.n === b.version }, `v${v.n}${v.n === total ? " · latest" : ""}`))) : null,
    h("button", { class: "small", type: "button", onclick: () => act(b, url(b, "/status"), { status: "changes_requested" }) }, "Request changes"),
    h("button", { class: "small ok", type: "button", onclick: () => act(b, url(b, "/status"), { status: "approved" }) }, "Approve"),
    boards.length > 1 ? h("button", { class: "small", type: "button", "aria-label": `Remove ${a.title} from this review`, onclick: () => removeBoard(b) }, "×") : null);
}

let composerEl = null;

function renderComposer() {
  composerEl?.remove(); composerEl = null;
  if (!draft) return;
  const b = draft.board, sendable = canSend(b);
  const area = h("textarea", { rows: "3", "aria-label": "Comment", placeholder: "What should change here?", value: draft.text,
    oninput: (e) => { draft.text = e.target.value; },
    onkeydown: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } if (e.key === "Escape") { draft = null; render(); } } });
  const pick = (v, label, enabled) => h("button", { type: "button", role: "radio", "aria-checked": String(draft.toAgent === v), disabled: !enabled,
    onclick: () => { draft.toAgent = v; draft.text = area.value; renderComposer(); } }, label);
  composerEl = h("div", { class: "composer" },
    h("div", { class: "where" }, h("span", {}, "Pinned on"), h("span", { class: "chip mono" }, draft.anchor.label), h("span", {}, draft.anchor.text ? `“${draft.anchor.text.slice(0, QUOTE_PREVIEW)}”` : "")),
    area,
    h("div", { class: "row" },
      h("div", { class: "seg", role: "radiogroup", "aria-label": "Who gets this comment" },
        pick(false, "Note", true), pick(true, sendable ? `Send to ${agentName(b)}` : "No agent running", sendable)),
      h("span", { class: "grow" }),
      h("button", { class: "btn primary", type: "button", onclick: send }, "Send")));
  b.layer.append(composerEl);
  area.focus();
}

function placeComposer() {
  if (composerEl && draft) {
    const r = draft.rect, layer = draft.board.layer, cw = composerEl.offsetWidth, ch = composerEl.offsetHeight;
    const left = Math.min(Math.max(COMPOSER_MARGIN, r.left * scale), Math.max(COMPOSER_MARGIN, layer.clientWidth - cw - COMPOSER_MARGIN));
    const below = r.bottom * scale + COMPOSER_GAP;
    const top = below + ch > layer.clientHeight - COMPOSER_MARGIN ? Math.max(COMPOSER_MARGIN, r.top * scale - ch - COMPOSER_GAP) : below;
    Object.assign(composerEl.style, { left: `${left}px`, top: `${top}px` });
  }
  requestAnimationFrame(placeComposer);
}
requestAnimationFrame(placeComposer);

async function send() {
  const sending = draft, body = (sending?.text || "").trim();
  if (!body) return;
  const b = sending.board;
  draft = null; renderComposer();
  try {
    const made = await api(url(b, "/comments"), { body, version: b.version, anchor: sending.anchor, to_agent: sending.toAgent });
    selected = { board: b, id: made.comment.id };
    notice = made.delivered === false ? `Saved, but not delivered: ${made.delivery_error}` : sending.toAgent ? `Sent to ${agentName(b)}.` : "Note saved.";
    failed = made.delivered === false;
  } catch (e) { notice = `Not saved: ${e.message}`; failed = true; draft = sending; }
  await refresh(true);
}

async function act(b, path, body) {
  try {
    const out = await api(path, body);
    failed = out.delivered === false;
    notice = out.delivered === true ? `Reply sent to ${agentName(b)}.` : failed ? `Reply saved, but not delivered: ${out.delivery_error}` : "";
  } catch (e) { notice = e.message; failed = true; }
  await refresh(true);
}

function showSelected() {
  if (!selected) return;
  const b = selected.board, c = b.data.comments.find((x) => x.id === selected.id);
  b.el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  if (c && b.ready) b.frame.contentWindow.postMessage({ herdr: true, type: "reveal", anchor: c.anchor }, b.data.frame.origin);
  document.querySelector(".thread.sel")?.scrollIntoView({ block: "nearest" });
}

const STATUS = { working: "Working", ready: "Ready for review", changes_requested: "Changes requested", approved: "Approved" };

function renderBar() {
  const ready = boards.filter((b) => b.data), open = ready.reduce((n, b) => n + b.data.comments.filter((c) => c.open).length, 0);
  const seg = (cls, label, current, options, set) => h("div", { class: `seg ${cls}`, role: "radiogroup", "aria-label": label },
    options.map(([v, text]) => h("button", { type: "button", role: "radio", "data-v": v, "aria-checked": String(current === v), onclick: () => set(v) }, text)));
  const others = catalog.filter((a) => !boards.some((b) => b.id === a.id));
  const first = ready[0]?.data.artifact;
  fill($("#bar"),
    h("div", { class: "who" },
      h("span", { class: "title" }, ready.length === 1 ? first.title : `${boards.length} pages under review`),
      h("span", { class: "source mono" }, ready.length === 1 ? first.source : ready.map((b) => b.data.artifact.title).join(" · "))),
    seg("mode", "Pointer mode", mode, [["page", "Use page"], ["comment", "Comment  C"]], setMode),
    seg("width", "Width", width, [["desktop", "Desktop"], ["tablet", "Tablet"], ["phone", "Phone"]], (v) => { width = v; render(); }),
    h("div", { class: "seg zoom", role: "group", "aria-label": "Zoom" },
      h("button", { type: "button", "aria-label": "Zoom out", onclick: () => { zoom = Math.max(ZOOM_MIN, Math.round((scale - ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP); render(); } }, "−"),
      h("button", { type: "button", "aria-label": "Fit to the window", onclick: () => { zoom = null; render(); } }, `${Math.round(scale * 100)}%`),
      h("button", { type: "button", "aria-label": "Zoom in", onclick: () => { zoom = Math.min(ZOOM_MAX, Math.round((scale + ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP); render(); } }, "+")),
    others.length ? h("select", { class: "btn add", "aria-label": "Add a page to this review",
      onchange: (e) => { if (e.target.value) { addBoard(e.target.value); syncAddress(); refresh(true); } } },
      h("option", { value: "" }, "+ Add page"), others.map((a) => h("option", { value: a.id }, `${a.title} · ${a.kind}`))) : null,
    h("span", { class: "grow" }),
    h("button", { class: `btn comments${panelOpen ? " on" : ""}`, type: "button", "aria-expanded": String(panelOpen), "aria-controls": "panel",
      onclick: () => { panelOpen = !panelOpen; render(); } }, "Comments ", h("b", {}, String(open))));
  document.title = ready.length === 1 ? `Review · ${first.title}` : `Review · ${boards.length} pages`;
}

function thread(b, c, n) {
  const a = c.anchor, sel = isSel(b, c);
  const working = c.open && c.sent_to_agent && canSend(b) && b.data.agent.status === "working";
  const path = url(b, `/comments/${encodeURIComponent(c.id)}`);
  return h("div", { class: `thread${sel ? " sel" : ""}${c.open ? "" : " done"}`, onclick: () => { selected = { board: b, id: c.id }; draft = null; render(); showSelected(); } },
    h("div", { class: "row" },
      h("span", { class: `pin${c.open ? "" : " done"}` }, c.open ? String(n) : "✓"),
      a && a.kind === "element" ? h("span", { class: "chip mono" }, a.label || "element") : null,
      h("span", { class: "meta" }, `${who(b, c.author)}${c.sent_to_agent ? "" : " · note"}${c.open ? "" : c.resolved_in ? ` · resolved in v${c.resolved_in}` : " · resolved"}`),
      h("span", { class: "time" }, ago(c.at))),
    h("div", { class: sel ? "" : "clip" }, c.body),
    working ? h("div", { class: "note" }, h("span", { class: "spin" }), `Sent to ${agentName(b)} · working`) : null,
    sel && b.gone.has(c.id) ? h("div", { class: "note gone" }, "The element it was pinned on is not on the page now: outdated, or fixed.") : null,
    sel ? c.replies.map((r) => h("div", { class: `replyline${isPerson(r.author) ? " me" : ""}` }, h("i", {}), h("div", {}, h("b", {}, `${who(b, r.author)} `), r.body)))
      : c.replies.length ? h("div", { class: "more" }, `${c.replies.length} ${c.replies.length === 1 ? "reply" : "replies"} · last from ${who(b, c.replies.at(-1).author)}`) : null,
    sel ? h("div", { class: "row", onclick: (e) => e.stopPropagation() },
      h("input", { class: "reply", type: "text", "data-keep": `reply-${c.id}`, "aria-label": "Reply",
        placeholder: c.sent_to_agent && canSend(b) ? `Reply to ${agentName(b)}… (Enter sends)` : "Reply… (Enter saves)",
        onkeydown: (e) => { if (e.key === "Enter" && e.target.value.trim()) { const text = e.target.value.trim(); e.target.value = ""; e.target.blur(); act(b, path, { action: "reply", body: text }); } } }),
      h("button", { class: "small", type: "button", onclick: () => act(b, path, { action: c.open ? "resolve" : "reopen" }) }, c.open ? "Resolve" : "Reopen")) : null);
}

function renderPanel() {
  for (const b of boards) push(b);
  document.body.classList.toggle("panel-closed", !panelOpen);
  $("#toast").textContent = panelOpen ? "" : notice;
  $("#toast").className = failed ? "err" : "";
  const ready = boards.filter((b) => b.data), all = ready.flatMap((b) => b.data.comments);
  const counts = { open: all.filter((c) => c.open).length, resolved: all.filter((c) => !c.open).length, all: all.length };
  const needle = query.trim().toLowerCase();
  const shown = (c) => (filter === "all" || (filter === "open") === c.open)
    && (!needle || `${c.body} ${c.anchor?.label || ""} ${c.anchor?.text || ""} ${c.replies.map((r) => r.body).join(" ")}`.toLowerCase().includes(needle));
  const groups = ready.map((b) => {
    const rows = b.data.comments.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => shown(c) || isSel(b, c));
    const head = ready.length > 1 ? h("button", { class: "group", type: "button", "aria-expanded": String(!folded.has(b.id)),
      onclick: () => { if (!folded.delete(b.id)) folded.add(b.id); renderPanel(); } },
      h("span", {}, folded.has(b.id) ? "▸" : "▾"), h("span", { class: "gname" }, b.data.artifact.title), h("span", { class: "gcount" }, `${rows.length}`)) : null;
    return [head, folded.has(b.id) ? null : rows.map(({ c, n }) => thread(b, c, n))];
  });
  const kept = document.activeElement?.dataset?.keep, keptValue = kept ? document.activeElement.value : null;
  fill($("#panel"),
    h("div", { class: "head" }, h("b", {}, "Comments"), h("span", {}, `${counts.open} open${counts.resolved ? ` · ${counts.resolved} resolved` : ""}`), h("span", { class: "grow" }),
      h("button", { class: "small", type: "button", "aria-label": "Close comments", onclick: () => { panelOpen = false; render(); } }, "Close")),
    h("div", { class: "tools" },
      h("input", { class: "search", type: "search", "data-keep": "search", placeholder: "Search comments", "aria-label": "Search comments", value: query,
        oninput: (e) => { query = e.target.value; renderPanel(); } }),
      h("div", { class: "filters" }, [["open", "Open"], ["resolved", "Resolved"], ["all", "All"]].map(([v, label]) =>
        h("button", { class: `chipbtn${filter === v ? " on" : ""}`, type: "button", "aria-pressed": String(filter === v), onclick: () => { filter = v; renderPanel(); } }, `${label} ${counts[v]}`)))),
    h("div", { id: "threads" }, all.length ? groups
      : h("div", { class: "empty" }, "No comments yet. With Comment on, click anywhere on a page to drop a pin there.")),
    h("div", { id: "foot", class: failed ? "err" : "" }, notice || (mode === "comment"
      ? "Comment mode: click anywhere to drop a pin. Press C or pick Use page to click through."
      : "Using the pages. Press C to comment again.")));
  if (kept) { const el = document.querySelector(`[data-keep="${CSS.escape(kept)}"]`); if (el) { el.value = keptValue; el.focus(); } }
}

function render() {
  layout(); renderBar();
  for (const b of boards) if (b.data) renderStrip(b);
  renderComposer(); renderPanel();
}

async function refresh(force) {
  let changed = Boolean(force);
  catalog = await api("/api/artifacts").catch(() => catalog);
  for (const b of [...boards]) {
    try {
      const next = await api(url(b)), latest = next.artifact.versions.length, first = b.data === null;
      if (JSON.stringify(next) !== JSON.stringify(b.data)) changed = true;
      b.data = next;
      if (first || (b.follow && latest !== b.version)) {
        b.version = latest;
        if (first || !live(b)) loadFrame(b);
        if (!first) { notice = `“${next.artifact.title}” v${latest} was published.`; failed = false; }
      }
    } catch (e) {
      if (b.data === null) { say(`Cannot load ${b.id}: ${e.message}`, true); b.el.remove(); boards = boards.filter((x) => x !== b); syncAddress(); changed = true; }
    }
  }
  if (changed) render();
}

for (const id of decodeURIComponent(location.pathname.split("/")[2] || "").split(",").filter(Boolean)) addBoard(id);
refresh(true);
setInterval(() => { if (!document.hidden) refresh(false); }, POLL_MS);
