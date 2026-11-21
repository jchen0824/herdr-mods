// herdr-revive: opencode plugin. OpenCode has no hooks file, so this TUI plugin runs Revive's
// engine the way Claude Code's SessionStart and SessionEnd hooks do, with the same payload.
// `revive.mjs install` puts a folder that loads it in OpenCode's config folder (herdr-revive/tui.js)
// and names that folder in cli.json (OpenCode 2.x) and tui.jsonc (1.x).
//
// A TUI plugin, not a server one: OpenCode 2.x runs its server plugins in a background service,
// outside the terminal, where HC_TERMINAL_ID isn't set. The TUI runs in the terminal itself.
//
// The session on record is the one the TUI shows, or the top of its family while it shows a
// sub-agent's session. Switching sessions records the new one, as /resume does in Claude Code.
// When the TUI quits it sends SessionEnd with reason "exit": OpenCode can't tell /exit from a
// signal, so the engine settles it (forgets the session only if the shell outlives OpenCode),
// as it does for Copilot CLI. A crash or kill -9 sends nothing and keeps the record.
//
// Dependency-free: OpenCode 2.x calls `setup(api)` (api.ui.router, api.data.session) and 1.x
// calls `tui(api)` (api.route, api.state.session), like Herdr's own OpenCode plugin.

import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The engine is in the mod folder above this file; OpenCode loads this file through a stub.
const ENGINE = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "revive.mjs");
const POLL_MS = 500;
// Both entry points may be loaded (a 2.x that also reads tui.jsonc): only the first one runs.
const RUNNING = Symbol.for("herdr-revive.opencode");

/** Runs `revive.mjs hook --agent opencode` with the payload on stdin; never fails. */
function hook(payload, { wait = false } = {}) {
  const args = [ENGINE, "hook", "--agent", "opencode"];
  const input = JSON.stringify(payload);
  try {
    // At the end, OpenCode exits right after: wait for the engine, which starts its own settle process.
    if (wait) return void spawnSync("node", args, { input, stdio: ["pipe", "ignore", "ignore"], timeout: 5_000 });
    const child = spawn("node", args, { stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill(), 10_000);
    timer.unref?.();
    child.on("error", () => clearTimeout(timer));
    child.on("close", () => clearTimeout(timer));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  } catch { /* a hook never fails the agent */ }
}

/**
 * Tracks the session the TUI shows. `route()` is its route's session id or null; `get(id)` the
 * session's info ({ id, parentID, directory }) when known. Returns the cleanup.
 */
export function track({ route, get, cwd = () => process.cwd(), send = hook, every = POLL_MS }) {
  let recorded = null;
  let directory = null;

  // The top of the family, or null while a session on the way up isn't known yet.
  const top = (id) => {
    const seen = new Set();
    while (typeof id === "string" && id && !seen.has(id)) {
      seen.add(id);
      const info = get(id);
      if (!info) return null;
      if (!info.parentID) return id;
      id = info.parentID;
    }
    return null;
  };

  const sync = () => {
    let id = null;
    try { id = top(route()); } catch { return; }
    if (!id || id === recorded) return;
    recorded = id;
    directory = get(id)?.directory || cwd();
    send({ hook_event_name: "SessionStart", source: "startup", session_id: id, cwd: directory });
  };

  sync();
  const timer = setInterval(sync, every);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (recorded) send({ hook_event_name: "SessionEnd", reason: "exit", session_id: recorded, cwd: directory }, { wait: true });
    recorded = null;
  };
}

const inTerminal = () => Boolean(process.env.HC_TERMINAL_ID) && !globalThis[RUNNING];

// OpenCode 2.x.
function setup(api) {
  if (!inTerminal()) return;
  globalThis[RUNNING] = true;
  const stop = track({
    route: () => {
      const r = api.ui.router.current();
      return r?.type === "session" ? r.sessionID : null;
    },
    get: (id) => api.data.session.get(id),
  });
  return () => { stop(); globalThis[RUNNING] = false; };
}

// OpenCode 1.x.
function tui(api) {
  if (!inTerminal()) return;
  globalThis[RUNNING] = true;
  const stop = track({
    route: () => {
      const r = api.route.current;
      return r?.name === "session" ? r.params?.sessionID : null;
    },
    get: (id) => api.state.session.get(id),
  });
  api.lifecycle.onDispose(() => { stop(); globalThis[RUNNING] = false; });
}

export default { id: "herdr-revive", setup, tui };
