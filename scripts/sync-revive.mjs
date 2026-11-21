// Brings upstream herdr-revive's changes into revive/: the diff from the base recorded in
// revive/UPSTREAM.json to the target (the newest release by default), applied with a three-way
// merge, so this repo's own changes (OpenCode, the control-character check, the update check
// off) stay. Upstream's README, LICENSE, .github and .gitignore are not applied: revive/ has its
// own README, and the license is copied to licenses/ when it changes.
//
//   node scripts/sync-revive.mjs [--ref <tag|branch|sha>] [--from <repository>] [--json]
//
// --from clones another copy of upstream (a path, for tests) instead of github.com/<repo>.
//
// Prints what it did; with --json, one JSON object: { upToDate, base, target, ref, commits,
// conflicts, licenseChanged }. Exits 0 even with conflicts (the files keep conflict markers and
// are listed); 1 on errors. Run it from the repository root on a clean tree.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = "revive/UPSTREAM.json";
const LICENSE = "licenses/dmazlum-herdr-revive-MIT.txt";
const SKIP = [".github", ".gitignore", "README.md", "LICENSE"];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const asJson = args.includes("--json");

const git = (argv, opts = {}) => execFileSync("git", argv, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
const tryGit = (argv, opts) => { try { git(argv, opts); return true; } catch { return false; } };

/** The highest vX.Y.Z tag, or null. */
export function newestTag(tags) {
  const parse = (t) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(t)?.slice(1).map(Number);
  return tags.filter(parse).sort((a, b) => {
    const [x, y] = [parse(a), parse(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).at(-1) ?? null;
}

function main() {
  if (git(["status", "--porcelain"]).trim()) throw new Error("the working tree has changes; commit or stash them first");
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const tmp = mkdtempSync(join(tmpdir(), "revive-upstream-"));
  try {
    git(["clone", "--quiet", "--no-checkout", opt("--from") ?? `https://github.com/${state.repo}.git`, tmp]);
    const up = (argv) => git(["-C", tmp, ...argv]).trim();
    const ref = opt("--ref") ?? newestTag(up(["tag", "--list"]).split("\n")) ?? "origin/HEAD";
    // A tag, a commit, or a branch: only the default branch is checked out, others are origin/<name>.
    const resolve = (name) => { try { return up(["rev-parse", "--verify", "--quiet", `${name}^{commit}`]); } catch { return ""; } };
    const target = resolve(ref) || resolve(`origin/${ref}`);
    if (!target) throw new Error(`no tag, branch or commit ${ref} upstream`);
    const out = { upToDate: false, base: state.base, target, ref, commits: [], conflicts: [], licenseChanged: false };

    // Already in: the target is the base or one of its ancestors.
    if (tryGit(["-C", tmp, "merge-base", "--is-ancestor", target, state.base])) {
      out.upToDate = true;
      return out;
    }
    if (!tryGit(["-C", tmp, "merge-base", "--is-ancestor", state.base, target])) {
      throw new Error(`${ref} (${target.slice(0, 7)}) doesn't descend from the recorded base ${state.base.slice(0, 7)}`);
    }
    out.commits = up(["log", "--no-merges", "--format=%h %s", `${state.base}..${target}`]).split("\n").filter(Boolean);

    const diff = git(["-C", tmp, "diff", "--binary", state.base, target, "--", ".", ...SKIP.map((p) => `:(exclude)${p}`)]);
    if (diff.trim()) {
      // The three-way merge needs upstream's blobs: fetch them into this repository's object store.
      up(["update-ref", "refs/sync/target", target]);
      up(["update-ref", "refs/sync/base", state.base]);
      git(["fetch", "--quiet", "--no-tags", tmp, "refs/sync/target:refs/sync/revive-target", "refs/sync/base:refs/sync/revive-base"]);
      git(["update-ref", "-d", "refs/sync/revive-target"]);
      git(["update-ref", "-d", "refs/sync/revive-base"]);
      // A conflict leaves markers and unmerged paths; a patch git can't apply at all (upstream
      // deleted a file this copy changed, say) says "error:" and applies nothing. That must not
      // pass for a clean sync: put the tree back, keep the base, and fail.
      try { git(["apply", "--3way", "--whitespace=nowarn", "--directory=revive"], { input: diff, stdio: ["pipe", "pipe", "pipe"] }); }
      catch (err) {
        const errors = String(err.stderr ?? "").split("\n").filter((l) => l.startsWith("error:"));
        if (errors.length) {
          git(["reset", "--hard", "--quiet"]);
          git(["clean", "-fdq"]);
          throw new Error(`upstream's changes don't apply; merge them by hand (base stays ${state.base.slice(0, 7)}):\n${errors.join("\n")}`);
        }
      }
      out.conflicts = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
    }

    const license = up(["show", `${target}:LICENSE`]);
    if (license !== readFileSync(LICENSE, "utf8").trim()) {
      writeFileSync(LICENSE, `${license}\n`);
      out.licenseChanged = true;
    }

    writeFileSync(STATE, `${JSON.stringify({ ...state, base: target, ref }, null, 2)}\n`);
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const out = main();
    if (asJson) process.stdout.write(`${JSON.stringify(out)}\n`);
    else if (out.upToDate) console.log(`revive/ is up to date with ${out.ref} (${out.target.slice(0, 7)}).`);
    else {
      console.log(`Applied upstream ${out.base.slice(0, 7)}..${out.target.slice(0, 7)} (${out.ref}), ${out.commits.length} commit(s):`);
      for (const c of out.commits) console.log(`  ${c}`);
      if (out.licenseChanged) console.log(`Updated ${LICENSE}.`);
      if (out.conflicts.length) console.log(`Conflicts to resolve:\n${out.conflicts.map((f) => `  ${f}`).join("\n")}`);
      else console.log("No conflicts. Run make check, then commit.");
    }
  } catch (err) {
    console.error(`sync-revive: ${err.message}`);
    process.exit(1);
  }
}
