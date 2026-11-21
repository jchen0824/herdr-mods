// install-mods.mjs into a throwaway mods folder and home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = () => mkdtempSync(join(tmpdir(), "install-home-"));
const NODE_PATH = process.execPath.replace(/\/node$/, "");
const runNode = (h, to, ...args) => execFileSync(process.execPath, ["scripts/install-mods.mjs", "--to", to, ...args], {
  encoding: "utf8",
  env: { ...process.env, HOME: h, PATH: `${NODE_PATH}:/usr/bin:/bin` },
});

test("a fresh install writes each mod's tracked files under its repository name", () => {
  const h = home(), to = join(h, "mods");
  const out = runNode(h, to, "--mod", "topbar-actions,sessions");
  assert.match(out, /new {8}topbar-actions/);
  assert.match(out, /new {8}sessions:/);
  assert.equal(readFileSync(join(to, "sessions", "scan.py"), "utf8"), readFileSync("sessions/mods/sessions/scan.py", "utf8"));
  assert.ok(existsSync(join(to, "sessions", "config.json")));
  assert.ok(!existsSync(join(to, "kube")), "--mod installs only those");
  assert.match(runNode(h, to, "--mod", "topbar-actions,sessions"), /Every mod is up to date/);
});

test("an update backs up the old copy, keeps the person's config.json and lists files only installed", () => {
  const h = home(), to = join(h, "mods");
  runNode(h, to, "--mod", "sessions");
  writeFileSync(join(to, "sessions", "config.json"), '{ "excludeMachines": ["mini"] }\n');
  writeFileSync(join(to, "sessions", "main.js"), "// old\n");
  writeFileSync(join(to, "sessions", "install.py"), "# mine\n");
  writeFileSync(join(to, "sessions", "jsconfig.json"), "{}\n");
  const out = runNode(h, to, "--mod", "sessions");
  assert.match(out, /update {5}sessions: main\.js {2}\(kept your config\.json; only installed: install\.py\)/);
  assert.equal(readFileSync(join(to, "sessions", "main.js"), "utf8"), readFileSync("sessions/mods/sessions/main.js", "utf8"));
  assert.equal(readFileSync(join(to, "sessions", "config.json"), "utf8"), '{ "excludeMachines": ["mini"] }\n');
  assert.equal(readFileSync(join(to, "sessions", "install.py"), "utf8"), "# mine\n", "nothing is deleted");
  const [backup] = readdirSync(h).filter((d) => d.startsWith("herdr-mods-backup-"));
  assert.equal(readFileSync(join(h, backup, "sessions", "main.js"), "utf8"), "// old\n");
  assert.match(out, /herdr-app isn't on PATH/);
});

test("a dry run writes nothing, and an unknown mod is an error", () => {
  const h = home(), to = join(h, "mods");
  mkdirSync(to);
  assert.match(runNode(h, to, "--dry", "--mod", "kube"), /new {8}kube[\s\S]*Dry run: nothing written/);
  assert.deepEqual(readdirSync(to), []);
  assert.throws(() => runNode(h, to, "--mod", "nope"), /no mod nope in this repository/);
});

test("it runs from a folder whose path has a space", () => {
  const h = home(), dir = join(h, "my scripts");
  mkdirSync(dir);
  copyFileSync("scripts/install-mods.mjs", join(dir, "install-mods.mjs"));
  const out = execFileSync(process.execPath, [join(dir, "install-mods.mjs"), "--to", join(h, "mods"), "--dry", "--mod", "kube"], { encoding: "utf8", env: { ...process.env, HOME: h } });
  assert.match(out, /new {8}kube[\s\S]*Dry run/);
});

test("a symlinked installed mod is backed up as its files, before they change", () => {
  const h = home(), to = join(h, "mods"), real = join(h, "elsewhere", "topbar-actions");
  runNode(h, join(h, "elsewhere"), "--mod", "topbar-actions");
  writeFileSync(join(real, "main.js"), "// my custom code\n");
  mkdirSync(to);
  symlinkSync(real, join(to, "topbar-actions"));
  runNode(h, to, "--mod", "topbar-actions");
  const [backup] = readdirSync(h).filter((d) => d.startsWith("herdr-mods-backup-"));
  assert.equal(readFileSync(join(h, backup, "topbar-actions", "main.js"), "utf8"), "// my custom code\n");
  assert.equal(readFileSync(join(real, "main.js"), "utf8"), readFileSync("topbar-actions/mods/topbar-actions/main.js", "utf8"));
});
