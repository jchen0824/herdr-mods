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
| `revive/` | `revive` | Resume agents lost to a reboot; dmazlum/herdr-revive plus OpenCode |

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
npm ci                          # once: test-only dependencies (fast-check, yaml)
make check                      # mod folder structure, JS syntax, QuickJS rules, unit and property tests
make test                       # unit tests only (Node's test runner, no dependencies)
make e2e                        # kube against a real, disposable cluster (CI uses kind); KUBE_E2E_CONTEXT
make herdr-check                # herdr-app check on every mod (CI installs Herdr on Linux)
make hooks                      # use .githooks: reject non-conventional commit subjects
node scripts/check-commits.mjs --message 'fix(kube): retry loading clusters'
herdr-app check ~/.config/herdr-app/mods/<name>   # Herdr's own check, on an installed copy
cd artifacts/cli && cargo test  # herdr-artifact; `just check` adds fmt and clippy, `just install` installs it
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
- `revive/`: dmazlum/herdr-revive (MIT, `licenses/dmazlum-herdr-revive-MIT.txt`) plus OpenCode; its own
  tests run from that folder (`cd revive && node --test test/*.test.js`, part of `npm test`).
  Its update check is off. `revive/UPSTREAM.json` is the upstream base; `make sync-revive`
  (`scripts/sync-revive.mjs`) three-way merges upstream since then, and the weekly
  `revive-upstream` workflow opens a `chore/revive-upstream` PR (it starts `ci.yml` itself:
  a PR opened with the workflow token doesn't). Keep the OpenCode changes when resolving.
- `sessions/test/`: runs `scan.py` (Python 3.9+, standard library only) against made-up
  agent histories in a throwaway HOME, with a fake `opencode` on PATH for delete.
- `kube/test/properties.test.mjs`: property-based tests (fast-check) for rules that must hold
  for any input: following logs never loses or repeats a line, paged reads return exactly the
  server's objects or an error, no secret value survives redaction, the YAML view reads back
  as the same object. A failure prints the smallest failing input and a seed to replay it.
- `artifacts/cli/`: `herdr-artifact`, a Rust command-line program (not a mod, and not a gallery
  entry yet). An agent publishes a file as an artifact with versions, a status and comment threads,
  kept in `~/.herdr/artifacts`; `send` types a comment into the publishing agent's terminal through
  `hc`, and only when that terminal reports an agent status. It follows herdr-core's conventions
  (edition 2024, `rustfmt.toml` width 120, clippy warnings denied, deciding code in `model.rs` apart
  from IO in `store.rs`). Its tests run the real binary against a scratch store under `/var/tmp`.
  CI's `artifact-cli` job runs `cargo fmt --check`, `cargo clippy` and `cargo test` there;
  `make check` does not.
- `scripts/check-mods.mjs` checks each folder is a complete entry, every `.js` parses,
  `??` is never mixed with `||`/`&&` without parentheses (QuickJS rejects it), and
  Herdr's generated `jsconfig.json`/`*.d.ts` are not committed.
- `scripts/check-commits.mjs` checks commit subjects; CI runs it on pull requests.
- `scripts/install-mods.mjs` (`make install [DRY=1] [MOD=a,b]`): copies the tracked files of every
  mod into `~/.config/herdr-app/mods/<name>/` under its repository name, backs up changed copies,
  never overwrites an installed `config.json`, deletes nothing, and runs `herdr-app check` on
  what changed. It doesn't run installers (`revive.mjs install`, Sessions' `install.py`).

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
