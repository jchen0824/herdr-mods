// `herdr` for end-to-end tests: exec runs the real program, with Herdr's 8 MiB output cap.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { underCap } from "../cap.mjs";

export const calls = [];
export function exec(cmd, args, { timeout = 30000 } = {}) {
  calls.push([cmd, ...args]);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e && typeof e.code !== "number") return reject(e);
      try { resolve(underCap({ code: e ? e.code : 0, stdout, stderr }, [cmd, ...args].join(" ").slice(0, 120))); }
      catch (err) { reject(err); }
    });
  });
}
export const home = () => homedir();
export const checking = () => false;
import { readFile } from "node:fs/promises";
export const readTextFile = (path) => readFile(path, "utf8");
