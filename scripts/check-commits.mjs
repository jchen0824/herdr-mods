// Validates Conventional Commit subjects: a message, a commit-msg file, or a pull request's
// title and non-merge commits (from the GitHub event). Subjects are never put into a shell.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z][a-z0-9-]*\))?!?: [a-z0-9][^\n]*[^.\s]$/;
export const valid = (subject) => subject.length <= 72 && PATTERN.test(subject);

function subjects(argv) {
  const [flag, value] = argv;
  if (flag === "--message") return [value];
  if (flag === "--file") {
    // A commit-msg hook's file: the first line that isn't a comment.
    const first = readFileSync(value, "utf8").split("\n").find((l) => l.trim() && !l.startsWith("#"));
    return [first ?? ""];
  }
  if (flag === "--event") {
    const pr = JSON.parse(readFileSync(value, "utf8")).pull_request;
    const { sha: base } = pr.base, { sha: head } = pr.head;
    if (![base, head].every((s) => /^[0-9a-f]{40}$/.test(s))) throw new Error("Invalid GitHub commit SHA");
    const log = execFileSync("git", ["log", "--no-merges", "--format=%s", `${base}..${head}`], { encoding: "utf8" });
    return [pr.title, ...log.split("\n").filter(Boolean)];
  }
  throw new Error("usage: check-commits.mjs --message <subject> | --file <path> | --event <path>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bad = subjects(process.argv.slice(2)).filter((s) => !valid(s));
  for (const s of bad) console.log(`Invalid subject: ${JSON.stringify(s)}`);
  if (bad.length) {
    console.error("Use type(scope): lower-case summary, <=72 characters, no final period");
    process.exit(1);
  }
  console.log("Conventional commit subjects passed");
}
