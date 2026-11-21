# Revive

Brings back the coding agent a Herdr terminal lost to a reboot or a herdr-core restart, in the same pane, with the same session and flags, and forks a live session beside it. Works with Claude Code, Codex, pi, oh-my-pi, Factory Droid, the Cursor CLI, GitHub Copilot CLI and, in this copy, **OpenCode**.

![Revive](preview.png)

## Upstream

This is [herdr-revive](https://github.com/dmazlum/herdr-revive) by Devrim Mazlum, MIT ([license](../licenses/dmazlum-herdr-revive-MIT.txt)), at upstream commit `d61441d` (0.11.0 plus one later fix). This copy adds:

- **OpenCode.** A TUI plugin (`mods/revive/opencode/revive.js`) records the session the TUI shows, and Revive resumes it with `opencode --session <id>`. `revive.mjs install` puts it in `~/.config/opencode/herdr-revive/` and names it in `cli.json` (and `tui.jsonc` for OpenCode 1.x). It has no fork. `--auto` is left out of automatic resumes.
- **Flag values with control characters are refused**, so a label can't carry escapes into the text a manual Resume pastes.
- **The update check is off**: an upstream release would replace this copy, OpenCode and all.

## Keeping up with upstream

`revive/UPSTREAM.json` records the upstream commit this copy is based on. `make sync-revive` (or `node scripts/sync-revive.mjs [--ref <tag>]`) applies upstream's changes since then with a three-way merge, keeping this copy's own, and lists any conflicts. When git can't apply upstream's changes at all (upstream deleted a file this copy changed, say), it changes nothing, keeps the base and fails: merge those by hand. Upstream's README, LICENSE and `.github` aren't applied; the license is copied to `licenses/` when it changes.

Every Monday the *Revive upstream* workflow does this for upstream's newest release and opens (or updates) a pull request on `chore/revive-upstream`: a draft when there are conflicts or `make check` fails. Run it by hand from the Actions tab, with any upstream ref.

## Install

Follow *Installing it* in [RECIPE.md](RECIPE.md): copy `mods/revive` to `~/.config/herdr-app/mods/`, check it, merge `keys.json` (`cmd-shift-r`), then run `node ~/.config/herdr-app/mods/revive/revive.mjs install`.

Revive runs `node` and `hc` on this machine, reads the agents' session files, and writes its hooks into their config files and your shell rc file (backed up once as `<file>.revive-backup`). With the update check off, it reaches no network.

## Tests

`cd revive && node --test test/*.test.js` (part of `make check`). `test/opencode.test.js` covers this copy's OpenCode support.
