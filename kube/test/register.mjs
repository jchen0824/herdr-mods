// Lets Node load the mod's files: the `herdr` module only exists inside Herdr.
import { register } from "node:module";
register("./resolve.mjs", import.meta.url);
