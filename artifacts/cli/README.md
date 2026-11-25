# herdr-artifact

A command-line program for reviewing what coding agents make. An agent publishes a file as an
artifact. A person comments on it. The comment is typed into the agent's terminal, and the agent
answers in the thread and publishes the next version.

It is one static binary with no runtime to install. It needs herdr-core (`hc`) only for `send`.

## Build and install

```sh
cd artifacts/cli
cargo test                 # the suite
just check                 # fmt, clippy and the suite, as CI runs them
just install               # builds a release binary into ~/.local/bin
```

Rust 1.86 or newer.

## Use

```sh
herdr-artifact publish site/pricing.html --title "Pricing page" -m "First draft"
herdr-artifact list
herdr-artifact show <artifact-id>
herdr-artifact comment <artifact-id> "Name the free plan limit" --pin 0.5,0.25
herdr-artifact send <comment-id>
herdr-artifact reply <comment-id> "Changed the subheading."
herdr-artifact publish site/pricing.html -m "Named the limit" --resolves <comment-id>
herdr-artifact status <artifact-id> approved
```

`--json` on any command prints its result as JSON, or `{"error": "..."}` with exit code 1.
`herdr-artifact --skill` prints the manual an agent reads.

## What it stores

Everything is under `~/.herdr/artifacts` (`HERDR_ARTIFACTS_HOME` moves it):

| Path | Holds |
|---|---|
| `<id>/artifact.json` | title, source path, kind, status, the terminal that first published it (`first_publisher`), and the list of versions |
| `<id>/v<n>/<file>` | the file as it was when version `n` was published |
| `<id>/comments.json` | comment threads: anchor, body, author (`person` or a terminal), whether `send` delivered it (`sent_to_agent`), replies, open or resolved, and the version that resolved it |

The id comes from the source path, so publishing the same file again adds a version to the same
artifact. Unchanged content adds none. Every write replaces its file whole, so a reader never sees
half of one.

## Sending to an agent

`send` types the comment into the terminal that first published the artifact, with the commands to
reply and to publish a fix. Text typed into a terminal is run by whatever is there, so `send` first
asks `hc` whether that terminal reports an agent status. A terminal that is gone, or is a shell
again, gets nothing: the comment stays saved and the command fails with the reason.

## Limits

- Only the published file is snapshotted. Files it refers to are not.
- `comment` can write a pin or a quote. The `element` anchor in `comments.json` is written by the
  review page, which is not in this folder yet.
- Not tested on Windows.
