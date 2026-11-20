# Sessions

Browse saved Claude Code, Codex and Kiro conversations in Herdr. Use **Newest** for a timeline or **Folder** for alphabetized groups with newest sessions first within each group. The panel and popup share the sort preference.

## Install

1. Copy `mods/sessions` into your Herdr app's `mods/` directory and run `herdr-app check ~/.config/herdr-app/mods/sessions`.
2. Merge `keys.json` to open the popup with **⌘⇧S** on macOS. Use `ctrl-shift-s` on Linux if the shortcut is free. You can also run `herdr-app do mod.open '{"name":"sessions"}'`.
3. For a tab-bar button, also copy `mods/sessions-tabs` and check it. In a personal layout based on Herdr's main layout, change the tabs block's `content.mod` to `sessions-tabs`. Append this block to the `panel-body` stack.

   ```json
   { "id": "sessions", "type": "block", "content": { "mod": "sessions" } }
   ```

The tab-bar integration was built against Herdr 0.1.16. The scanner needs Python 3.9 or newer on each machine it scans.

## Machine exclusions

Edit the installed `mods/sessions/config.json` to skip named machines. For example, `{"excludeMachines":["build-box"]}` skips that machine for listing and prompt search. Local history stays available.

Sessions runs Python on this computer and eligible connected Herdr machines. It reads history under `~/.claude/projects`, `~/.codex`, and `~/.kiro`, and caches excerpts in `~/.cache/herdr-sessions` on each machine. It also runs local shell tools to resolve folders. Opening a session launches its agent CLI. Confirming deletion removes the selected session's files or calls the agent's deletion CLI.

Adapted from [Vinay Tiparadi's Sessions](https://github.com/vinaytiparadi/herdr-mods/tree/8ea7464/sessions) under [MIT](../licenses/vinaytiparadi-herdr-mods-MIT.txt). The optional tab bar adapts the bundled [Herdr app](https://github.com/herdrdev/herdr-app) tab bar under [Apache 2.0](../licenses/herdr-app-Apache-2.0.txt).
