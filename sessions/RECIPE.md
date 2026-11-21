# Sessions

Search and reopen saved Claude Code, Codex, Kiro and OpenCode sessions from a side panel or popup. Sort by recency or group by folder.

![Sessions preview with sample data](preview.png)

## What you see

- A Sessions heading with **Newest** and **Folder** options, agent filters and refresh.
- A search box and scope chips for the current repository, current machine and all scanned machines.
- In Folder view, headings show the folder name and path. The All scope adds the remote machine name when applicable.
- Session rows have a title, agent icon, model, prompt count and age when available. Hover for the delete control.
- The optional tabs mod adds a 26px Sessions button. The shortcut opens a 460 × 600 popup.

## How it behaves

Newest shows one timeline. Folder groups by machine and full path, puts the most recently active folder first (folders with no path last; ties by folder name, then path, then machine), and keeps the newest session first in each group. The sort choice is shared between the panel and popup. It applies to every scope and to search matches.

Click a row to resume its session. Shift-click forks where the agent supports it (Claude Code, Codex; Kiro and OpenCode resume). OpenCode resumes with `opencode --session <id>` and deletes with `opencode session delete <id>`. Delete asks before permanently removing history. Refresh reloads data from this computer and connected non-temporary machines except names in `excludeMachines`.

## Built from

`mods/sessions/main.js` uses Herdr `shared` state for sort and runs the bundled `scan.py` via `exec` on each eligible machine. The scanner uses Python 3.9 or newer and reads Claude Code, Codex and Kiro history, and OpenCode's SQLite database (`$XDG_DATA_HOME/opencode/opencode*.db`, default `~/.local/share/opencode`), read-only: `session_v2` and `session_message` (2.x) or `session`, `message` and `part` (1.x). Sub-agent and archived OpenCode sessions, and ones with no prompts, are left out. It stores an incremental index and prompt excerpts under `~/.cache/herdr-sessions`. The shipped `config.json` starts with an empty exclusion list. The optional `sessions-tabs` block opens `sessions` in the layout's `panel-body` stack.

## Watch out

Display full paths to distinguish equal folder names. Keep group headers outside the session selection indexes so Up, Down and Enter target sessions. The list loads 50 rows at a time. OpenCode's database also holds credentials: read only its session and message tables. It has no per-file tail, so each scan reads its user messages again (a few ms for hundreds of sessions); a session's search text is rewritten only when its `time_updated` changes. Open-session detection depends on a session ID in a live terminal's arguments. Machine exclusions apply on the next refresh or reload.

## Done when

- Both mods pass `herdr-app check`. The popup opens with the configured shortcut.
- Folder shows grouping, the folder with the latest session first, and newest-first sessions within each group.
- OpenCode sessions on this machine are listed with title, model and prompt count, and a word from a later prompt finds them. Newest restores the timeline.
- Changing scope or search preserves the selected order. A configured excluded machine supplies no rows and reports no scan error.
