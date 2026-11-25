use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::http::{self, Code, Head};
use crate::model::Upstream;
use crate::server::Site;

pub const OVERLAY: &str = include_str!("web/overlay.js");
const OVERLAY_PATH: &str = "/__herdr/overlay.js";
const BODY_END_TAG: &[u8] = b"</body>";
const MAX_PROXIED_BODY: usize = 64 * 1024 * 1024;
const CLIENT_TIMEOUT: Duration = Duration::from_secs(30);
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(60);
const LOOPBACK: &str = "127.0.0.1";
const ANY_PORT: u16 = 0;

const DROPPED_REQUEST_HEADERS: [&str; 2] = ["host", "accept-encoding"];
const HOP_HEADERS: [&str; 2] = ["connection", "keep-alive"];
const DROPPED_RESPONSE_HEADERS: [&str; 7] = [
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
];
const BODILESS_STATUSES: [&str; 2] = ["204", "304"];

#[derive(Default)]
pub struct Proxies {
    running: Mutex<HashMap<Upstream, u16>>,
}

pub fn port_for(site: &Arc<Site>, upstream: &Upstream) -> Result<u16, String> {
    let mut running = site.proxies.running.lock().map_err(|_| "the proxy table is poisoned")?;
    if let Some(port) = running.get(upstream) {
        return Ok(*port);
    }
    let first = TcpListener::bind((LOOPBACK, ANY_PORT)).map_err(|e| format!("cannot start a proxy: {e}"))?;
    let port = first.local_addr().map_err(|e| e.to_string())?.port();
    let mut listeners = vec![first];
    listeners.extend(
        site.reach.addresses.iter().filter(|a| !a.is_loopback()).filter_map(|a| TcpListener::bind((*a, port)).ok()),
    );
    for listener in listeners {
        let (site, upstream) = (Arc::clone(site), upstream.clone());
        thread::spawn(move || {
            for client in listener.incoming().flatten() {
                let (site, upstream) = (Arc::clone(&site), upstream.clone());
                thread::spawn(move || {
                    let _ = serve_one(client, &upstream, port, &site);
                });
            }
        });
    }
    running.insert(upstream.clone(), port);
    Ok(port)
}

fn serve_one(mut client: TcpStream, up: &Upstream, port: u16, site: &Site) -> io::Result<()> {
    client.set_read_timeout(Some(CLIENT_TIMEOUT))?;
    let Some((request, body)) = http::read_head(&mut client) else { return Ok(()) };
    let host = request.get("host").unwrap_or_default().to_owned();
    let Some(name) = site.reach.name_for(&host, port) else {
        return http::respond(&mut client, Code::Forbidden, "text/plain", b"unknown host");
    };
    let review = site.reach.review_origin(name);
    if http::path_and_query(request.target()).0 == OVERLAY_PATH {
        return http::respond(&mut client, Code::Ok, "text/javascript; charset=utf-8", OVERLAY.as_bytes());
    }
    let websocket = request.get("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let mut upstream = match TcpStream::connect((up.host.as_str(), up.port)) {
        Ok(stream) => stream,
        Err(e) => {
            let text = format!(
                "herdr-artifact: nothing is listening at {} ({e}). Start the dev server, then reload.",
                up.origin()
            );
            return http::respond(&mut client, Code::BadGateway, "text/plain; charset=utf-8", text.as_bytes());
        }
    };
    upstream.write_all(forwarded_head(&request, up, &host, websocket).as_bytes())?;
    if websocket {
        upstream.write_all(&body)?;
        return tunnel(client, upstream);
    }
    let length = request.content_length().unwrap_or_default().min(MAX_PROXIED_BODY);
    upstream.write_all(&http::read_body(&mut client, body, length)?)?;

    upstream.set_read_timeout(Some(UPSTREAM_TIMEOUT))?;
    let Some((response, mut payload)) = http::read_head(&mut upstream) else {
        return http::respond(&mut client, Code::BadGateway, "text/plain", b"the dev server sent no answer");
    };
    upstream.take(MAX_PROXIED_BODY as u64).read_to_end(&mut payload)?;
    if response.has_token("transfer-encoding", "chunked") {
        payload = unchunk(&payload);
    }
    if response.get("content-type").is_some_and(|t| t.to_ascii_lowercase().starts_with("text/html")) {
        payload = inject(&payload, &review);
    }
    let bodiless = request.method() == "HEAD"
        || response.first.split_whitespace().nth(1).is_some_and(|s| BODILESS_STATUSES.contains(&s));
    client.write_all(returned_head(&response, up, &host, (!bodiless).then_some(payload.len())).as_bytes())?;
    if bodiless { Ok(()) } else { client.write_all(&payload) }
}

fn forwarded_head(request: &Head, up: &Upstream, host: &str, websocket: bool) -> String {
    let mut head = format!("{}\r\nHost: {}:{}\r\n", request.first, up.host, up.port);
    for (name, value) in &request.headers {
        let lower = name.to_ascii_lowercase();
        if DROPPED_REQUEST_HEADERS.contains(&lower.as_str()) || (!websocket && HOP_HEADERS.contains(&lower.as_str())) {
            continue;
        }
        let value = if lower == "origin" || lower == "referer" {
            value.replace(&format!("http://{host}"), &up.origin())
        } else {
            value.clone()
        };
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !websocket {
        head.push_str("Connection: close\r\n");
    }
    head.push_str("\r\n");
    head
}

fn returned_head(response: &Head, up: &Upstream, host: &str, length: Option<usize>) -> String {
    let mut out = format!("{}\r\n", response.first);
    for (name, value) in &response.headers {
        let lower = name.to_ascii_lowercase();
        if DROPPED_RESPONSE_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        let value =
            if lower == "location" { value.replace(&up.origin(), &format!("http://{host}")) } else { value.clone() };
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(length) = length {
        out.push_str(&format!("Content-Length: {length}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    out
}

fn tunnel(client: TcpStream, upstream: TcpStream) -> io::Result<()> {
    client.set_read_timeout(None)?;
    upstream.set_read_timeout(None)?;
    let (mut client_in, mut upstream_out) = (client.try_clone()?, upstream.try_clone()?);
    let up = thread::spawn(move || {
        let _ = io::copy(&mut client_in, &mut upstream_out);
        let _ = upstream_out.shutdown(Shutdown::Write);
    });
    let (mut upstream_in, mut client_out) = (upstream, client);
    let _ = io::copy(&mut upstream_in, &mut client_out);
    let _ = client_out.shutdown(Shutdown::Both);
    let _ = up.join();
    Ok(())
}

fn unchunk(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut at = 0;
    while let Some(line_end) = raw[at..].windows(2).position(|w| w == b"\r\n") {
        let size_text = String::from_utf8_lossy(&raw[at..at + line_end]);
        let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or_default().trim(), 16) else {
            break;
        };
        let start = at + line_end + 2;
        if size == 0 || start + size > raw.len() {
            break;
        }
        out.extend_from_slice(&raw[start..start + size]);
        at = start + size + 2;
        if at > raw.len() {
            break;
        }
    }
    out
}

pub fn inject(html: &[u8], review: &str) -> Vec<u8> {
    let tag = format!("<script src=\"{OVERLAY_PATH}\" data-review=\"{review}\"></script>");
    let lower = html.to_ascii_lowercase();
    let at = lower.windows(BODY_END_TAG.len()).rposition(|w| w == BODY_END_TAG).unwrap_or(html.len());
    [&html[..at], tag.as_bytes(), &html[at..]].concat()
}

#[cfg(test)]
mod tests {
    use super::{inject, unchunk};

    #[test]
    fn the_script_goes_before_the_closing_body_tag_or_at_the_end() {
        let tag = "<script src=\"/__herdr/overlay.js\" data-review=\"http://r\"></script>";
        assert_eq!(
            inject(b"<body><p>hi</p></BODY></html>", "http://r"),
            format!("<body><p>hi</p>{tag}</BODY></html>").into_bytes()
        );
        assert_eq!(inject(b"<p>bare", "http://r"), format!("<p>bare{tag}").into_bytes());
    }

    #[test]
    fn chunked_bodies_are_joined() {
        assert_eq!(unchunk(b"5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n"), b"hello world");
        assert_eq!(unchunk(b"zz\r\nnope"), b"");
    }
}
