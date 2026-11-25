(() => {
  "use strict";
  const REVIEW = document.currentScript?.dataset.review;
  if (!REVIEW || window.parent === window || window.__herdrReview) return;
  window.__herdrReview = true;

  const PIN = 24, TEXT_LIMIT = 80, TROUBLE_LIMIT = 200, MIDDLE = 0.5;
  let mode = "page", comments = [], selected = null, drafting = false;
  let frameScale = 1;
  let draftEl = null, draftAt = null, lastRect = "", lastGone = "", lastPlace = location.href;

  const host = document.createElement("herdr-review-layer");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .pin{position:fixed;width:24px;height:24px;margin:-24px 0 0 0;transform-origin:0 100%;border:0;border-radius:12px 12px 12px 3px;background:#f0b35a;color:#1a1408;font:700 12px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer}
    .pin[hidden]{display:none}
    .pin.done{background:#2b3a2f;color:#8fc7a0}.pin.sel{outline:2px solid #fff;outline-offset:2px}
    .pin.draft{background:#f0b35a;pointer-events:none;outline:3px solid rgba(240,179,90,.35)}
  </style><div class="pin draft" hidden>+</div>`;
  const draftPin = root.querySelector(".draft");
  const cursor = document.createElement("style");
  const mount = () => { document.documentElement.append(host); document.head?.append(cursor); };
  mount();

  const post = (message) => window.parent.postMessage({ herdr: true, ...message }, REVIEW);

  function selectorOf(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e === document.body) { parts.unshift("body"); break; }
      const same = [...e.parentElement.children].filter((c) => c.localName === e.localName);
      parts.unshift(same.length > 1 ? `${e.localName}:nth-of-type(${same.indexOf(e) + 1})` : e.localName);
    }
    return parts.join(" > ");
  }
  const textOf = (el) => (el.innerText || el.getAttribute("alt") || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, TEXT_LIMIT);
  const labelOf = (el) => el.localName + (el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : "");

  function querySelectorOrNull(selector) {
    try { return document.querySelector(selector); } catch { return null; }
  }

  function find(anchor) {
    if (!anchor || anchor.kind !== "element") return null;
    const el = querySelectorOrNull(anchor.selector);
    if (el && (!anchor.text || textOf(el) === anchor.text)) return el;
    const name = (anchor.label || "").split(/[.#]/)[0];
    const same = anchor.text && name ? [...document.getElementsByTagName(name)] : [];
    return same.find((e) => textOf(e) === anchor.text) || same.find((e) => textOf(e).startsWith(anchor.text)) || el;
  }

  const pointOn = (el, x, y) => { const r = el.getBoundingClientRect(); return { x: r.left + x * r.width, y: r.top + y * r.height }; };
  const pageSize = () => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  const onPage = (anchor) => { const size = pageSize(); return { x: anchor.x * size.width, y: anchor.y * size.height }; };

  function placeOf(anchor) {
    if (anchor?.kind === "pin") { const at = onPage(anchor); return { x: at.x - window.scrollX, y: at.y - window.scrollY }; }
    const el = find(anchor);
    return el ? pointOn(el, anchor.x ?? 1, anchor.y ?? 0) : null;
  }

  function reveal(anchor) {
    if (anchor?.kind === "pin") {
      const at = onPage(anchor);
      window.scrollTo({ left: at.x - window.innerWidth / 2, top: at.y - window.innerHeight / 2, behavior: "smooth" });
    } else find(anchor)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const pinBox = (pt) => ({ left: pt.x, top: pt.y - PIN, right: pt.x + PIN, bottom: pt.y, width: PIN, height: PIN });

  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup", "auxclick", "submit"]) {
    document.addEventListener(type, (e) => {
      if (mode !== "comment" || e.target === host) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (type !== "click" || e.target.nodeType !== 1) return;
      const el = e.target, r = el.getBoundingClientRect(), clamp = (n) => Math.min(1, Math.max(0, n));
      draftAt = { x: r.width ? clamp((e.clientX - r.left) / r.width) : MIDDLE, y: r.height ? clamp((e.clientY - r.top) / r.height) : MIDDLE };
      draftEl = el; drafting = true;
      post({ type: "select", rect: pinBox(pointOn(el, draftAt.x, draftAt.y)),
        anchor: { kind: "element", selector: selectorOf(el), label: labelOf(el), text: textOf(el) || null, ...draftAt } });
    }, true);
  }
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "Escape" && drafting) { post({ type: "key", key: "Escape" }); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "c" || e.key === "C") { post({ type: "key", key: "c" }); e.preventDefault(); }
  }, true);

  window.addEventListener("message", (e) => {
    if (e.origin !== REVIEW || !e.data || e.data.herdr !== true) return;
    const m = e.data;
    if (m.type === "state") {
      mode = m.mode; comments = m.comments; selected = m.selected; drafting = m.drafting;
      frameScale = m.scale > 0 ? m.scale : 1;
      if (!drafting) draftEl = null;
      cursor.textContent = mode === "comment" ? `* { cursor: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'%3E%3Cpath d='M13 3a10 10 0 0 1 0 20H4a1 1 0 0 1-1-1v-9A10 10 0 0 1 13 3z' fill='%23f0b35a' stroke='%231a1408' stroke-width='1.5'/%3E%3Cpath d='M13 9v8M9 13h8' stroke='%231a1408' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E\") 3 23, crosshair !important; }` : "";
    } else if (m.type === "reveal") {
      reveal(m.anchor);
    }
  });

  window.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t !== window && (t.src || t.href)) post({ type: "trouble", text: `could not load ${t.src || t.href}` });
    else if (e.message) post({ type: "trouble", text: String(e.message).slice(0, TROUBLE_LIMIT) });
  }, true);
  window.addEventListener("unhandledrejection", (e) => post({ type: "trouble", text: String(e.reason).slice(0, TROUBLE_LIMIT) }));

  const pins = new Map();
  const place = () => ({ path: location.pathname, search: location.search });

  function draw() {
    if (!host.isConnected) mount();
    if (location.href !== lastPlace) { lastPlace = location.href; post({ type: "path", ...place() }); }
    if (draftEl && draftEl.isConnected && draftAt) {
      const pt = pointOn(draftEl, draftAt.x, draftAt.y), rect = pinBox(pt), key = JSON.stringify(rect);
      Object.assign(draftPin.style, { left: `${pt.x}px`, top: `${pt.y}px`, transform: `scale(${1 / frameScale})` });
      draftPin.hidden = false;
      if (key !== lastRect) { lastRect = key; post({ type: "rect", rect }); }
    } else draftPin.hidden = true;

    const wanted = new Set(), gone = [];
    for (const c of comments) {
      const pt = placeOf(c.anchor);
      if (c.anchor?.kind === "element" && !pt) gone.push(c.id);
      if (!pt || !(c.open || selected === c.id)) continue;
      wanted.add(c.id);
      let pin = pins.get(c.id);
      if (!pin) {
        pin = document.createElement("button");
        pin.addEventListener("click", () => post({ type: "pin", id: c.id }));
        pins.set(c.id, pin); root.append(pin);
      }
      pin.className = `pin${c.open ? "" : " done"}${selected === c.id ? " sel" : ""}`;
      pin.textContent = c.open ? String(c.n) : "✓";
      pin.setAttribute("aria-label", `Comment ${c.n}`);
      Object.assign(pin.style, { left: `${pt.x}px`, top: `${pt.y}px`, transform: `scale(${1 / frameScale})` });
    }
    for (const [id, pin] of pins) if (!wanted.has(id)) { pin.remove(); pins.delete(id); }
    const goneKey = gone.join(",");
    if (goneKey !== lastGone) { lastGone = goneKey; post({ type: "gone", ids: gone }); }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  post({ type: "ready", ...place() });
})();
