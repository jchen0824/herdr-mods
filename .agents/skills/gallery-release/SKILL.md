---
name: gallery-release
description: Use when adding a mod folder, changing a preview, README or RECIPE.md, or publishing to the herdr.dev gallery.
---

# Keep each folder a complete, private-safe gallery entry

herdr.dev lists repos with the `herdr-mod` topic; each top-level folder with a
`RECIPE.md` and `preview.png` is an entry. `make check` enforces the files and the
RECIPE sections. Adding or changing topics is publishing: do it only when asked.

`RECIPE.md` follows Herdr's order: name, one paragraph and the preview; What you see;
How it behaves; Built from; Watch out; Done when. Write it from the real files:
exact sizes, colours, commands and limits, and nothing the build doesn't do. When
behaviour changes, update README and RECIPE in the same commit.

Previews:

- Use made-up data only. `kube` has a demo mode (`props: { demo: true }`) for this.
  A screenshot of a real window shows cluster, namespace, folder and agent names.
- Crop to the mod. `herdr-app shot` captures the whole window, sidebar included.
- Before committing, search the diff for real names, emails and paths
  (`git diff --cached | grep -iE '<your org>|/Users/'`).

A README states what the mod does to the user's machine: programs it runs, network
it reaches, files it reads or writes. Installers are told to report this first.
