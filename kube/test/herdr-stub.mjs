// The few `herdr` calls kube.js makes, for tests. exec answers with what a test queues, or
// with a test's handler; either way it enforces Herdr's 8 MiB output cap.
import { underCap } from "./cap.mjs";

export const calls = [];
export const replies = [];
let handler = null;
export const setHandler = (h) => { handler = h; };
export async function exec(cmd, args) {
  calls.push([cmd, ...args]);
  const r = handler ? await handler(cmd, args) : replies.shift() ?? { code: 0, stdout: "", stderr: "" };
  return underCap(r, [cmd, ...args].join(" ").slice(0, 120));
}
export const home = () => "/home/test";
export const checking = () => false;
// readTextFile serves what a test puts in `files` (path -> text); anything else is missing.
export const files = {};
export async function readTextFile(path) {
  if (!(path in files)) throw new Error(`no such file: ${path}`);
  return files[path];
}
