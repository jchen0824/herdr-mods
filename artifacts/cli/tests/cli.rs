//! The real binary against a scratch store under /var/tmp: never the machine's own artifacts.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::Value;

static NEXT: AtomicU32 = AtomicU32::new(0);

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

impl Scratch {
    fn new() -> Self {
        let base = if cfg!(unix) { PathBuf::from("/var/tmp") } else { std::env::temp_dir() };
        let dir =
            base.join(format!("herdr-artifact-test-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(dir.join("work")).unwrap();
        Self(dir)
    }

    fn file(&self, name: &str, content: &str) -> String {
        let path = self.0.join("work").join(name);
        fs::write(&path, content).unwrap();
        path.to_str().unwrap().to_owned()
    }

    /// Runs with `--json` as the given terminal ("" for a person) and returns the exit code and parsed output.
    fn run(&self, terminal: &str, args: &[&str]) -> (i32, Value) {
        let out = Command::new(env!("CARGO_BIN_EXE_herdr-artifact"))
            .args(args)
            .arg("--json")
            .env("HERDR_ARTIFACTS_HOME", self.0.join("store"))
            .env("HC_TERMINAL_ID", terminal)
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        (out.status.code().unwrap(), serde_json::from_str(&text).unwrap_or_else(|_| panic!("not JSON: {text}")))
    }

    fn ok(&self, terminal: &str, args: &[&str]) -> Value {
        let (code, json) = self.run(terminal, args);
        assert_eq!(code, 0, "{args:?} failed: {json}");
        json
    }
}

#[test]
fn publishing_snapshots_each_changed_version_and_skips_unchanged_content() {
    let s = Scratch::new();
    let page = s.file("pricing.html", "<h1>one</h1>");
    let first = s.ok("t7", &["publish", &page, "--title", "Pricing page", "-m", "First draft"]);
    assert_eq!((first["version"].as_u64(), first["new"].as_bool()), (Some(1), Some(true)));
    assert_eq!(fs::read_to_string(first["path"].as_str().unwrap()).unwrap(), "<h1>one</h1>");
    let id = first["id"].as_str().unwrap();

    let again = s.ok("t7", &["publish", &page]);
    assert_eq!((again["version"].as_u64(), again["new"].as_bool()), (Some(1), Some(false)));

    s.file("pricing.html", "<h1>two</h1>");
    let second = s.ok("t9", &["publish", &page, "--status", "working"]);
    assert_eq!(second["version"].as_u64(), Some(2));
    assert_eq!(fs::read_to_string(first["path"].as_str().unwrap()).unwrap(), "<h1>one</h1>", "v1 keeps its content");

    let shown = s.ok("", &["show", id]);
    let artifact = &shown["artifact"];
    assert_eq!(artifact["title"], "Pricing page");
    assert_eq!((artifact["kind"].as_str(), artifact["status"].as_str()), (Some("html"), Some("working")));
    assert_eq!(artifact["terminal"], "t7", "the first publisher stays the author");
    assert_eq!(artifact["versions"][0]["note"], "First draft");
    assert_eq!(artifact["versions"].as_array().unwrap().len(), 2);
}

#[test]
fn a_comment_is_answered_and_resolved_by_the_version_that_fixes_it() {
    let s = Scratch::new();
    let doc = s.file("copy.md", "# Pricing\nStart free.\n");
    let id = s.ok("t7", &["publish", &doc])["id"].as_str().unwrap().to_owned();

    let pinned =
        s.ok("", &["comment", &id, "Name the limit", "--pin", "0.5,0.25", "--label", "Subheading", "--to-agent"]);
    let comment = &pinned["comment"];
    assert_eq!(
        (comment["author"].as_str(), comment["version"].as_u64(), comment["to_agent"].as_bool()),
        (Some("user"), Some(1), Some(true))
    );
    assert_eq!(comment["anchor"], serde_json::json!({ "kind": "pin", "x": 0.5, "y": 0.25, "label": "Subheading" }));
    let cid = comment["id"].as_str().unwrap().to_owned();
    let quoted = s.ok("", &["comment", &id, "Too vague", "--quote", "Start free.", "--line", "2"]);
    assert_eq!(quoted["comment"]["anchor"], serde_json::json!({ "kind": "text", "quote": "Start free.", "line": 2 }));
    assert_eq!(s.ok("", &["list"])[0]["open_comments"], 2);

    s.file("copy.md", "# Pricing\nFree for one machine.\n");
    let published = s.ok("t7", &["publish", &doc, "-m", "Named the limit", "--resolves", &cid]);
    assert_eq!((published["version"].as_u64(), published["status"].as_str()), (Some(2), Some("ready")));
    let replied = s.ok("t7", &["reply", &cid, "Changed the subheading."]);
    assert_eq!(
        replied["comment"]["replies"][0],
        serde_json::json!({ "author": "t7", "body": "Changed the subheading.", "at": replied["comment"]["replies"][0]["at"] })
    );
    assert_eq!(
        (replied["comment"]["open"].as_bool(), replied["comment"]["resolved_in"].as_u64()),
        (Some(false), Some(2))
    );

    assert_eq!(s.ok("", &["reopen", &cid])["comment"]["open"], true);
    assert_eq!(s.ok("", &["reply", &cid, "Fine now", "--resolve"])["comment"]["open"], false);
    assert_eq!(s.ok("", &["list"])[0]["open_comments"], 1);
}

#[test]
fn list_filters_by_status_and_status_changes_it() {
    let s = Scratch::new();
    let a = s.ok("t1", &["publish", &s.file("a.md", "a")])["id"].as_str().unwrap().to_owned();
    s.ok("t1", &["publish", &s.file("b.svg", "<svg/>"), "--status", "working"]);
    assert_eq!(s.ok("", &["list"]).as_array().unwrap().len(), 2);
    assert_eq!(s.ok("", &["status", &a, "approved"])["status"], "approved");
    let approved = s.ok("", &["list", "--status", "approved"]);
    assert_eq!((approved.as_array().unwrap().len(), approved[0]["id"].as_str()), (1, Some(a.as_str())));
}

#[test]
fn mistakes_exit_1_with_the_reason_and_write_nothing() {
    let s = Scratch::new();
    let missing = s.0.join("work/none.md");
    let cases: [&[&str]; 4] = [
        &["publish", missing.to_str().unwrap()],
        &["show", "../../etc"],
        &["reply", "c_000000", "hi"],
        &["show", "nothing-00000000"],
    ];
    for args in cases {
        let (code, json) = s.run("", args);
        assert_eq!(code, 1, "{args:?}");
        assert!(json["error"].as_str().is_some_and(|e| !e.is_empty()), "{args:?}: {json}");
    }
    let doc = s.file("a.md", "a");
    let id = s.ok("t1", &["publish", &doc])["id"].as_str().unwrap().to_owned();
    s.file("a.md", "b");
    let (code, json) = s.run("t1", &["publish", &doc, "--resolves", "c_ffffff"]);
    assert_eq!((code, json["error"].as_str().unwrap().contains("c_ffffff")), (1, true));
    assert_eq!(
        s.ok("", &["show", &id])["artifact"]["versions"].as_array().unwrap().len(),
        1,
        "a refused publish makes no version"
    );
    assert_eq!(s.run("", &["comment", &id, "x", "--pin", "742,404"]).0, 1);
    assert_eq!(s.run("", &["comment", &id, "x", "--version", "9"]).0, 1);
}

#[test]
fn skill_prints_the_manual() {
    let out = Command::new(env!("CARGO_BIN_EXE_herdr-artifact")).arg("--skill").output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(out.status.success() && text.starts_with("# herdr-artifact") && text.contains("--resolves"));
}

/// A stand-in for hc that writes its arguments to a file, so a test sees what would be typed.
#[cfg(unix)]
fn fake_hc(s: &Scratch) -> (String, PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let (script, log) = (s.0.join("fake-hc"), s.0.join("hc.log"));
    fs::write(&script, format!("#!/bin/sh\nif [ \"$1\" = ls ]; then if [ -n \"$FAKE_SHELL\" ]; then echo '{{\"terminals\":[{{\"address\":\"t7\"}}]}}'; else echo '{{\"terminals\":[{{\"address\":\"t7\",\"status\":\"working\"}}]}}'; fi; exit 0; fi\nprintf '%s\\n' \"$@\" >> '{}'\n", log.display()))
        .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    (script.to_str().unwrap().to_owned(), log)
}

#[cfg(unix)]
#[test]
fn send_types_the_comment_into_the_publishing_terminal_and_asks_for_changes() {
    let s = Scratch::new();
    let (hc, log) = fake_hc(&s);
    let page = s.file("p.html", "<a>Talk</a>");
    let id = s.ok("t7", &["publish", &page])["id"].as_str().unwrap().to_owned();
    let cid =
        s.ok("", &["comment", &id, "Say Book a demo", "--to-agent"])["comment"]["id"].as_str().unwrap().to_owned();
    let out = Command::new(env!("CARGO_BIN_EXE_herdr-artifact"))
        .args(["send", &cid, "--json"])
        .env("HERDR_ARTIFACTS_HOME", s.0.join("store"))
        .env("HERDR_ARTIFACT_HC", &hc)
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
    let typed = fs::read_to_string(&log).unwrap();
    assert!(
        typed.starts_with("send\nt7\n")
            && typed.contains("\"Say Book a demo\"")
            && typed.contains(&format!("--resolves {cid}")),
        "{typed}"
    );
    assert_eq!(s.ok("", &["show", &id])["artifact"]["status"], "changes_requested");

    // The agent has exited and its terminal is a shell again: nothing may be typed into it.
    let again =
        s.ok("", &["comment", &id, "rm -rf everything", "--to-agent"])["comment"]["id"].as_str().unwrap().to_owned();
    let refused = Command::new(env!("CARGO_BIN_EXE_herdr-artifact"))
        .args(["send", &again, "--json"])
        .env("HERDR_ARTIFACTS_HOME", s.0.join("store"))
        .env("HERDR_ARTIFACT_HC", &hc)
        .env("FAKE_SHELL", "1")
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&refused.stdout).contains("not running an agent"));
    assert!(!fs::read_to_string(&log).unwrap().contains("rm -rf everything"), "nothing was typed");

    let orphan = s.ok("", &["publish", &s.file("q.md", "q")])["id"].as_str().unwrap().to_owned();
    let lone = s.ok("", &["comment", &orphan, "x"])["comment"]["id"].as_str().unwrap().to_owned();
    assert_eq!(s.run("", &["send", &lone]).0, 1, "an artifact published by a person has nobody to send to");
}
