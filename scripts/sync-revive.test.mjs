// sync-revive.mjs against a made-up upstream and a made-up copy of this repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { newestTag } from "./sync-revive.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "sync-revive.mjs");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd, ...argv) => execFileSync("git", argv, { cwd, env: ENV, encoding: "utf8" }).trim();
const write = (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};
const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const core = (edit = {}) => `${LINES.map((l, i) => edit[i + 1] ?? l).join("\n")}\n`;

/** Upstream at its base, and this repository's copy of it with a local change on line 18. */
function setup() {
  const up = mkdtempSync(join(tmpdir(), "sync-up-"));
  git(up, "init", "-q", "-b", "main");
  write(up, { "mods/revive/lib/core.js": core(), "README.md": "upstream readme\n", "LICENSE": "MIT\n", ".github/workflows/ci.yml": "x\n" });
  git(up, "add", "-A");
  git(up, "commit", "-qm", "base");
  git(up, "tag", "v0.11.0");
  const base = git(up, "rev-parse", "HEAD");

  const repo = mkdtempSync(join(tmpdir(), "sync-repo-"));
  git(repo, "init", "-q", "-b", "main");
  write(repo, {
    "revive/mods/revive/lib/core.js": core({ 18: "line 18 (opencode)" }),
    "revive/README.md": "our readme\n",
    "revive/UPSTREAM.json": `${JSON.stringify({ repo: "dmazlum/herdr-revive", base, ref: "main" })}\n`,
    "licenses/dmazlum-herdr-revive-MIT.txt": "MIT\n",
  });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "ours");
  const run = (...args) => JSON.parse(execFileSync("node", [SCRIPT, "--from", up, "--json", ...args], { cwd: repo, env: ENV, encoding: "utf8" }));
  return { up, repo, base, run };
}

test("newestTag picks the highest version tag", () => {
  assert.equal(newestTag(["v0.9.1", "v0.11.0", "v0.10.2", "nightly", ""]), "v0.11.0");
  assert.equal(newestTag(["latest"]), null);
});

test("nothing newer than the base: up to date, nothing changed", () => {
  const { repo, run } = setup();
  assert.equal(run().upToDate, true);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("a new release merges beside this copy's own changes, and leaves README and .github out", () => {
  const { up, repo, run } = setup();
  write(up, { "mods/revive/lib/core.js": core({ 3: "line 3 (upstream fix)" }), "mods/revive/new.js": "new\n", "README.md": "new upstream readme\n", ".github/workflows/ci.yml": "y\n", "LICENSE": "MIT 2027\n" });
  git(up, "add", "-A");
  git(up, "commit", "-qm", "fix: line 3");
  git(up, "tag", "v0.12.0");
  const target = git(up, "rev-parse", "HEAD");

  const out = run();
  assert.equal(out.upToDate, false);
  assert.equal(out.ref, "v0.12.0");
  assert.deepEqual(out.conflicts, []);
  assert.equal(out.commits.length, 1);
  assert.match(out.commits[0], /fix: line 3/);
  assert.equal(readFileSync(join(repo, "revive/mods/revive/lib/core.js"), "utf8"), core({ 3: "line 3 (upstream fix)", 18: "line 18 (opencode)" }));
  assert.equal(readFileSync(join(repo, "revive/mods/revive/new.js"), "utf8"), "new\n");
  assert.equal(readFileSync(join(repo, "revive/README.md"), "utf8"), "our readme\n");
  assert.ok(!existsSync(join(repo, "revive/.github")));
  assert.equal(readFileSync(join(repo, "licenses/dmazlum-herdr-revive-MIT.txt"), "utf8"), "MIT 2027\n");
  assert.equal(out.licenseChanged, true);
  assert.equal(JSON.parse(readFileSync(join(repo, "revive/UPSTREAM.json"), "utf8")).base, target);
});

test("upstream changing the same lines as this copy is reported as a conflict", () => {
  const { up, repo, run } = setup();
  write(up, { "mods/revive/lib/core.js": core({ 18: "line 18 (upstream)" }) });
  git(up, "commit", "-qam", "change line 18");
  const out = run("--ref", "main");
  assert.deepEqual(out.conflicts, ["revive/mods/revive/lib/core.js"]);
  assert.match(readFileSync(join(repo, "revive/mods/revive/lib/core.js"), "utf8"), /<<<<<<<[\s\S]*line 18 \(opencode\)[\s\S]*line 18 \(upstream\)[\s\S]*>>>>>>>/);
});

test("a dirty working tree is refused", () => {
  const { repo } = setup();
  writeFileSync(join(repo, "stray.txt"), "x\n");
  assert.throws(() => execFileSync("node", [SCRIPT, "--json"], { cwd: repo, env: ENV, stdio: "pipe" }), /working tree has changes/);
});

test("a patch git can't apply (upstream deleted a file this copy changed) fails and keeps the base", () => {
  const { up, repo, base, run } = setup();
  git(up, "rm", "-q", "mods/revive/lib/core.js");
  write(up, { "mods/revive/other.js": "x\n" });
  git(up, "add", "-A");
  git(up, "commit", "-qm", "drop core.js");
  assert.throws(() => run("--ref", "main"), /don't apply[\s\S]*core\.js/);
  assert.equal(git(repo, "status", "--porcelain"), "", "the tree is put back");
  assert.equal(JSON.parse(readFileSync(join(repo, "revive/UPSTREAM.json"), "utf8")).base, base);
});

test("--ref takes an upstream branch other than the default one", () => {
  const { up, repo, run } = setup();
  git(up, "switch", "-q", "-c", "feature");
  write(up, { "mods/revive/feature.js": "f\n" });
  git(up, "add", "-A");
  git(up, "commit", "-qm", "feature work");
  git(up, "switch", "-q", "main");
  assert.throws(() => run("--ref", "no-such-thing"), /no tag, branch or commit no-such-thing/);
  const out = run("--ref", "feature");
  assert.deepEqual(out.conflicts, []);
  assert.equal(readFileSync(join(repo, "revive/mods/revive/feature.js"), "utf8"), "f\n");
});
