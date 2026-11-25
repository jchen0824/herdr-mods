import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

const BINARY = resolve(fileURLToPath(new URL("../target/debug/herdr-artifact", import.meta.url)));
const TERMINAL = "t7";
const PIN = 24;

const scratch = mkdtempSync(join(tmpdir(), "herdr-artifact-e2e-"));
const hcLog = join(scratch, "hc.log");
const hc = join(scratch, "fake-hc");
const env = { ...process.env, HERDR_ARTIFACTS_HOME: join(scratch, "store"), HERDR_ARTIFACT_HC: hc, HC_TERMINAL_ID: TERMINAL };
let server, devServer, review, fileId, liveId;

const cli = (...args) => JSON.parse(execFileSync(BINARY, [...args, "--json"], { env, encoding: "utf8" }));
const page1 = (version) => `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<h1 id="title" style="margin:40px">Pricing ${version}</h1>
<button id="buy" style="margin:40px;padding:20px" onclick="this.textContent='clicked'">Buy</button>
</body></html>`;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  writeFileSync(hc, `#!/bin/sh
if [ "$1" = ls ]; then echo '{"terminals":[{"address":"${TERMINAL}","status":"idle"}]}'; exit 0; fi
printf '%s\\n' "$@" >> '${hcLog}'
`);
  chmodSync(hc, 0o755);

  devServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body style="margin:0"><h2 id="live" style="margin:40px">Live page at ${req.url}</h2></body></html>`);
  });
  await new Promise((done) => devServer.listen(0, "127.0.0.1", done));

  writeFileSync(join(scratch, "pricing.html"), page1("one"));
  fileId = cli("publish", join(scratch, "pricing.html"), "--title", "Pricing file").id;
  liveId = cli("publish", "--url", `http://127.0.0.1:${devServer.address().port}/live`, "--title", "Live app").id;

  server = spawn(BINARY, ["serve", "--port", "0", "--json"], { env, stdio: ["ignore", "pipe", "inherit"] });
  const [first] = await createInterface({ input: server.stdout })[Symbol.asyncIterator]().next().then((r) => [r.value]);
  review = JSON.parse(first).url;
});

test.afterAll(async () => {
  server?.kill();
  await new Promise((done) => (devServer ? devServer.close(done) : done()));
  rmSync(scratch, { recursive: true, force: true });
});

async function openReview(page, ids) {
  await page.goto(`${review}/review/${ids.join(",")}`);
  const frames = page.locator(".board iframe");
  await expect(frames).toHaveCount(ids.length);
  for (let i = 0; i < ids.length; i++) await expect(page.frameLocator(".board iframe").nth(i).locator("herdr-review-layer")).toBeAttached();
}

async function pinTarget(page, frameIndex, selector) {
  const frame = page.frameLocator(".board iframe").nth(frameIndex);
  const target = frame.locator(selector);
  const box = await target.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top }; });
  const at = { x: 10, y: 10 };
  await target.click({ position: at });
  return { frame, point: { x: box.left + at.x, y: box.top + at.y } };
}

const underPin = (frame, point) =>
  frame.locator("body").evaluate((_, p) => document.elementFromPoint(p.x + p.half, p.y - p.half)?.localName, { ...point, half: PIN / 2 });

async function expectPin(frame, point) {
  await expect.poll(() => underPin(frame, point)).toBe("herdr-review-layer");
}

async function saveComment(page, text, recipient) {
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(text);
  await composer.getByRole("radio", { name: recipient }).click();
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toHaveCount(0);
}

test("the review page frames one artifact on another origin", async ({ page }) => {
  await openReview(page, [fileId]);
  const src = await page.locator(".board iframe").getAttribute("src");
  expect(new URL(src).origin).not.toBe(new URL(page.url()).origin);
  expect(src).toContain(`/a/${fileId}/v1/pricing.html`);
});

test("a click in Comment mode opens the box, and a note adds a thread and a pin", async ({ page }) => {
  await openReview(page, [fileId]);
  await expect(page.locator('.seg.mode [data-v="comment"]')).toHaveAttribute("aria-checked", "true");
  const { frame, point } = await pinTarget(page, 0, "#title");
  expect(await underPin(frame, point)).not.toBe("herdr-review-layer");
  await saveComment(page, "Name the plan", "Note");
  await expect(page.locator(".thread")).toHaveCount(1);
  await expect(page.locator(".thread").first()).toContainText("Name the plan");
  await expect(page.locator(".thread").first()).toContainText("note");
  await expectPin(frame, point);
  expect(existsSync(hcLog)).toBe(false);
});

test("send to agent types the comment into the agent's terminal", async ({ page }) => {
  await openReview(page, [fileId]);
  await pinTarget(page, 0, "#buy");
  await saveComment(page, "Make the button say Book a demo", `Send to agent ${TERMINAL}`);
  await expect(page.locator("#foot")).toHaveText(`Sent to agent ${TERMINAL}.`);
  await expect.poll(() => (existsSync(hcLog) ? readFileSync(hcLog, "utf8") : "")).toContain("Make the button say Book a demo");
  expect(readFileSync(hcLog, "utf8")).toMatch(new RegExp(`^send\\n${TERMINAL}\\n`));
});

test("c switches to Use page, and a click reaches the page's own handler", async ({ page }) => {
  await openReview(page, [fileId]);
  await page.locator("#bar .title").click();
  await page.keyboard.press("c");
  await expect(page.locator('.seg.mode [data-v="page"]')).toHaveAttribute("aria-checked", "true");
  const frame = page.frameLocator(".board iframe").first();
  await frame.locator("#buy").click();
  await expect(frame.locator("#buy")).toHaveText("clicked");
  await expect(page.locator(".composer")).toHaveCount(0);
});

test("a URL artifact loads through the proxy and takes a pin", async ({ page }) => {
  await openReview(page, [liveId]);
  const src = await page.locator(".board iframe").getAttribute("src");
  expect(new URL(src).port).not.toBe(String(devServer.address().port));
  expect(new URL(src).pathname).toBe("/live");
  const { frame, point } = await pinTarget(page, 0, "#live");
  await expect(frame.locator("#live")).toHaveText("Live page at /live");
  await saveComment(page, "Bigger heading", "Note");
  await expect(page.locator(".thread")).toHaveCount(1);
  await expectPin(frame, point);
});

test("two artifacts side by side, with the drawer grouped by artifact", async ({ page }) => {
  await openReview(page, [fileId, liveId]);
  await expect(page.locator(".board")).toHaveCount(2);
  await expect(page.locator("#panel .group .gname")).toHaveText(["Pricing file", "Live app"]);
  await page.getByRole("button", { name: "All" }).click();
  await expect(page.locator(".thread")).toHaveCount(3);
});

test("a new version published from the CLI shows without a reload", async ({ page }) => {
  await openReview(page, [fileId]);
  const frame = page.frameLocator(".board iframe").first();
  await expect(frame.locator("#title")).toHaveText("Pricing one");
  writeFileSync(join(scratch, "pricing.html"), page1("two"));
  expect(cli("publish", join(scratch, "pricing.html"), "-m", "Second").version).toBe(2);
  await expect(frame.locator("#title")).toHaveText("Pricing two");
  await expect(page.locator(".board .strip .meta")).toContainText("v2");
  await expect(page.locator("#foot")).toContainText("v2 was published");
});
