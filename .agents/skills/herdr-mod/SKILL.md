---
name: herdr-mod
description: Use when changing or adding a Herdr mod in this repo: gpui-kit UI code, Herdr APIs, layouts, testing in the app.
---

# Change a mod and prove it in Herdr

Read `~/.config/herdr-app/AGENTS.md` and the type files beside it (`herdr.d.ts`,
`gpui-kit.d.ts`): they are rewritten for each Herdr version and are the truth. Then
read the mod's `RECIPE.md`, which records what it must keep doing.

Develop on the installed copy in `~/.config/herdr-app/mods/<name>/`: Herdr reloads it
on save. Copy the finished files back into `<folder>/mods/<name>/` without Herdr's
generated `jsconfig.json` and `*.d.ts`.

Rules that have broken these mods before:

- Inside a virtual list's row renderer, handlers (`on_click`, …) throw and the row
  silently doesn't draw. Use `on_item_click` on the list.
- `line_height(18)` is a multiplier; write `"18px"`. `flex_shrink` needs a value.
- `EditorState.new`, `InputState.new` and focus handles can't be made during render.
- A mod copy isn't told which pane it is, and a docked copy has none. Act on
  `focused().pane`; decide "shown" from `layout()` and the shown tab.
- `exec` gets the login shell's PATH. Tools found only by an interactive shell
  (kubectl credential plugins) need their folder added (see `kube.js`).
- A layout switch restarts mods; a read in flight can be lost. Retry first reads.
- `init()` runs for real in `herdr-app check`: guard helpers with `checking()`.
- Never keep a `cx`; animate with `.spin()`/`.loop()`, not timers.

Verify in this order: `make check`, `herdr-app check` on the installed copy,
`herdr-app status` shows no errors, then the behaviour in the app. Use
`herdr-app shot` to look at it; open panes and props with `herdr-app do`.
Say what you could not click or see.
