// scan.py against made-up agent histories in a throwaway HOME: OpenCode's database (2.x and
// 1.x schemas), search over its prompts, and delete going through `opencode session delete`.
// The throwaway HOME is under the temp folder, so its sessions count as scripted: list with --scripted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCAN = new URL("../mods/sessions/scan.py", import.meta.url).pathname;

function home() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sessions-test-")));
  mkdirSync(join(dir, ".local", "share", "opencode"), { recursive: true });
  mkdirSync(join(dir, "work", "app"), { recursive: true });
  return dir;
}

// Runs python with `sql` statements against <home>/.local/share/opencode/opencode.db.
function db(dir, sql) {
  const py = "import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.executescript(sys.stdin.read())\nc.commit()";
  execFileSync("python3", ["-c", py, join(dir, ".local", "share", "opencode", "opencode.db")], { input: sql });
}

function scan(dir, ...args) {
  const env = { ...process.env, HOME: dir, XDG_DATA_HOME: "", PATH: `${join(dir, "bin")}:${process.env.PATH}` };
  return JSON.parse(execFileSync("python3", [SCAN, ...args], { env, encoding: "utf8" }));
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const v2 = (dir) => `
create table session_v2 (id text primary key, project_id text, parent_id text, directory text, title text,
  model text, time_created integer, time_updated integer, time_archived integer);
create table session_message (id text primary key, session_id text, type text, seq integer, data text);
create table credential (id text, value text);
insert into credential values ('c', 'not-to-be-read');
insert into session_v2 values ('ses_aaaaaaaaaaaa', 'p', null, ${q(join(dir, "work", "app"))}, 'Fix the login page',
  '{"id":"deepseek-flash","providerID":"deepseek"}', 1, 2000, null);
insert into session_v2 values ('ses_bbbbbbbbbbbb', 'p', null, ${q(join(dir, "work"))}, 'New session - 2026-11-21', null, 1, 3000, null);
insert into session_v2 values ('ses_cccccccccccc', 'p', 'ses_aaaaaaaaaaaa', ${q(join(dir, "work"))}, 'sub-agent', null, 1, 4000, null);
insert into session_v2 values ('ses_dddddddddddd', 'p', null, ${q(join(dir, "work"))}, 'archived', null, 1, 5000, 6000);
insert into session_v2 values ('ses_eeeeeeeeeeee', 'p', null, ${q(join(dir, "work"))}, 'never typed in', null, 1, 7000, null);
insert into session_message values ('m1', 'ses_aaaaaaaaaaaa', 'user', 1, '{"text":"the login page\\nis broken"}');
insert into session_message values ('m2', 'ses_aaaaaaaaaaaa', 'assistant', 2, '{"content":[]}');
insert into session_message values ('m3', 'ses_aaaaaaaaaaaa', 'user', 3, '{"text":"also check the zebra handler"}');
insert into session_message values ('m4', 'ses_bbbbbbbbbbbb', 'user', 1, '{"text":"rename the build step"}');
insert into session_message values ('m5', 'ses_cccccccccccc', 'user', 1, '{"text":"sub-agent task"}');
insert into session_message values ('m6', 'ses_dddddddddddd', 'user', 1, '{"text":"old work"}');
`;

test("lists OpenCode 2.x sessions: top-level, not archived, with prompts", () => {
  const dir = home();
  try {
    db(dir, v2(dir));
    const out = scan(dir, "list", "--scripted");
    assert.deepEqual(out.errors, []);
    const rows = out.rows.filter((r) => r.agent === "opencode");
    assert.deepEqual(rows.map((r) => r.id), ["ses_bbbbbbbbbbbb", "ses_aaaaaaaaaaaa"]);
    const [b, a] = rows;
    assert.equal(a.title, "Fix the login page");
    assert.equal(a.first, "the login page is broken");
    assert.equal(a.last, "also check the zebra handler");
    assert.equal(a.prompts, 2);
    assert.equal(a.model, "deepseek-flash");
    assert.equal(a.cwd, join(dir, "work", "app"));
    assert.equal(a.updated, 2000);
    assert.equal(b.title, null, "OpenCode's placeholder title counts as none");
    assert.equal(b.first, "rename the build step");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("search finds an OpenCode session by a later prompt, and sees new prompts", () => {
  const dir = home();
  try {
    db(dir, v2(dir));
    assert.deepEqual(scan(dir, "search", "zebra").rows.map((r) => r.id), ["ses_aaaaaaaaaaaa"]);
    assert.deepEqual(scan(dir, "search", "giraffe").rows, []);
    db(dir, `insert into session_message values ('m7', 'ses_bbbbbbbbbbbb', 'user', 2, '{"text":"and the giraffe test"}');
      update session_v2 set time_updated = 8000 where id = 'ses_bbbbbbbbbbbb';`);
    assert.deepEqual(scan(dir, "search", "giraffe").rows.map((r) => r.id), ["ses_bbbbbbbbbbbb"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reads OpenCode 1.x's session, message and part tables", () => {
  const dir = home();
  try {
    db(dir, `
      create table session (id text primary key, parent_id text, directory text, title text, time_updated integer, time_archived integer);
      create table message (id text primary key, session_id text, time_created integer, data text);
      create table part (id text primary key, message_id text, session_id text, data text);
      insert into session values ('ses_ffffffffffff', null, ${q(join(dir, "work"))}, 'Old schema', 900, null);
      insert into session values ('ses_gggggggggggg', 'ses_ffffffffffff', ${q(join(dir, "work"))}, 'child', 901, null);
      insert into message values ('u1', 'ses_ffffffffffff', 1, '{"role":"user"}');
      insert into message values ('a1', 'ses_ffffffffffff', 2, '{"role":"assistant"}');
      insert into message values ('u2', 'ses_gggggggggggg', 1, '{"role":"user"}');
      insert into part values ('p1', 'u1', 'ses_ffffffffffff', '{"type":"text","text":"port the parser"}');
      insert into part values ('p2', 'u1', 'ses_ffffffffffff', '{"type":"text","text":"injected","synthetic":true}');
      insert into part values ('p2b', 'u1', 'ses_ffffffffffff', '{"type":"text","text":"to rust"}');
      insert into part values ('p3', 'a1', 'ses_ffffffffffff', '{"type":"text","text":"assistant reply"}');
      insert into part values ('p4', 'u2', 'ses_gggggggggggg', '{"type":"text","text":"child prompt"}');
    `);
    const rows = scan(dir, "list", "--scripted").rows.filter((r) => r.agent === "opencode");
    assert.deepEqual(rows.map((r) => [r.id, r.title, r.first, r.prompts]), [["ses_ffffffffffff", "Old schema", "port the parser to rust", 1]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delete runs `opencode session delete <id>` and refuses ids that aren't OpenCode's", () => {
  const dir = home();
  try {
    mkdirSync(join(dir, "bin"));
    const log = join(dir, "opencode.log");
    writeFileSync(join(dir, "bin", "opencode"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`);
    chmodSync(join(dir, "bin", "opencode"), 0o755);
    assert.deepEqual(scan(dir, "delete", "opencode", "ses_aaaaaaaaaaaa", "", join(dir, "work")), { ok: true });
    assert.equal(readFileSync(log, "utf8"), "session delete ses_aaaaaaaaaaaa\n");
    assert.match(scan(dir, "delete", "opencode", "0123abcd-0000", "", "").error, /not an OpenCode session id/);
    assert.match(scan(dir, "delete", "opencode", "ses_x;rm -rf ~", "", "").error, /not a session id/);
    assert.equal(readFileSync(log, "utf8"), "session delete ses_aaaaaaaaaaaa\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
