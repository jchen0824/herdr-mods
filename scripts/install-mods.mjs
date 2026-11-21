// Copies this repository's mods into a Herdr app home, under their repository names:
// <folder>/mods/<name>/ to ~/.config/herdr-app/mods/<name>/. Only files git tracks are copied.
//
//   node scripts/install-mods.mjs [--dry] [--mod <name>[,<name>…]] [--to <mods folder>]
//
// - Mods that are already the same are left alone; the others are backed up to
//   ~/herdr-mods-backup-<time>-<random>/<name>/ before they change, then checked with `herdr-app check`.
// - A mod's settings the person keeps in the installed copy (KEEP, such as Sessions'
//   config.json) are never overwritten once they exist there.
// - Nothing is deleted: files only the installed copy has are listed, not removed.
// - Installers that edit other programs' config (revive.mjs install, Sessions' install.py) are
//   not run, and layouts, keys.json and settings.json aren't touched. Every mod here has
//   "place": "none", so a newly installed one shows only where a layout names it.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const KEEP = new Set(["config.json"]);
const GENERATED = new Set(["jsconfig.json", "gpui-kit.d.ts", "herdr.d.ts"]);

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dry = args.includes("--dry");
const only = opt("--mod")?.split(",").filter(Boolean) ?? null;
const to = opt("--to") ?? join(process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"), "mods");

/** Every mod in the repository: { name, files: [path relative to the mod] , dir }. */
export function repoMods() {
  const mods = new Map();
  for (const path of execFileSync("git", ["ls-files", "*/mods/*/*"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
    const m = /^([^/]+)\/mods\/([^/]+)\/(.+)$/.exec(path);
    if (!m) continue;
    const [, folder, name, file] = m;
    if (!mods.has(name)) mods.set(name, { name, dir: `${folder}/mods/${name}`, files: [] });
    mods.get(name).files.push(file);
  }
  return [...mods.values()];
}

/** What installing `mod` into `target` would do: the files to write, kept and only installed. */
export function plan(mod, target) {
  const write = [], kept = [];
  for (const file of mod.files) {
    const dest = join(target, file);
    if (!existsSync(dest)) { write.push(file); continue; }
    if (KEEP.has(file)) { if (!readFileSync(dest).equals(readFileSync(join(mod.dir, file)))) kept.push(file); continue; }
    if (!readFileSync(dest).equals(readFileSync(join(mod.dir, file)))) write.push(file);
  }
  const tracked = new Set(mod.files);
  const extra = existsSync(target)
    ? execFileSync("find", [target, "-type", "f"], { encoding: "utf8" }).split("\n").filter(Boolean)
      .map((p) => p.slice(target.length + 1))
      .filter((f) => !tracked.has(f) && !GENERATED.has(f) && !f.endsWith(".error") && !f.split("/").some((p) => p.startsWith(".")))
    : [];
  return { write, kept, extra };
}

function main() {
  const mods = repoMods().filter((m) => !only || only.includes(m.name));
  if (only) for (const name of only) if (!mods.some((m) => m.name === name)) throw new Error(`no mod ${name} in this repository`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // One folder per run, made when the first mod needs it: a timestamp alone repeats within a second.
  let backup = null;
  const backupDir = () => (backup ??= mkdtempSync(join(homedir(), `herdr-mods-backup-${stamp}-`)));
  const changed = [];
  for (const mod of mods) {
    const target = join(to, mod.name);
    const { write, kept, extra } = plan(mod, target);
    const fresh = !existsSync(target);
    const notes = [
      ...kept.map((f) => `kept your ${f}`),
      ...(extra.length ? [`only installed: ${extra.join(", ")}`] : []),
    ];
    if (!write.length) { console.log(`  same       ${mod.name}${notes.length ? `  (${notes.join("; ")})` : ""}`); continue; }
    console.log(`  ${fresh ? "new    " : "update "}    ${mod.name}: ${write.join(", ")}${notes.length ? `  (${notes.join("; ")})` : ""}`);
    if (dry) continue;
    // The files themselves, also when the installed mod (or a file in it) is a symlink: the copy
    // below writes through a link, and a backup of the link would show the new code.
    if (!fresh) cpSync(realpathSync(target), join(backupDir(), mod.name), { recursive: true, dereference: true });
    for (const file of write) {
      mkdirSync(dirname(join(target, file)), { recursive: true });
      cpSync(join(mod.dir, file), join(target, file));
    }
    changed.push(mod.name);
  }
  if (dry) { console.log("Dry run: nothing written."); return; }
  if (!changed.length) { console.log("Every mod is up to date."); return; }
  if (backup) console.log(`Backup of the previous copies: ${backup}`);
  let failed = 0;
  for (const name of changed) {
    try {
      execFileSync("herdr-app", ["check", join(to, name)], { stdio: ["ignore", "pipe", "pipe"] });
      console.log(`  check ok   ${name}`);
    } catch (err) {
      if (err.code === "ENOENT") { console.log("herdr-app isn't on PATH: run herdr-app check on the updated mods yourself."); break; }
      failed++;
      console.log(`  check FAIL ${name}: ${String(err.stderr || err.stdout).trim().split("\n").pop()}`);
    }
  }
  if (failed) process.exit(1);
}

// Run as a script (not imported by a test): compare as file URLs, which escape spaces and the
// like, of the real path, as Node resolves the main module through symlinks.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(); } catch (err) { console.error(`install-mods: ${err.message}`); process.exit(1); }
}
