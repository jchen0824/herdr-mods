use std::io::Write;
use std::net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::{self, TerminalState};
use crate::http::{self, Code, Head};
use crate::model::{Anchor, ArtifactId, Author, Comment, Draft, Kind, Status, parse_url};
use crate::ops::{self, NewComment, Out};
use crate::store::Store;
use crate::{proxy, time};

pub const DEFAULT_PORT: u16 = 7501;
const LOOPBACK: &str = "127.0.0.1";
const LOCALHOST: &str = "localhost";
const ANY_PORT: u16 = 0;
const MAX_REQUEST_BODY: usize = 1 << 20;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const JSON: &str = "application/json";
const HTML: &str = "text/html; charset=utf-8";
const JAVASCRIPT: &str = "text/javascript; charset=utf-8";
const CSS: &str = "text/css; charset=utf-8";
const SVG: &str = "image/svg+xml";
const EMPTY_SVG: &str = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>";

pub struct Reach {
    pub names: Vec<String>,
    pub addresses: Vec<IpAddr>,
    pub review: u16,
    pub content: u16,
}

pub struct Site {
    pub reach: Reach,
    pub proxies: proxy::Proxies,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Review,
    Content,
}

struct Request {
    method: String,
    path: String,
    query: String,
    host: String,
    origin: Option<String>,
    json_body: bool,
    body: Vec<u8>,
}

struct Response {
    code: Code,
    content_type: &'static str,
    body: Vec<u8>,
}

enum Refusal {
    NotFound,
    Bad(String),
}

impl From<String> for Refusal {
    fn from(why: String) -> Self {
        Self::Bad(why)
    }
}

#[derive(Serialize)]
struct AgentView {
    terminal: String,
    #[serde(flatten)]
    state: TerminalState,
}

#[derive(Deserialize)]
struct CommentBody {
    body: String,
    version: Option<u32>,
    anchor: Option<Anchor>,
    #[serde(default)]
    to_agent: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CommentAction {
    Resolve,
    Reopen,
    Reply { body: String },
}

#[derive(Deserialize)]
struct StatusBody {
    status: Status,
}

impl Reach {
    pub fn name_for(&self, host: &str, port: u16) -> Option<&str> {
        let (name, given) = host.rsplit_once(':')?;
        let name = name.trim_start_matches('[').trim_end_matches(']');
        if given.parse() != Ok(port) {
            return None;
        }
        self.names.iter().find(|n| n.eq_ignore_ascii_case(name)).map(String::as_str)
    }

    pub fn review_origin(&self, name: &str) -> String {
        format!("http://{name}:{}", self.review)
    }
}

fn reply(code: Code, content_type: &'static str, body: impl Into<Vec<u8>>) -> Response {
    Response { code, content_type, body: body.into() }
}

fn json_reply(value: &Value) -> Response {
    reply(Code::Ok, JSON, value.to_string())
}

fn refuse(code: Code, why: &str) -> Response {
    reply(code, JSON, json!({ "error": why }).to_string())
}

fn bind_extra(host: &str, port: u16, content: u16) -> Result<Vec<(IpAddr, TcpListener, Option<TcpListener>)>, String> {
    let found: Vec<_> = (host, port).to_socket_addrs().map_err(|e| format!("cannot find {host}: {e}"))?.collect();
    let bound: Vec<_> = found
        .iter()
        .filter(|a| !a.ip().is_loopback() && !a.ip().is_unspecified())
        .filter_map(|a| TcpListener::bind(a).ok().map(|l| (a.ip(), l, TcpListener::bind((a.ip(), content)).ok())))
        .collect();
    if bound.is_empty() {
        return Err(format!("{host} is not an address of this computer that can be listened on"));
    }
    Ok(bound)
}

pub fn serve(port: u16, hosts: &[String], json: bool) -> Result<Out, String> {
    let local = TcpListener::bind((LOOPBACK, port)).map_err(|e| format!("cannot listen on {LOOPBACK}:{port}: {e}"))?;
    let address = local.local_addr().map_err(|e| e.to_string())?;
    let content_local =
        TcpListener::bind((LOOPBACK, ANY_PORT)).map_err(|e| format!("cannot listen for artifacts: {e}"))?;
    let content = content_local.local_addr().map_err(|e| e.to_string())?.port();
    let mut names = vec![LOOPBACK.to_owned(), LOCALHOST.to_owned()];
    let mut addresses = vec![address.ip()];
    let mut listeners = vec![(local, Side::Review), (content_local, Side::Content)];
    for host in hosts {
        let host = host.trim_end_matches('.');
        for (ip, review, content) in bind_extra(host, address.port(), content)? {
            addresses.push(ip);
            listeners.push((review, Side::Review));
            listeners.extend(content.map(|c| (c, Side::Content)));
        }
        names.push(host.to_owned());
    }
    let reach = Reach { names, addresses, review: address.port(), content };
    let urls: Vec<String> = reach.names.iter().filter(|n| *n != LOCALHOST).map(|n| reach.review_origin(n)).collect();
    if json {
        println!("{}", json!({ "url": urls[0], "urls": urls, "port": reach.review }));
    } else {
        println!("{}  (review pages: <url>/review/<artifact-id>; Ctrl-C stops)", urls.join("  "));
    }
    let _ = std::io::stdout().flush();
    let site = Arc::new(Site { reach, proxies: proxy::Proxies::default() });
    let workers: Vec<_> = listeners
        .into_iter()
        .map(|(listener, side)| {
            let site = Arc::clone(&site);
            thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let site = Arc::clone(&site);
                    thread::spawn(move || handle(stream, &site, side));
                }
            })
        })
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
    Ok(Out { json: json!({ "stopped": true }), text: "stopped".into() })
}

fn handle(mut stream: TcpStream, site: &Arc<Site>, side: Side) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let Some(request) = read_request(&mut stream) else { return };
    let port = match side {
        Side::Review => site.reach.review,
        Side::Content => site.reach.content,
    };
    let response = match (guard(&request, &site.reach, port), side) {
        (Some(refused), _) => refused,
        (None, Side::Review) => route(&request, site),
        (None, Side::Content) => content_route(&request, &site.reach),
    };
    let _ = http::respond(&mut stream, response.code, response.content_type, &response.body);
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    let (head, start): (Head, _) = http::read_head(stream)?;
    let length = head.content_length().unwrap_or_default();
    if length > MAX_REQUEST_BODY {
        return None;
    }
    let body = http::read_body(stream, start, length).ok()?;
    let (path, query) = http::path_and_query(head.target());
    Some(Request {
        method: head.method().to_owned(),
        path: path.to_owned(),
        query: query.to_owned(),
        host: head.get("host").unwrap_or_default().to_owned(),
        origin: head.get("origin").map(str::to_owned),
        json_body: head.get("content-type").is_some_and(|t| t.to_ascii_lowercase().starts_with(JSON)),
        body,
    })
}

fn guard(request: &Request, reach: &Reach, port: u16) -> Option<Response> {
    if reach.name_for(&request.host, port).is_none() {
        return Some(refuse(Code::Forbidden, "unknown host"));
    }
    match request.method.as_str() {
        "GET" => None,
        "POST" => {
            let own = request
                .origin
                .as_deref()
                .and_then(|o| o.strip_prefix("http://"))
                .is_some_and(|h| reach.name_for(h, reach.review).is_some());
            let allowed = own && request.json_body && port == reach.review;
            if allowed { None } else { Some(refuse(Code::Forbidden, "only the review page may change things")) }
        }
        _ => Some(refuse(Code::BadRequest, "GET or POST only")),
    }
}

fn artifact_id(text: &str) -> Result<ArtifactId, Refusal> {
    text.parse().map_err(|_| Refusal::NotFound)
}

fn route(request: &Request, site: &Arc<Site>) -> Response {
    let Some(segments) = http::segments(&request.path) else { return refuse(Code::BadRequest, "bad path") };
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
    let name = site.reach.name_for(&request.host, site.reach.review).unwrap_or(LOOPBACK);
    let result = Store::open().map_err(Refusal::from).and_then(|store| {
        let now = time::now();
        match (request.method.as_str(), segments.as_slice()) {
            ("GET", []) => index(&store),
            ("GET", ["review", _]) => Ok(reply(Code::Ok, HTML, include_str!("web/review.html"))),
            ("GET", ["__herdr", "review.js"]) => Ok(reply(Code::Ok, JAVASCRIPT, include_str!("web/review.js"))),
            ("GET", ["__herdr", "review.css"]) => Ok(reply(Code::Ok, CSS, include_str!("web/review.css"))),
            ("GET", ["favicon.ico"]) => Ok(reply(Code::Ok, SVG, EMPTY_SVG)),
            ("GET", ["api", "ping"]) => Ok(json_reply(&json!({ "ok": true, "name": "herdr-artifact" }))),
            ("GET", ["api", "artifacts"]) => Ok(json_reply(&ops::list(&store, None)?.json)),
            ("GET", ["api", "artifacts", id]) => state(&store, &artifact_id(id)?, site, name),
            ("POST", ["api", "artifacts", id, "comments"]) => {
                new_comment(&store, artifact_id(id)?, &request.body, &now)
            }
            ("POST", ["api", "artifacts", id, "comments", comment]) => {
                change_comment(&store, &artifact_id(id)?, comment, &request.body, &now)
            }
            ("POST", ["api", "artifacts", id, "status"]) => set_status(&store, &artifact_id(id)?, &request.body, &now),
            _ => Err(Refusal::NotFound),
        }
    });
    answer(result)
}

fn answer(result: Result<Response, Refusal>) -> Response {
    match result {
        Ok(response) => response,
        Err(Refusal::NotFound) => refuse(Code::NotFound, "not found"),
        Err(Refusal::Bad(why)) => refuse(Code::BadRequest, &why),
    }
}

fn content_route(request: &Request, reach: &Reach) -> Response {
    if request.method != "GET" {
        return refuse(Code::BadRequest, "GET only");
    }
    let Some(segments) = http::segments(&request.path) else { return refuse(Code::BadRequest, "bad path") };
    let segments: Vec<&str> = segments.iter().map(String::as_str).collect();
    let name = reach.name_for(&request.host, reach.content).unwrap_or(LOOPBACK);
    let review = reach.review_origin(name);
    let result = match segments.as_slice() {
        ["__herdr", "overlay.js"] => Ok(reply(Code::Ok, JAVASCRIPT, proxy::OVERLAY)),
        ["a", id, version, rest @ ..] if !rest.is_empty() => Store::open()
            .map_err(Refusal::from)
            .and_then(|store| file(&store, &artifact_id(id)?, version, rest, request.query == "raw", &review)),
        _ => Err(Refusal::NotFound),
    };
    result.unwrap_or_else(|_| refuse(Code::NotFound, "not found"))
}

fn index(store: &Store) -> Result<Response, Refusal> {
    let list = ops::list(store, None)?.json;
    let mut html = String::from(
        "<!doctype html><meta charset=utf-8><title>Artifacts</title><body style=\"font:14px system-ui;padding:32px\"><h1>Artifacts</h1><ul>",
    );
    for a in list.as_array().into_iter().flatten() {
        let (id, title) = (a["id"].as_str().unwrap_or_default(), http::escape(a["title"].as_str().unwrap_or_default()));
        html.push_str(&format!(
            "<li><a href=\"/review/{id}\">{title}</a> v{} · {}</li>",
            a["version"],
            a["status"].as_str().unwrap_or_default()
        ));
    }
    html.push_str("</ul></body>");
    Ok(reply(Code::Ok, HTML, html))
}

fn state(store: &Store, id: &ArtifactId, site: &Arc<Site>, name: &str) -> Result<Response, Refusal> {
    if !store.exists(id) {
        return Err(Refusal::NotFound);
    }
    let artifact = store.artifact(id)?;
    let mut shown = ops::show(store, id)?.json;
    shown["frame"] = if artifact.kind == Kind::Url {
        let (upstream, path) = parse_url(&artifact.source)?;
        let port = proxy::port_for(site, &upstream)?;
        json!({ "origin": format!("http://{name}:{port}"), "path": path })
    } else {
        json!({ "origin": format!("http://{name}:{}", site.reach.content) })
    };
    shown["agent"] = match artifact.first_publisher {
        Some(terminal) => {
            let state = agent::status(&terminal);
            serde_json::to_value(AgentView { terminal, state }).map_err(|e| e.to_string())?
        }
        None => Value::Null,
    };
    Ok(json_reply(&shown))
}

fn file(
    store: &Store,
    id: &ArtifactId,
    version: &str,
    rest: &[&str],
    raw: bool,
    review: &str,
) -> Result<Response, Refusal> {
    let artifact = store.artifact(id).map_err(|_| Refusal::NotFound)?;
    if artifact.kind == Kind::Url {
        return Err(Refusal::NotFound);
    }
    let n: u32 = version.strip_prefix('v').and_then(|v| v.parse().ok()).ok_or(Refusal::NotFound)?;
    let found = artifact.versions.iter().find(|v| v.n == n).ok_or(Refusal::NotFound)?;
    let is_snapshot = rest == [found.file.as_str()];
    let path = if is_snapshot {
        store.version_path(id, n, &found.file)
    } else {
        beside(Path::new(&artifact.source), rest).ok_or(Refusal::NotFound)?
    };
    let body = std::fs::read(&path).map_err(|_| Refusal::NotFound)?;
    let name = rest.last().copied().unwrap_or_default();
    let kind = http::content_type(name);
    if raw || (!is_snapshot && kind != HTML) {
        return Ok(reply(Code::Ok, kind, body));
    }
    let page = if kind == HTML {
        body
    } else if kind.starts_with("image/") {
        wrap(&format!(
            "<div style=\"display:grid;place-items:center;min-height:100vh\"><img src=\"{}?raw\" alt=\"\" style=\"max-width:100%\"></div>",
            http::escape(name)
        ))
    } else if kind.starts_with("text/") || kind == JSON {
        wrap(&format!(
            "<pre style=\"margin:0;padding:24px;white-space:pre-wrap;font:13px/1.55 ui-monospace,Menlo,monospace\">{}</pre>",
            http::escape(&String::from_utf8_lossy(&body))
        ))
    } else {
        return Ok(reply(Code::Ok, kind, body));
    };
    Ok(reply(Code::Ok, HTML, proxy::inject(&page, review)))
}

fn beside(source: &Path, rest: &[&str]) -> Option<PathBuf> {
    if !source.is_absolute() || rest.iter().any(|s| *s == ".." || *s == "." || s.contains(['/', '\\'])) {
        return None;
    }
    let folder = source.parent()?.canonicalize().ok()?;
    let wanted = rest.iter().fold(folder.clone(), |p, s| p.join(s)).canonicalize().ok()?;
    wanted.starts_with(&folder).then_some(wanted)
}

fn wrap(inner: &str) -> Vec<u8> {
    format!("<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><body style=\"margin:0;background:#fff;color:#1d1d1f\">{inner}</body>")
        .into_bytes()
}

fn parse<'a, T: Deserialize<'a>>(body: &'a [u8]) -> Result<T, Refusal> {
    serde_json::from_slice(body).map_err(|e| Refusal::Bad(format!("bad request body: {e}")))
}

fn with_delivery(mut made: Value, delivery: Result<Out, String>) -> Value {
    match delivery {
        Ok(_) => made["delivered"] = json!(true),
        Err(error) => {
            made["delivered"] = json!(false);
            made["delivery_error"] = json!(error);
        }
    }
    made
}

fn new_comment(store: &Store, artifact: ArtifactId, body: &[u8], now: &str) -> Result<Response, Refusal> {
    let given: CommentBody = parse(body)?;
    let text = given.body.trim();
    if text.is_empty() {
        return Err(Refusal::Bad("body is missing".into()));
    }
    let draft = Draft { anchor: given.anchor, body: text.to_owned(), author: Author::Person };
    let made = ops::comment(store, NewComment { artifact, version: given.version, draft }, now)?.json;
    if !given.to_agent {
        return Ok(json_reply(&made));
    }
    let comment = made["comment"]["id"].as_str().unwrap_or_default().to_owned();
    Ok(json_reply(&with_delivery(made, ops::send_and_request_changes(store, &comment, now))))
}

fn change_comment(
    store: &Store,
    artifact: &ArtifactId,
    comment: &str,
    body: &[u8],
    now: &str,
) -> Result<Response, Refusal> {
    let action: CommentAction = parse(body)?;
    if store.owner_of(comment).ok().as_ref() != Some(artifact) {
        return Err(Refusal::NotFound);
    }
    let replied = matches!(action, CommentAction::Reply { .. });
    let changed = ops::change_comment(store, comment, |c| match action {
        CommentAction::Resolve => {
            c.resolve(None);
            "resolved"
        }
        CommentAction::Reopen => {
            c.reopen();
            "reopened"
        }
        CommentAction::Reply { body } => {
            c.reply(Author::Person, body, now);
            "replied"
        }
    })?
    .json;
    let sent = serde_json::from_value::<Comment>(changed["comment"].clone()).is_ok_and(|c| c.sent_to_agent);
    if replied && sent {
        return Ok(json_reply(&with_delivery(changed, ops::send_and_request_changes(store, comment, now))));
    }
    Ok(json_reply(&changed))
}

fn set_status(store: &Store, id: &ArtifactId, body: &[u8], now: &str) -> Result<Response, Refusal> {
    let StatusBody { status } = parse(body)?;
    Ok(json_reply(&ops::set_status(store, id, status, now)?.json))
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr};
    use std::path::Path;

    use super::{Reach, Request, beside, guard};

    const REVIEW: u16 = 7501;
    const CONTENT: u16 = 7502;

    fn reach() -> Reach {
        Reach {
            names: vec!["127.0.0.1".into(), "localhost".into()],
            addresses: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
            review: REVIEW,
            content: CONTENT,
        }
    }

    fn request(method: &str, host: &str, origin: Option<&str>, json_body: bool) -> Request {
        Request {
            method: method.into(),
            path: "/".into(),
            query: String::new(),
            host: host.into(),
            origin: origin.map(str::to_owned),
            json_body,
            body: Vec::new(),
        }
    }

    #[test]
    fn only_this_computers_review_page_may_post() {
        let allowed = |r: Request, port| guard(&r, &reach(), port).is_none();
        assert!(allowed(request("GET", "127.0.0.1:7501", None, false), REVIEW));
        assert!(allowed(request("POST", "localhost:7501", Some("http://localhost:7501"), true), REVIEW));
        assert!(!allowed(request("GET", "evil.example:7501", None, false), REVIEW), "a name pointed at 127.0.0.1");
        assert!(!allowed(request("GET", "127.0.0.1:7502", None, false), REVIEW), "the wrong port");
        assert!(!allowed(request("POST", "127.0.0.1:7501", Some("https://evil.example"), true), REVIEW));
        assert!(!allowed(request("POST", "127.0.0.1:7501", Some("http://127.0.0.1:7502"), true), REVIEW));
        assert!(!allowed(request("POST", "127.0.0.1:7501", None, true), REVIEW), "no origin");
        assert!(!allowed(request("POST", "127.0.0.1:7501", Some("http://127.0.0.1:7501"), false), REVIEW));
        assert!(!allowed(request("POST", "127.0.0.1:7502", Some("http://127.0.0.1:7501"), true), CONTENT));
        assert!(!allowed(request("DELETE", "127.0.0.1:7501", Some("http://127.0.0.1:7501"), true), REVIEW));
    }

    #[test]
    fn files_beside_an_artifact_stay_in_its_folder() {
        let here = std::env::current_dir().unwrap().join("Cargo.toml");
        assert_eq!(beside(&here, &["src", "main.rs"]), here.parent().unwrap().join("src/main.rs").canonicalize().ok());
        assert_eq!(beside(&here, &["..", "cli"]), None);
        assert_eq!(beside(&here, &["src/../.."]), None);
        assert_eq!(beside(Path::new("relative/x.html"), &["x.css"]), None);
    }
}
