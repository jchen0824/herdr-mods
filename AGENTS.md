# Working on herdr-mods

This is the shared guide for people and coding agents. `CLAUDE.md` imports it;
`.claude/skills` links to `.agents/skills`.

## Purpose and current scope

Mods for the [Herdr](https://herdr.dev) desktop app, published to the
[herdr.dev/mods](https://herdr.dev/gallery/?type=mods) gallery through the repo's
`herdr-mod` topic. Each top-level folder is one gallery entry:

| Folder | Mod | What it is |
| --- | --- | --- |
| `kube/` | `kube` | OpenLens-style Kubernetes panel and log viewer |
| `topbar-actions/` | `topbar-actions` | Review and Kubernetes buttons in the tab bar |

A mod runs inside Herdr (gpui-kit JavaScript on QuickJS), not Node. Its API is
Herdr's: read `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`
on a machine with Herdr installed before changing mod code.

## Workflow

Work on a branch from `main`, keep changes focused, and read the relevant skill.
Run `make check`. Try every UI change in the running app, not only the checks.
Use Conventional Commits (`make hooks` enforces them locally) and the
[PR template](.github/pull_request_template.md). Publishing, gallery topics,
releases and repository administration require the user's instruction;
implementing a feature does not imply them.

## Commands

```sh
make check                      # mod folder structure, JS syntax, QuickJS rules, unit tests
make test                       # unit tests only (Node's test runner, no dependencies)
make e2e                        # kube against a real, disposable cluster (CI uses kind); KUBE_E2E_CONTEXT
make herdr-check                # herdr-app check on every mod (CI installs Herdr on Linux)
make hooks                      # use .githooks: reject non-conventional commit subjects
node scripts/check-commits.mjs --message 'fix(kube): retry loading clusters'
herdr-app check ~/.config/herdr-app/mods/<name>   # Herdr's own check, on an installed copy
```

## Skills

| Area | Read first |
| --- | --- |
| Changing or adding a mod: Herdr APIs, rendering rules, testing in the app | [.agents/skills/herdr-mod/SKILL.md](.agents/skills/herdr-mod/SKILL.md) |
| Previews, RECIPE.md, privacy, gallery listing | [.agents/skills/gallery-release/SKILL.md](.agents/skills/gallery-release/SKILL.md) |

## Layout and enforced rules

- `<folder>/mods/<name>/`: the files a user copies into `~/.config/herdr-app/mods/`.
  `main.js` default-exports a `View`; `mod.json` says where it first appears.
- `<folder>/README.md` (people), `RECIPE.md` (the brief another agent rebuilds the mod
  from, in Herdr's section order) and `preview.png` (the gallery picture).
- `<folder>/keys.json`: optional bindings a user merges into theirs.
- `kube/test/`: Node tests for the parts without UI (`kube.js`, `logs.js`); `herdr-stub.mjs`
  stands in for the `herdr` module and enforces Herdr's 8 MiB exec output cap (`cap.mjs`).
  `kube/test/e2e/` runs the same code with the real kubectl against a disposable cluster
  (kind in CI's `e2e` job); it creates and deletes the `herdr-kube-e2e` namespace. CI also
  installs Herdr on Linux and runs `herdr-app check` on every mod; the rest of the UI is
  verified in the app.
- `scripts/check-mods.mjs` checks each folder is a complete entry, every `.js` parses,
  `??` is never mixed with `||`/`&&` without parentheses (QuickJS rejects it), and
  Herdr's generated `jsconfig.json`/`*.d.ts` are not committed.
- `scripts/check-commits.mjs` checks commit subjects; CI runs it on pull requests.

## Evidence and known limitations

`herdr-app check` renders only a mod's first frame: it does not run virtual-list rows,
later async states, or panes opened with props (the kube log viewer). Those need the app.
Nothing here is tested against Windows. `kube` is read-mostly by its own guard (restart
and scale behind a confirmation, no delete); that is not a security boundary.

Previews and fixtures use made-up names only (`kube`'s demo mode). Never commit real
cluster, project, namespace or customer names, credentials, or kubeconfig content.

A finished change reports what changed, the checks and their results, what was tried
in the app, and what remains unverified. Changes to user-visible behaviour update the
mod's README and RECIPE.md in the same commit.
