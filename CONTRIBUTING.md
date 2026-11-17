# Contributing

People and coding agents use the same commands and review process. Read
[AGENTS.md](AGENTS.md) and the skill for your change.

## Setup and verification

Install Node 20 or newer, and [Herdr](https://herdr.dev) to try mods. Run
`make hooks` once, then `make check` before every commit. It needs no
dependencies, cluster or Herdr install.

To try a mod, copy `<folder>/mods/<name>` into `~/.config/herdr-app/mods/`, run
`herdr-app check ~/.config/herdr-app/mods/<name>`, and use it in the app.
`kube` works without a cluster:

```sh
herdr-app do tab.new --name Demo --mod kube --props '{"demo":true}'
```

## End-to-end tests

`make e2e` runs the kube data layer with the real `kubectl` against a cluster, through a
stand-in that enforces Herdr's 8 MiB output cap. Use only a disposable cluster: it creates
more than 8 MiB of ConfigMaps in a `herdr-kube-e2e` namespace and deletes it afterwards.

```sh
kind create cluster
make e2e                      # KUBE_E2E_CONTEXT defaults to kind-kind
kind delete cluster
```

CI's `e2e` job does the same on every pull request and push to `main`.

## Pull requests

Create a branch such as `feat/kube-proxy` or `fix/topbar-gap`. Keep each PR focused.
Add tests for changed logic, update the mod's README and RECIPE.md, and fill in the
[PR template](.github/pull_request_template.md) with what you checked in the app.

Use Conventional Commits: `type(scope): lower-case summary`, at most 72 characters,
with no trailing period. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`. Scopes are the mod names (`kube`,
`topbar-actions`) or `ci`, `repo`. CI checks the PR title and every non-merge commit;
`make hooks` checks each commit locally. Squash merging keeps the PR title as the
commit subject.

## Making CI a merge gate

The `check`, `e2e`, `herdr-check` and `conventional-commits` workflow jobs run on pull requests. To make
them required, add a ruleset for `main` that requires them and pull requests, and
blocks force pushes and deletion. Workflow files alone don't enforce anything.
