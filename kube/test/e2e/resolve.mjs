export async function resolve(specifier, context, next) {
  if (specifier === "herdr") return { url: new URL("./herdr-real.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
