// `herdr` resolves to the real-exec stand-in for end-to-end tests.
import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
