# herdr-artifact

A command-line program for reviewing what coding agents make. An agent publishes a file as an
artifact. A person comments on it. The comment is typed into the agent's terminal, and the agent
answers in the thread and publishes the next version.

It is one static binary with no runtime to install. It needs herdr-core (`hc`) only to send comments
to an agent.

## Build and install

```sh
cd artifacts/cli
cargo test                 # the suite
just check                 # fmt, clippy and the suite, as CI runs them
just install               # builds a release binary into ~/.local/bin
cd e2e && npm ci && npx playwright install chromium && npm test   # the review page in Chromium
```

Rust 1.89 or newer.

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
herdr-artifact publish --url http://localhost:5173/pricing --title "Pricing page"
herdr-artifact serve [--port 7501] [--host NAME]
```

`--json` on any command prints its result as JSON, or `{"error": "..."}` with exit code 1.
`herdr-artifact --skill` prints the manual an agent reads.

## Review pages

`serve` answers on `http://127.0.0.1:7501` until it is stopped. `--port 0` picks a free port, and
`--json` prints the address it took. Open:

| Address | Shows |
|---|---|
| `/` | every artifact |
| `/review/<id>` | one artifact, filling the window, with its comments in a drawer |
| `/review/<id>,<id>` | several artifacts side by side, with the drawer grouped by artifact |

In Comment mode (`c` toggles it) a click drops a pin and opens a comment box. The comment is saved
as a note, or sent to the agent that published the artifact. It records the page it was made on:
for a file, the file's path inside the folder it was published from (a page it links to counts);
for a dev server, the path and query inside the app. A comment with no page, such as one made with
`comment --pin`, is on the entry page. An artboard shows pins only for the page it is showing. The
drawer lists every thread, names the page of one made elsewhere, and selecting it opens that page.
The server refuses a page with a scheme, a host or a `..` segment. A reply typed on a sent comment goes
to the agent too, with the whole thread. The page checks the store every few seconds, so a new
version or an agent's reply shows without a reload.

`publish --url` makes an artifact of a page on a dev server. Nothing is copied: the page is shown
through a proxy that passes everything through and adds one script tag to HTML. WebSocket upgrades
are tunnelled, so hot reload keeps working. Each publish of the address is a new version.

`--host NAME` also answers on an address of this computer, such as its tailnet name, for reviewing
from another device. Anyone who can reach that address can send comments into your agents'
terminals. The server never listens on every interface.

### Two origins

An artifact is a page an agent wrote, and a comment can be typed into an agent's terminal, so the
artifact must not be able to call the API. The review page and its API are on one origin. Published
files are served on a second port, with the comment layer added, and nothing else. Each dev server
gets a proxy on a port of its own. The review page and the comment layer in the frame talk only by
`postMessage`, each checking the other's origin.

The server answers only requests whose `Host` is one of its own names on the right port. It takes
a `POST` only from the review origin itself, with a JSON body. The content origin and the proxies
serve no API, and the review origin serves no artifact files. A file beside a published artifact
is served only from the folder it was published from.

## What it stores

Everything is under `~/.herdr/artifacts` (`HERDR_ARTIFACTS_HOME` moves it):

| Path | Holds |
|---|---|
| `<id>/artifact.json` | title, source path, kind, status, the terminal that first published it (`first_publisher`), and the list of versions |
| `<id>/v<n>/<file>` | the file as it was when version `n` was published |
| `<id>/comments.json` | comment threads: anchor (with its page, for pins and elements), body, author (`person` or a terminal), whether `send` delivered it (`sent_to_agent`), replies, open or resolved, and the version that resolved it |

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
- `comment` can write a pin or a quote. The `element` anchor is written by the review page.
- Live pages work with plain `http://` dev servers only.
- The proxy asks the dev server for uncompressed responses and passes them on uncompressed.
- The proxy reads a whole response before passing it on, so streaming responses (server-sent
  events, a long chunked body) will not work. WebSockets do.
- Only Vite with React was tried by hand as a dev server. The browser test uses a small Node server.
- Not tested on Windows.
