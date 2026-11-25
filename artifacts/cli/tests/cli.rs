use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{Value, json};

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

    fn run(&self, terminal: Option<&str>, args: &[&str]) -> (i32, Value) {
        let mut command = Command::new(env!("CARGO_BIN_EXE_herdr-artifact"));
        command
            .args(args)
            .arg("--json")
            .env("HERDR_ARTIFACTS_HOME", self.0.join("store"))
            .env("HERDR_ARTIFACT_HC", self.0.join("fake-hc"));
        match terminal {
            Some(address) => command.env("HC_TERMINAL_ID", address),
            None => command.env_remove("HC_TERMINAL_ID"),
        };
        let out = command.output().unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        (out.status.code().unwrap(), serde_json::from_str(&text).unwrap_or_else(|_| panic!("not JSON: {text}")))
    }

    fn ok(&self, terminal: Option<&str>, args: &[&str]) -> Value {
        let (code, json) = self.run(terminal, args);
        assert_eq!(code, 0, "{args:?} failed: {json}");
        json
    }
}

#[test]
fn publishing_snapshots_each_changed_version_and_skips_unchanged_content() {
    let s = Scratch::new();
    let page = s.file("pricing.html", "<h1>one</h1>");
    let first = s.ok(Some("t7"), &["publish", &page, "--title", "Pricing page", "-m", "First draft"]);
    assert_eq!((first["version"].as_u64(), first["new"].as_bool()), (Some(1), Some(true)));
    assert_eq!(fs::read_to_string(first["path"].as_str().unwrap()).unwrap(), "<h1>one</h1>");
    let id = first["id"].as_str().unwrap();

    let again = s.ok(Some("t7"), &["publish", &page]);
    assert_eq!((again["version"].as_u64(), again["new"].as_bool()), (Some(1), Some(false)));

    s.file("pricing.html", "<h1>two</h1>");
    let second = s.ok(Some("t9"), &["publish", &page, "--status", "working"]);
    assert_eq!(second["version"].as_u64(), Some(2));
    assert_eq!(fs::read_to_string(first["path"].as_str().unwrap()).unwrap(), "<h1>one</h1>", "v1 keeps its content");

    let shown = s.ok(None, &["show", id]);
    let artifact = &shown["artifact"];
    assert_eq!(artifact["title"], "Pricing page");
    assert_eq!((artifact["kind"].as_str(), artifact["status"].as_str()), (Some("html"), Some("working")));
    assert_eq!(artifact["first_publisher"], "t7");
    assert_eq!(artifact["versions"][0]["note"], "First draft");
    assert_eq!(artifact["versions"].as_array().unwrap().len(), 2);
}

#[test]
fn a_comment_is_answered_and_resolved_by_the_version_that_fixes_it() {
    let s = Scratch::new();
    let doc = s.file("copy.md", "# Pricing\nStart free.\n");
    let id = s.ok(Some("t7"), &["publish", &doc])["id"].as_str().unwrap().to_owned();

    let pinned = s.ok(None, &["comment", &id, "Name the limit", "--pin", "0.5,0.25", "--label", "Subheading"]);
    let comment = &pinned["comment"];
    assert_eq!(
        (&comment["author"], comment["version"].as_u64(), comment["sent_to_agent"].as_bool()),
        (&json!({ "kind": "person" }), Some(1), Some(false))
    );
    assert_eq!(comment["anchor"], json!({ "kind": "pin", "x": 0.5, "y": 0.25, "label": "Subheading" }));
    let cid = comment["id"].as_str().unwrap().to_owned();
    let quoted = s.ok(None, &["comment", &id, "Too vague", "--quote", "Start free.", "--line", "2"]);
    assert_eq!(quoted["comment"]["anchor"], json!({ "kind": "text", "quote": "Start free.", "line": 2 }));
    assert_eq!(s.ok(None, &["list"])[0]["open_comments"], 2);

    s.file("copy.md", "# Pricing\nFree for one machine.\n");
    let published = s.ok(Some("t7"), &["publish", &doc, "-m", "Named the limit", "--resolves", &cid]);
    assert_eq!((published["version"].as_u64(), published["status"].as_str()), (Some(2), Some("ready")));
    let replied = s.ok(Some("t7"), &["reply", &cid, "Changed the subheading."]);
    assert_eq!(
        replied["comment"]["replies"][0],
        json!({ "author": { "kind": "terminal", "address": "t7" }, "body": "Changed the subheading.",
                "at": replied["comment"]["replies"][0]["at"] })
    );
    assert_eq!(
        (replied["comment"]["open"].as_bool(), replied["comment"]["resolved_in"].as_u64()),
        (Some(false), Some(2))
    );

    assert_eq!(s.ok(None, &["reopen", &cid])["comment"]["open"], true);
    assert_eq!(s.ok(None, &["reply", &cid, "Fine now", "--resolve"])["comment"]["open"], false);
    assert_eq!(s.ok(None, &["list"])[0]["open_comments"], 1);
}

#[test]
fn two_artifacts_never_get_the_same_comment_id() {
    let s = Scratch::new();
    let a = s.ok(Some("t1"), &["publish", &s.file("a.md", "a")])["id"].as_str().unwrap().to_owned();
    let b = s.ok(Some("t1"), &["publish", &s.file("b.md", "b")])["id"].as_str().unwrap().to_owned();
    let on_a = s.ok(None, &["comment", &a, "Same words"])["comment"]["id"].as_str().unwrap().to_owned();
    let on_b = s.ok(None, &["comment", &b, "Same words"])["comment"]["id"].as_str().unwrap().to_owned();
    assert_ne!(on_a, on_b);
    assert_eq!(s.ok(None, &["resolve", &on_b])["artifact"].as_str(), Some(b.as_str()));
}

#[test]
fn list_filters_by_status_and_status_changes_it() {
    let s = Scratch::new();
    let a = s.ok(Some("t1"), &["publish", &s.file("a.md", "a")])["id"].as_str().unwrap().to_owned();
    s.ok(Some("t1"), &["publish", &s.file("b.svg", "<svg/>"), "--status", "working"]);
    assert_eq!(s.ok(None, &["list"]).as_array().unwrap().len(), 2);
    assert_eq!(s.ok(None, &["status", &a, "approved"])["status"], "approved");
    let approved = s.ok(None, &["list", "--status", "approved"]);
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
        let (code, json) = s.run(None, args);
        assert_eq!(code, 1, "{args:?}");
        assert!(json["error"].as_str().is_some_and(|e| !e.is_empty()), "{args:?}: {json}");
    }
    let doc = s.file("a.md", "a");
    let id = s.ok(Some("t1"), &["publish", &doc])["id"].as_str().unwrap().to_owned();
    s.file("a.md", "b");
    let (code, json) = s.run(Some("t1"), &["publish", &doc, "--resolves", "c_ffffff"]);
    assert_eq!((code, json["error"].as_str().unwrap().contains("c_ffffff")), (1, true));
    assert_eq!(
        s.ok(None, &["show", &id])["artifact"]["versions"].as_array().unwrap().len(),
        1,
        "a refused publish makes no version"
    );
    assert_eq!(s.run(None, &["comment", &id, "x", "--pin", "742,404"]).0, 1);
    assert_eq!(s.run(None, &["comment", &id, "x", "--version", "9"]).0, 1);
}

#[test]
fn skill_prints_the_manual() {
    let out = Command::new(env!("CARGO_BIN_EXE_herdr-artifact")).arg("--skill").output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert!(out.status.success() && text.starts_with("# herdr-artifact") && text.contains("--resolves"));
}

#[cfg(unix)]
fn fake_hc(s: &Scratch, listing: Value) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let (script, log) = (s.0.join("fake-hc"), s.0.join("hc.log"));
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nif [ \"$1\" = ls ]; then echo '{listing}'; exit 0; fi\nprintf '%s\\n' \"$@\" >> '{}'\n",
            log.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    log
}

#[cfg(unix)]
#[test]
fn send_types_the_comment_into_the_publishing_terminal_and_asks_for_changes() {
    let s = Scratch::new();
    let log = fake_hc(&s, json!({ "terminals": [{ "address": "t7", "status": "working" }] }));
    let id = s.ok(Some("t7"), &["publish", &s.file("p.html", "<a>Talk</a>")])["id"].as_str().unwrap().to_owned();
    let cid = s.ok(None, &["comment", &id, "Say Book a demo"])["comment"]["id"].as_str().unwrap().to_owned();
    s.ok(None, &["send", &cid]);
    let typed = fs::read_to_string(&log).unwrap();
    assert!(
        typed.starts_with("send\nt7\n")
            && typed.contains("\"Say Book a demo\"")
            && typed.contains(&format!("--resolves {cid}")),
        "{typed}"
    );
    let shown = s.ok(None, &["show", &id]);
    assert_eq!(
        (&shown["artifact"]["status"], &shown["comments"][0]["sent_to_agent"]),
        (&json!("changes_requested"), &json!(true))
    );
}

#[cfg(unix)]
#[test]
fn send_types_nothing_into_a_terminal_that_is_a_shell_again() {
    let s = Scratch::new();
    let log = fake_hc(&s, json!({ "terminals": [{ "address": "t7" }] }));
    let id = s.ok(Some("t7"), &["publish", &s.file("p.html", "<a>Talk</a>")])["id"].as_str().unwrap().to_owned();
    let cid = s.ok(None, &["comment", &id, "rm -rf everything"])["comment"]["id"].as_str().unwrap().to_owned();
    let (code, refused) = s.run(None, &["send", &cid]);
    assert_eq!(code, 1);
    assert!(refused["error"].as_str().unwrap().contains("not running an agent"), "{refused}");
    assert!(!log.exists(), "nothing was typed");
    assert_eq!(s.ok(None, &["show", &id])["comments"][0]["sent_to_agent"], false);
}

#[cfg(unix)]
#[test]
fn send_types_nothing_into_a_terminal_that_is_gone() {
    let s = Scratch::new();
    let log = fake_hc(&s, json!({ "terminals": [] }));
    let id = s.ok(Some("t7"), &["publish", &s.file("p.html", "<a>Talk</a>")])["id"].as_str().unwrap().to_owned();
    let cid = s.ok(None, &["comment", &id, "x"])["comment"]["id"].as_str().unwrap().to_owned();
    let (code, refused) = s.run(None, &["send", &cid]);
    assert_eq!(code, 1);
    assert!(refused["error"].as_str().unwrap().contains("t7 is not running:"), "{refused}");
    assert!(!log.exists(), "nothing was typed");
}

#[test]
fn send_refuses_an_artifact_a_person_published() {
    let s = Scratch::new();
    let id = s.ok(None, &["publish", &s.file("q.md", "q")])["id"].as_str().unwrap().to_owned();
    let cid = s.ok(None, &["comment", &id, "x"])["comment"]["id"].as_str().unwrap().to_owned();
    assert_eq!(s.run(None, &["send", &cid]).0, 1, "nobody to send to");
}

fn http(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (u16, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nContent-Length: {}\r\n", body.len());
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    stream.write_all(format!("{request}\r\n{body}").as_bytes()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let status = answer.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    (status, answer.split_once("\r\n\r\n").map(|(_, b)| b.to_owned()).unwrap_or_default())
}

struct Server {
    child: std::process::Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    fn start(s: &Scratch) -> Self {
        use std::io::{BufRead, BufReader};
        let mut child = Command::new(env!("CARGO_BIN_EXE_herdr-artifact"))
            .args(["serve", "--port", "0", "--json"])
            .env("HERDR_ARTIFACTS_HOME", s.0.join("store"))
            .env("HERDR_ARTIFACT_HC", s.0.join("fake-hc"))
            .env_remove("HC_TERMINAL_ID")
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut first = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut first).unwrap();
        let port = serde_json::from_str::<Value>(&first).unwrap()["port"].as_u64().unwrap() as u16;
        Self { child, port }
    }

    fn host(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    fn state(&self, id: &str) -> Value {
        let (code, body) = http(self.port, "GET", &format!("/api/artifacts/{id}"), &[("Host", &self.host())], "");
        assert_eq!(code, 200, "{body}");
        serde_json::from_str(&body).unwrap()
    }
}

fn port_of(origin: &Value) -> u16 {
    origin.as_str().unwrap().rsplit(':').next().unwrap().parse().unwrap()
}

#[cfg(unix)]
#[test]
fn the_review_server_serves_the_page_takes_element_comments_and_refuses_strangers() {
    let s = Scratch::new();
    let log = fake_hc(&s, json!({ "terminals": [{ "address": "t7", "status": "working" }] }));
    let page = s.file("p.html", "<link rel=stylesheet href=p.css><a class=btn>Talk</a>");
    s.file("p.css", "a{color:red}");
    s.file("next.html", "<body><p>Next</p></body>");
    fs::write(s.0.join("secret.txt"), "no").unwrap();
    let id = s.ok(Some("t7"), &["publish", &page])["id"].as_str().unwrap().to_owned();
    let other = s.ok(Some("t7"), &["publish", &s.file("o.md", "o")])["id"].as_str().unwrap().to_owned();
    let elsewhere =
        s.ok(None, &["comment", &other, "On another artifact"])["comment"]["id"].as_str().unwrap().to_owned();

    let server = Server::start(&s);
    let (port, host) = (server.port, server.host());
    let origin = format!("http://{host}");
    let get = |path: &str| http(port, "GET", path, &[("Host", &host)], "");
    let post = |path: &str, body: &str| {
        http(port, "POST", path, &[("Host", &host), ("Origin", &origin), ("Content-Type", "application/json")], body)
    };

    assert!(get(&format!("/review/{id}")).1.contains("/__herdr/review.js"));
    let state = server.state(&id);
    assert_eq!(state["agent"], json!({ "terminal": "t7", "state": "agent", "status": "working" }));
    assert_eq!(get("/api/artifacts").1.matches(&id).count(), 1, "the list names it");
    assert_eq!(get("/api/artifacts/..%2F..%2Fetc").0, 404, "an id that does not parse");
    assert_eq!(get("/api/artifacts/nothing-00000000").0, 404);

    let content = port_of(&state["frame"]["origin"]);
    assert_ne!(content, port);
    let chost = format!("127.0.0.1:{content}");
    let cget = |path: &str| http(content, "GET", path, &[("Host", &chost)], "");
    let tag = format!("<script src=\"/__herdr/overlay.js\" data-review=\"{origin}\"></script>");
    assert_eq!(
        cget(&format!("/a/{id}/v1/p.html")),
        (200, format!("<link rel=stylesheet href=p.css><a class=btn>Talk</a>{tag}"))
    );
    assert_eq!(cget(&format!("/a/{id}/v1/p.html?raw")).1, "<link rel=stylesheet href=p.css><a class=btn>Talk</a>");
    assert_eq!(cget(&format!("/a/{id}/v1/p.css")), (200, "a{color:red}".into()), "files beside the artifact");
    assert_eq!(
        cget(&format!("/a/{id}/v1/next.html")),
        (200, format!("<body><p>Next</p>{tag}</body>")),
        "a page it links to gets the comment layer too"
    );
    assert_eq!(cget(&format!("/a/{id}/v1/next.html?raw")).1, "<body><p>Next</p></body>");
    assert_eq!(cget(&format!("/a/{id}/v1/..%2Fsecret.txt")).0, 404, "nothing outside its folder");
    assert_eq!(cget(&format!("/a/{id}/v1/../secret.txt")).0, 404);
    assert_eq!(cget(&format!("/a/{id}/v9/p.html")).0, 404);
    assert!(cget("/__herdr/overlay.js").1.contains("herdr-review-layer"));
    assert_eq!(http(content, "GET", "/__herdr/overlay.js", &[("Host", &host)], "").0, 403, "the wrong port");
    assert_eq!(get(&format!("/a/{id}/v1/p.html")).0, 404, "the review origin serves no artifact");
    assert_eq!(cget(&format!("/api/artifacts/{id}")).0, 404, "the content origin has no API");
    let from_artifact = [
        ("Host", host.as_str()),
        ("Origin", state["frame"]["origin"].as_str().unwrap()),
        ("Content-Type", "application/json"),
    ];
    let approve = r#"{"status":"approved"}"#;
    assert_eq!(
        http(port, "POST", &format!("/api/artifacts/{id}/status"), &from_artifact, approve).0,
        403,
        "an artifact's own script cannot call the API"
    );
    let to_content = [("Host", chost.as_str()), ("Origin", origin.as_str()), ("Content-Type", "application/json")];
    assert_ne!(http(content, "POST", &format!("/api/artifacts/{id}/status"), &to_content, approve).0, 200);
    let form = [("Host", host.as_str()), ("Origin", origin.as_str()), ("Content-Type", "text/plain")];
    assert_eq!(http(port, "POST", &format!("/api/artifacts/{id}/status"), &form, approve).0, 403);

    let anchor = r#"{"kind":"element","selector":"body > a","label":"a.btn","text":"Talk","x":0.5,"y":0.5}"#;
    let comment = format!(r#"{{"body":"Say Book a demo","version":1,"to_agent":true,"anchor":{anchor}}}"#);
    let (code, made) = post(&format!("/api/artifacts/{id}/comments"), &comment);
    let made: Value = serde_json::from_str(&made).unwrap();
    assert_eq!(
        (code, made["delivered"].as_bool(), made["comment"]["anchor"]["selector"].as_str()),
        (200, Some(true), Some("body > a"))
    );
    assert_eq!(made["comment"]["author"], json!({ "kind": "person" }));
    assert!(
        fs::read_to_string(&log)
            .unwrap()
            .contains("Pinned on the element a.btn \"Talk\", 50% across and 50% down it (selector: body > a)")
    );
    let cid = made["comment"]["id"].as_str().unwrap();
    let thread = format!("/api/artifacts/{id}/comments/{cid}");
    let (_, replied) = post(&thread, r#"{"action":"reply","body":"Use option C"}"#);
    assert_eq!(serde_json::from_str::<Value>(&replied).unwrap()["delivered"], true, "a sent thread's reply is sent");
    let typed = fs::read_to_string(&log).unwrap();
    assert!(
        typed.contains("Reply in a comment thread on") && typed.contains("the person: \"Use option C\""),
        "{typed}"
    );
    assert_eq!(post(&format!("/api/artifacts/{id}/comments/{elsewhere}"), r#"{"action":"resolve"}"#).0, 404);
    assert_eq!(s.ok(None, &["show", &other])["comments"][0]["open"], true, "another artifact's comment is untouched");
    let outside = r#"{"body":"x","anchor":{"kind":"pin","x":2,"y":0.5,"label":null}}"#;
    assert_eq!(post(&format!("/api/artifacts/{id}/comments"), outside).0, 400, "a pin off the page");
    assert_eq!(post(&thread, r#"{"action":"resolve"}"#).0, 200);
    assert_eq!(s.ok(None, &["show", &id])["comments"][0]["open"], false);
    assert_eq!(post(&format!("/api/artifacts/{id}/status"), approve).0, 200);

    let stranger = [("Host", host.as_str()), ("Origin", "https://evil.example"), ("Content-Type", "application/json")];
    assert_eq!(http(port, "POST", &format!("/api/artifacts/{id}/comments"), &stranger, &comment).0, 403);
    assert_eq!(http(port, "GET", "/api/ping", &[("Host", "evil.example")], "").0, 403);
    assert_eq!(http(port, "GET", "/api/ping", &[("Host", &chost)], "").0, 403, "the content port's name");
    assert_eq!(s.ok(None, &["show", &id])["comments"].as_array().unwrap().len(), 1, "a refused post saves nothing");
}

#[cfg(unix)]
#[test]
fn a_comment_the_page_sends_to_a_shell_is_saved_and_not_typed() {
    let s = Scratch::new();
    let log = fake_hc(&s, json!({ "terminals": [{ "address": "t7" }] }));
    let id = s.ok(Some("t7"), &["publish", &s.file("p.html", "<a>x</a>")])["id"].as_str().unwrap().to_owned();
    let server = Server::start(&s);
    let host = server.host();
    let origin = format!("http://{host}");
    assert_eq!(server.state(&id)["agent"], json!({ "terminal": "t7", "state": "no_agent" }));
    let headers = [("Host", host.as_str()), ("Origin", origin.as_str()), ("Content-Type", "application/json")];
    let (code, made) = http(
        server.port,
        "POST",
        &format!("/api/artifacts/{id}/comments"),
        &headers,
        r#"{"body":"ls","to_agent":true}"#,
    );
    let made: Value = serde_json::from_str(&made).unwrap();
    assert_eq!((code, made["delivered"].as_bool()), (200, Some(false)));
    assert!(made["delivery_error"].as_str().unwrap().contains("not running an agent"), "{made}");
    assert!(!log.exists(), "nothing was typed");
    assert_eq!(s.ok(None, &["show", &id])["comments"][0]["sent_to_agent"], false);
}

#[cfg(unix)]
#[test]
fn a_live_page_is_served_through_a_proxy_that_adds_the_comment_layer() {
    use std::io::{Read, Write};
    let dev = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let dev_port = dev.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in dev.incoming().flatten() {
            let mut request = [0u8; 2048];
            let n = stream.read(&mut request).unwrap_or(0);
            let asked = String::from_utf8_lossy(&request[..n]).into_owned();
            let body = format!(
                "<html><body><h1>Dev</h1><!--{}--></body></html>",
                asked.lines().find(|l| l.to_lowercase().starts_with("host:")).unwrap_or("")
            );
            let _ = stream.write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Security-Policy: default-src 'self'\r\nX-Frame-Options: DENY\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n", body.len()).as_bytes(),
            );
        }
    });

    let s = Scratch::new();
    fake_hc(&s, json!({ "terminals": [] }));
    let url = format!("http://127.0.0.1:{dev_port}/pricing");
    let published = s.ok(Some("t7"), &["publish", "--url", &url, "--title", "Pricing"]);
    assert_eq!((published["version"].as_u64(), published["url"].as_str()), (Some(1), Some(url.as_str())));
    let id = published["id"].as_str().unwrap().to_owned();
    assert_eq!(s.ok(Some("t7"), &["publish", "--url", &url, "-m", "again"])["version"], 2, "always a new version");
    assert_eq!(s.ok(None, &["show", &id])["artifact"]["kind"], "url");
    assert_eq!(s.run(None, &["publish", "--url", "https://example.com"]).0, 1, "only plain http dev servers");
    let both = Command::new(env!("CARGO_BIN_EXE_herdr-artifact"))
        .args(["publish", "--url", &url, &s.file("x.md", "x")])
        .env("HERDR_ARTIFACTS_HOME", s.0.join("store"))
        .output()
        .unwrap();
    assert_eq!(both.status.code(), Some(2), "a file or a url, not both");

    let server = Server::start(&s);
    let state = server.state(&id);
    assert_eq!((state["frame"]["path"].as_str(), state["agent"]["state"].as_str()), (Some("/pricing"), Some("gone")));
    let proxy = port_of(&state["frame"]["origin"]);
    assert_eq!(port_of(&server.state(&id)["frame"]["origin"]), proxy, "one proxy per dev server");
    let host = format!("127.0.0.1:{proxy}");

    let mut stream = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
    stream
        .write_all(format!("GET /pricing HTTP/1.1\r\nHost: {host}\r\nAccept-Encoding: gzip\r\n\r\n").as_bytes())
        .unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let (head, body) = answer.split_once("\r\n\r\n").unwrap();
    let tag = format!("<script src=\"/__herdr/overlay.js\" data-review=\"http://{}\"></script></body>", server.host());
    assert!(body.contains("<h1>Dev</h1>") && body.contains(&tag), "{body}");
    assert!(body.contains(&format!("Host: 127.0.0.1:{dev_port}")), "the dev server is asked by its own name: {body}");
    let lower = head.to_lowercase();
    assert!(
        !lower.contains("content-security-policy") && !lower.contains("x-frame-options") && !lower.contains("chunked"),
        "{head}"
    );
    assert!(head.contains(&format!("Content-Length: {}", body.len())), "{head}");

    assert!(http(proxy, "GET", "/__herdr/overlay.js", &[("Host", &host)], "").1.contains("herdr-review-layer"));
    assert_eq!(http(proxy, "GET", "/", &[("Host", "evil.example")], "").0, 403);
    assert_eq!(http(proxy, "GET", "/", &[("Host", &server.host())], "").0, 403, "the review port's name");
}

#[cfg(unix)]
#[test]
fn a_websocket_upgrade_is_tunnelled_through_the_proxy_both_ways() {
    use std::io::{Read, Write};
    let dev = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let dev_port = dev.local_addr().unwrap().port();
    let (seen_tx, seen_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (mut stream, _) = dev.accept().unwrap();
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap() == 1 {
            head.push(byte[0]);
        }
        seen_tx.send(String::from_utf8_lossy(&head).into_owned()).unwrap();
        stream
            .write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello")
            .unwrap();
        let mut echo = [0u8; 64];
        while let Ok(n) = stream.read(&mut echo) {
            if n == 0 || stream.write_all(&echo[..n]).is_err() {
                break;
            }
        }
    });

    let s = Scratch::new();
    fake_hc(&s, json!({ "terminals": [] }));
    let id =
        s.ok(None, &["publish", "--url", &format!("http://127.0.0.1:{dev_port}/")])["id"].as_str().unwrap().to_owned();
    let server = Server::start(&s);
    let proxy = port_of(&server.state(&id)["frame"]["origin"]);

    let mut socket = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
    socket.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
    socket
        .write_all(
            format!("GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:{proxy}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\n\r\n")
                .as_bytes(),
        )
        .unwrap();
    let asked = seen_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(asked.contains("Upgrade: websocket") && asked.contains("Connection: Upgrade"), "{asked}");
    assert!(asked.contains(&format!("Host: 127.0.0.1:{dev_port}")), "{asked}");

    let mut got = Vec::new();
    let mut chunk = [0u8; 256];
    while !got.ends_with(b"hello") {
        let n = socket.read(&mut chunk).unwrap();
        assert_ne!(n, 0, "closed early: {}", String::from_utf8_lossy(&got));
        got.extend_from_slice(&chunk[..n]);
    }
    assert!(got.starts_with(b"HTTP/1.1 101"), "{}", String::from_utf8_lossy(&got));

    socket.write_all(b"ping from the page").unwrap();
    let mut echoed = Vec::new();
    while echoed.len() < b"ping from the page".len() {
        let n = socket.read(&mut chunk).unwrap();
        assert_ne!(n, 0);
        echoed.extend_from_slice(&chunk[..n]);
    }
    assert_eq!(echoed, b"ping from the page");
}
