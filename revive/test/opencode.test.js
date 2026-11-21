// OpenCode (herdr-mods): its agent entry, its TUI plugin against fake OpenCode APIs, and its
// install into a throwaway home.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agentKey, command, carriedFlags, endAction, isOneShot, canFork } from "../mods/revive/lib/core.js";
import { track } from "../mods/revive/opencode/revive.js";
import plugin from "../mods/revive/opencode/revive.js";
import { POSIX_HARNESS } from "./helpers/platform.js";

const ENGINE = resolve("mods/revive/revive.mjs");
const ID = "ses_1f9c2fa9f001X5XWVm5w5PYsWT";

test("OpenCode is known by its command line and its report", () => {
  assert.equal(agentKey(null, ["opencode"]), "opencode");
  assert.equal(agentKey(null, ["/Users/me/.opencode/bin/opencode", "--auto"]), "opencode");
  assert.equal(agentKey("opencode"), "opencode");
  assert.equal(agentKey(null, ["node", "/usr/local/lib/node_modules/opencode-ai/bin/opencode"]), "opencode");
  assert.equal(agentKey(null, ["vim", "opencode"]), null);
});

test("OpenCode resumes with --session, keeps only safe flags, and has no fork", () => {
  const argv = ["opencode", "--auto", "--standalone", "--server", "http://evil", "--session", "ses_old", "--prompt", "hi", "~/proj"];
  const flags = carriedFlags("opencode", argv);
  assert.deepEqual(flags, ["--auto", "--standalone"]);
  const rec = { agent: "opencode", session: ID, flags };
  assert.deepEqual(command(rec), ["opencode", "--auto", "--standalone", "--session", ID]);
  assert.deepEqual(command(rec, "resume", { unattended: true }), ["opencode", "--standalone", "--session", ID], "an automatic resume drops --auto");
  assert.equal(command(rec, "fork"), null);
  assert.equal(canFork("opencode"), false);
});

test("OpenCode's exit is settled; anything else keeps the session", () => {
  assert.equal(endAction("opencode", "exit"), "settle");
  assert.equal(endAction("opencode", "other"), "keep");
  assert.equal(endAction("opencode", null), "keep");
});

test("OpenCode subcommands are one-shot runs; a folder argument isn't", () => {
  assert.ok(isOneShot("opencode", ["opencode", "run", "fix it"]));
  assert.ok(isOneShot("opencode", ["opencode", "serve"]));
  assert.ok(!isOneShot("opencode", ["opencode"]));
  assert.ok(!isOneShot("opencode", ["opencode", "./my-app"]));
});

/** A fake TUI: the route's session, the sessions it knows, and the hooks sent. */
function fakeTui() {
  const state = { route: null, sessions: new Map(), sent: [] };
  const stop = track({
    route: () => state.route,
    get: (id) => state.sessions.get(id),
    cwd: () => "/fallback",
    send: (payload, opts) => state.sent.push([payload, opts]),
    every: 60_000,
  });
  return { state, stop };
}

test("a session whose family isn't known yet is not recorded, and nothing ends", () => {
  const sent = [];
  const sessions = new Map([["ses_child", { id: "ses_child", parentID: "ses_root" }]]);
  const stop = track({ route: () => "ses_child", get: (id) => sessions.get(id), send: (p) => sent.push(p), every: 60_000 });
  stop();
  assert.deepEqual(sent, []);
});

test("start, a switch, and the end reach the engine as Claude-shaped hooks", () => {
  const state = { route: null, sessions: new Map(), sent: [] };
  let tick;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { tick = fn; return realSetInterval(() => {}, 1 << 30); };
  let stop;
  try {
    stop = track({ route: () => state.route, get: (id) => state.sessions.get(id), cwd: () => "/fallback", send: (p, o) => state.sent.push([p, o]) });
  } finally { globalThis.setInterval = realSetInterval; }

  state.sessions.set("ses_root", { id: "ses_root", directory: "/w/app" });
  state.sessions.set("ses_child", { id: "ses_child", parentID: "ses_root" });
  state.route = "ses_child";
  tick();
  tick();
  state.sessions.set("ses_other", { id: "ses_other" });
  state.route = "ses_other";
  tick();
  state.route = null; // the home screen: the last session stays on record
  tick();
  stop();

  assert.deepEqual(state.sent.map(([p, o]) => [p.hook_event_name, p.session_id, p.cwd, p.reason ?? null, Boolean(o?.wait)]), [
    ["SessionStart", "ses_root", "/w/app", null, false],
    ["SessionStart", "ses_other", "/fallback", null, false],
    ["SessionEnd", "ses_other", "/fallback", "exit", true],
  ]);
});

test("the plugin does nothing outside a herdr terminal", () => {
  const saved = process.env.HC_TERMINAL_ID;
  delete process.env.HC_TERMINAL_ID;
  try {
    let asked = false;
    const api = { ui: { router: { current: () => { asked = true; return null; } } }, data: { session: { get: () => null } } };
    assert.equal(plugin.setup(api), undefined);
    assert.equal(asked, false);
    assert.equal(plugin.id, "herdr-revive");
    assert.equal(typeof plugin.tui, "function");
  } finally { if (saved !== undefined) process.env.HC_TERMINAL_ID = saved; }
});

/** A home with OpenCode's config folder and a fake `opencode` on PATH. */
function home({ cli, tui } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "revive-opencode-"));
  const config = join(dir, ".config", "opencode");
  mkdirSync(config, { recursive: true });
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "opencode"), "#!/bin/sh\n");
  chmodSync(join(dir, "bin", "opencode"), 0o755);
  if (cli !== undefined) writeFileSync(join(config, "cli.json"), cli);
  if (tui !== undefined) writeFileSync(join(config, "tui.jsonc"), tui);
  const hc = join(dir, "bin", "hc");
  writeFileSync(hc, `#!/bin/sh\ncase "$1" in ls) echo '{"terminals":[]}' ;; *) exit 1 ;; esac\n`);
  chmodSync(hc, 0o755);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, SHELL: "/bin/bash", REVIVE_HC: hc, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ZDOTDIR", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "HC_TERMINAL_SOCKET", "PI_CODING_AGENT_DIR"]) delete env[k];
  const json = (name) => JSON.parse(readFileSync(join(config, name), "utf8"));
  return {
    config,
    json,
    run: (...args) => execFileSync("node", [ENGINE, ...args], { encoding: "utf8", env }),
    spawn: (...args) => spawnSync("node", [ENGINE, ...args], { encoding: "utf8", env }),
  };
}

test("install adds the plugin folder beside Herdr's, and uninstall takes out only Revive's", POSIX_HARNESS, () => {
  const h = home({ cli: '{ "plugins": ["./herdr-opencode"] }\n', tui: '{ "plugin": ["./herdr-tui-session.js"] }\n' });
  assert.equal(JSON.parse(h.run("doctor")).opencode, false);
  assert.match(h.run("install", "--no-shell"), /herdr-revive[\s\S]*OpenCode loads the plugin the next time it starts/);
  const stub = readFileSync(join(h.config, "herdr-revive", "tui.js"), "utf8");
  assert.match(stub, /herdr-revive: opencode plugin/);
  assert.ok(stub.includes(pathToFileURL(resolve("mods/revive/opencode/revive.js")).href));
  assert.deepEqual(h.json("cli.json").plugins, ["./herdr-opencode", "./herdr-revive"]);
  assert.deepEqual(h.json("tui.jsonc").plugin, ["./herdr-tui-session.js", "./herdr-revive/tui.js"]);
  assert.equal(JSON.parse(h.run("doctor")).opencode, true);
  assert.match(h.run("install", "--no-shell"), /Nothing to change/);
  h.run("uninstall", "--no-shell");
  assert.ok(!existsSync(join(h.config, "herdr-revive")));
  assert.deepEqual(h.json("cli.json").plugins, ["./herdr-opencode"]);
  assert.deepEqual(h.json("tui.jsonc").plugin, ["./herdr-tui-session.js"]);
});

test("install makes cli.json when there is none, leaves a tui.jsonc with comments alone, and skips --no-opencode", POSIX_HARNESS, () => {
  const withComments = '// mine\n{ "plugin": [] }\n';
  const h = home({ tui: withComments });
  h.run("install", "--no-shell", "--no-opencode");
  assert.ok(!existsSync(join(h.config, "herdr-revive")));
  h.run("install", "--no-shell");
  assert.deepEqual(h.json("cli.json"), { plugins: ["./herdr-revive"] });
  assert.equal(readFileSync(join(h.config, "tui.jsonc"), "utf8"), withComments);
});

test("a herdr-revive folder of someone else's is left alone", POSIX_HARNESS, () => {
  const h = home();
  mkdirSync(join(h.config, "herdr-revive"));
  writeFileSync(join(h.config, "herdr-revive", "tui.js"), "export default {};\n");
  const r = h.spawn("install", "--no-shell");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /not Revive's OpenCode plugin/);
  assert.equal(readFileSync(join(h.config, "herdr-revive", "tui.js"), "utf8"), "export default {};\n");
  assert.ok(!existsSync(join(h.config, "cli.json")) || !readFileSync(join(h.config, "cli.json"), "utf8").includes("herdr-revive"));
});
