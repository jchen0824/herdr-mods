// Herdr's exec returns at most 8 MiB of output per call (herdr.d.ts). Both test stand-ins for
// `herdr` fail a call that goes over it, so a read that would be cut off in Herdr fails here.
export const EXEC_CAP = 8 * 1024 * 1024;
export function underCap(result, what) {
  const size = Buffer.byteLength(result.stdout ?? "");
  if (size > EXEC_CAP) throw new Error(`${what}: ${size} bytes of output, over Herdr's 8 MiB exec cap`);
  return result;
}
