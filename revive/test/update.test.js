import assert from "node:assert/strict";
import { test } from "node:test";
import { newer, updater as updaterOf, REPO, RELEASES } from "../mods/revive/lib/update.js";

// herdr-mods turns the check off by default (lib/update.js); these tests are about the check itself.
const updater = (opts) => updaterOf({ check: true, ...opts });

const DAY = 24 * 60 * 60 * 1000;

/** Herdr's shared state, a clock and GitHub, all fake. `release` is what GitHub answers. */
function fake({ release = { tag_name: "v0.6.0", html_url: `https://github.com/${REPO}/releases/tag/v0.6.0` }, ok = true, version = "0.5.2" } = {}) {
  const store = new Map();
  const calls = [];
  let clock = 1_000_000_000_000;
  const u = updater({
    shared: (k) => store.get(k),
    setShared: (k, v) => { store.set(k, v); return null; },
    fetch: async (url, opts) => { calls.push({ url, opts }); return { ok, json: async () => release }; },
    now: () => clock,
    version,
  });
  return { u, store, calls, tick: (ms) => { clock += ms; } };
}

test("versions compare by number, with or without a v", () => {
  assert.equal(newer("v0.6.0", "0.5.2"), true);
  assert.equal(newer("0.5.10", "0.5.9"), true);
  assert.equal(newer("v0.5.2", "0.5.2"), false);
  assert.equal(newer("0.5.1", "0.5.2"), false);
  assert.equal(newer("1.0", "0.9.9"), true);
});

test("a newer release is offered after a check, and GitHub is asked at most once a day", async () => {
  const { u, calls, tick } = fake();
  assert.equal(u.available(), null, "nothing before the first check");
  await u.check();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.github.com/repos/${REPO}/releases/latest`);
  assert.deepEqual(u.available(), { tag: "v0.6.0", url: `https://github.com/${REPO}/releases/tag/v0.6.0` });
  await u.check();
  tick(DAY - 1);
  await u.check();
  assert.equal(calls.length, 1, "not again the same day");
  tick(1);
  await u.check();
  assert.equal(calls.length, 2);
});

test("the release we have, or an older one, is not offered", async () => {
  const same = fake({ release: { tag_name: "v0.5.2" } });
  await same.u.check();
  assert.equal(same.u.available(), null);
  const older = fake({ release: { tag_name: "v0.4.0" } });
  await older.u.check();
  assert.equal(older.u.available(), null);
});

test("Later hides that release only; Stop checking stops asking for good", async () => {
  const { u, store, calls, tick } = fake();
  await u.check();
  u.dismiss("v0.6.0");
  assert.equal(u.available(), null);
  store.set("revive.update", { ...store.get("revive.update"), latest: { tag: "v0.6.1", url: RELEASES } });
  assert.equal(u.available().tag, "v0.6.1", "the next release shows again");
  u.stop();
  assert.equal(u.available(), null);
  tick(2 * DAY);
  await u.check();
  assert.equal(calls.length, 1, "no more requests once stopped");
});

test("a failed, odd or foreign answer offers nothing and never throws", async () => {
  for (const f of [fake({ ok: false }), fake({ release: { tag_name: 7 } }), fake({ release: { tag_name: "nightly" } }), fake({ release: null })]) {
    await f.u.check();
    assert.equal(f.u.available(), null);
  }
  const thrown = updater({ shared: () => undefined, setShared: () => null, fetch: async () => { throw new Error("offline"); } });
  await thrown.check();
  assert.equal(thrown.available(), null);
});

test("a failed try is asked again an hour later, not a day later", async () => {
  const refused = fake({ ok: false });
  await refused.u.check();
  refused.tick(60 * 60 * 1000 - 1);
  await refused.u.check();
  assert.equal(refused.calls.length, 1, "not within the hour");
  refused.tick(1);
  await refused.u.check();
  assert.equal(refused.calls.length, 2);

  const store = new Map();
  let clock = 1_000_000_000_000, online = false, asked = 0;
  const u = updater({
    shared: (k) => store.get(k),
    setShared: (k, v) => { store.set(k, v); return null; },
    fetch: async () => { asked++; if (!online) throw new Error("offline"); return { ok: true, json: async () => ({ tag_name: "v9.0.0" }) }; },
    now: () => clock,
    version: "0.5.2",
  });
  await u.check();
  online = true;
  clock += 60 * 60 * 1000;
  await u.check();
  assert.equal(asked, 2);
  assert.equal(u.available().tag, "v9.0.0");
});

test("a check time in the future (a clock that was wrong) doesn't stop the checks", async () => {
  const f = fake();
  f.store.set("revive.update", { repo: REPO, checked: Date.now() + 365 * DAY });
  await f.u.check();
  assert.equal(f.calls.length, 1);
});

test("check() never throws, even when shared state can't be written", async () => {
  const u = updater({ shared: () => undefined, setShared: () => { throw new Error("gone"); }, fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await u.check();
});

test("only a page of this repository is opened; any other link falls back to the releases page", async () => {
  const f = fake({ release: { tag_name: "v0.6.0", html_url: "https://evil.example/x" } });
  await f.u.check();
  assert.equal(f.u.available().url, RELEASES);
});

test("a result saved for another repository counts as never checked, but Stop checking holds", async () => {
  const f = fake();
  f.store.set("revive.update", { repo: "someone/fork", checked: Date.now() + DAY, latest: { tag: "v9.0.0", url: "x" } });
  assert.equal(f.u.available(), null);
  await f.u.check();
  assert.equal(f.calls.length, 1);
  f.store.set("revive.update", { repo: "someone/fork", off: true });
  assert.equal(f.u.available(), null);
  await f.u.check();
  assert.equal(f.calls.length, 1);
});

test("a check cut short (the view dropped mid-request) doesn't count as asked", async () => {
  const store = new Map();
  let clock = 1_000_000_000_000, asked = 0;
  const make = (fetch) => updater({ shared: (k) => store.get(k), setShared: (k, v) => { store.set(k, v); return null; }, fetch, now: () => clock, version: "0.5.2", wait: () => new Promise(() => {}) });
  // A first copy asks and is never answered: Herdr dropped the view, or the dialog closed.
  make(async () => { asked++; return new Promise(() => {}); }).check();
  await Promise.resolve();
  const second = make(async () => { asked++; return { ok: true, json: async () => ({ tag_name: "v9.0.0" }) }; });
  await second.check();
  assert.equal(asked, 2, "the copy that stays asks too");
  assert.equal(second.available().tag, "v9.0.0");
  clock += 60 * 60 * 1000;
  await second.check();
  assert.equal(asked, 2, "an answer counts for the day");
});

test("a request that never answers counts as failed and is asked again an hour later", async () => {
  const store = new Map();
  let clock = 1_000_000_000_000, asked = 0, hang = true;
  const u = updater({
    shared: (k) => store.get(k),
    setShared: (k, v) => { store.set(k, v); return null; },
    fetch: async () => { asked++; if (hang) return new Promise(() => {}); return { ok: true, json: async () => ({ tag_name: "v9.0.0" }) }; },
    now: () => clock,
    version: "0.5.2",
    wait: async () => {},
  });
  await u.check();
  assert.equal(u.available(), null);
  clock += 60 * 60 * 1000;
  hang = false;
  await u.check();
  assert.equal(asked, 2, "asked again an hour later, not a day");
  assert.equal(u.available().tag, "v9.0.0");
});
