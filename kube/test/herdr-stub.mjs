// The few `herdr` calls kube.js makes, for tests. exec answers with what a test queues.
export const calls = [];
export const replies = [];
export async function exec(cmd, args) {
  calls.push([cmd, ...args]);
  return replies.shift() ?? { code: 0, stdout: "", stderr: "" };
}
export const home = () => "/home/test";
export const checking = () => false;
