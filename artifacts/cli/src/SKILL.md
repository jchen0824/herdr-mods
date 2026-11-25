# herdr-artifact

Publish a file you made so the person can review it in Herdr: they see it rendered, pin comments on
it and send them to you. Each publish of the same file is a new version of the same artifact.

Use it for things worth looking at: a page, a document, a diagram, an image, a plan. Not for every
file you touch.

## Publish

```sh
herdr-artifact publish site/pricing.html --title "Pricing page" -m "First draft"
```

Prints the artifact id and version. Publishing again after you change the file makes the next
version; unchanged content makes none. `-m` is your note for that version: say what changed.
A new version is `ready` for review. Pass `--status working` while you are still on it.

Only that one file is snapshotted. An HTML page shows best when its CSS and images are inline.

## Answer comments

Comments reach your terminal with their id (`c_8f2a1b`). Read them all with:

```sh
herdr-artifact show <artifact-id>
```

A pin is a point on the rendered artifact, as fractions of its width and height, with a label saying
what is there. A quote is text from the file. After you act on a comment:

```sh
herdr-artifact publish site/pricing.html -m "Monthly/yearly toggle" --resolves c_8f2a1b
herdr-artifact reply c_8f2a1b "Added a toggle above the cards. Yearly is the default."
```

`--resolves` closes the comment and records which version did it. Reply without resolving when you
have a question or disagree; the person sees it in the thread. `reply --resolve` closes a comment
that needed no new version.

## Everything

```sh
herdr-artifact list [--status ready]
herdr-artifact show <id>
herdr-artifact publish <file> [--title T] [-m NOTE] [--resolves COMMENT]... [--status working|ready]
herdr-artifact comment <id> <body> [--pin X,Y --label L | --quote Q --line N]
herdr-artifact reply <comment> <body> [--resolve]
herdr-artifact resolve <comment> | reopen <comment>
herdr-artifact status <id> working|ready|changes_requested|approved
herdr-artifact send <comment>            # type a comment into the publishing agent's terminal
```

`--json` on any command prints its result as JSON, or `{"error": "..."}` with exit code 1.
The store is `~/.herdr/artifacts` (`HERDR_ARTIFACTS_HOME` moves it): `<id>/artifact.json`,
`<id>/comments.json` and `<id>/v<n>/<file>`.
