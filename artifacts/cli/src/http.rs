use std::io::{self, Read, Write};

const MAX_HEAD: usize = 64 * 1024;
const READ_CHUNK: usize = 8 * 1024;
const HEAD_END: &[u8] = b"\r\n\r\n";
const LINE_END: &str = "\r\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    Ok,
    BadRequest,
    Forbidden,
    NotFound,
    BadGateway,
}

impl Code {
    fn line(self) -> &'static str {
        match self {
            Self::Ok => "200 OK",
            Self::BadRequest => "400 Bad Request",
            Self::Forbidden => "403 Forbidden",
            Self::NotFound => "404 Not Found",
            Self::BadGateway => "502 Bad Gateway",
        }
    }
}

pub struct Head {
    pub first: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }

    pub fn method(&self) -> &str {
        self.first.split_whitespace().next().unwrap_or_default()
    }

    pub fn target(&self) -> &str {
        self.first.split_whitespace().nth(1).unwrap_or_default()
    }

    pub fn content_length(&self) -> Option<usize> {
        self.get("content-length").and_then(|l| l.parse().ok())
    }

    pub fn has_token(&self, name: &str, token: &str) -> bool {
        self.get(name).is_some_and(|v| v.split(',').any(|t| t.trim().eq_ignore_ascii_case(token)))
    }
}

pub fn read_head(stream: &mut impl Read) -> Option<(Head, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; READ_CHUNK];
    let end = loop {
        if let Some(at) = buffer.windows(HEAD_END.len()).position(|w| w == HEAD_END) {
            break at;
        }
        if buffer.len() > MAX_HEAD {
            return None;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
    };
    let text = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = text.split(LINE_END);
    let first = lines.next()?.to_owned();
    let headers =
        lines.filter_map(|l| l.split_once(':')).map(|(n, v)| (n.trim().to_owned(), v.trim().to_owned())).collect();
    Some((Head { first, headers }, buffer[end + HEAD_END.len()..].to_vec()))
}

pub fn read_body(stream: &mut impl Read, mut body: Vec<u8>, length: usize) -> io::Result<Vec<u8>> {
    let mut chunk = [0u8; READ_CHUNK];
    while body.len() < length {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(length);
    Ok(body)
}

pub fn respond(stream: &mut impl Write, code: Code, content_type: &str, body: &[u8]) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        code.line(),
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)
}

pub fn path_and_query(target: &str) -> (&str, &str) {
    let target = target.split('#').next().unwrap_or_default();
    target.split_once('?').unwrap_or((target, ""))
}

pub fn segments(path: &str) -> Option<Vec<String>> {
    path.split('/').filter(|s| !s.is_empty()).map(percent_decode).collect()
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn content_type(name: &str) -> &'static str {
    match name.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "pdf" => "application/pdf",
        _ => "text/plain; charset=utf-8",
    }
}

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

#[cfg(test)]
mod tests {
    use super::{content_type, path_and_query, read_head, segments};

    #[test]
    fn paths_decode_and_a_bad_escape_is_refused() {
        assert_eq!(segments("/a/b%20c/%2E%2E%2Fx"), Some(vec!["a".into(), "b c".into(), "../x".into()]));
        assert_eq!(segments("/%zz"), None);
        assert_eq!(path_and_query("/a?raw#top"), ("/a", "raw"));
    }

    #[test]
    fn files_get_their_type_from_the_extension() {
        assert_eq!(
            (content_type("a.HTML"), content_type("a.png"), content_type("a")),
            ("text/html; charset=utf-8", "image/png", "text/plain; charset=utf-8")
        );
    }

    #[test]
    fn a_head_is_read_with_the_body_bytes_that_came_with_it() {
        let raw = b"GET /x HTTP/1.1\r\nHost: a:1\r\nConnection: keep-alive, Upgrade\r\n\r\nbody";
        let (head, rest) = read_head(&mut raw.as_slice()).unwrap();
        assert_eq!((head.method(), head.target(), head.get("HOST")), ("GET", "/x", Some("a:1")));
        assert!(head.has_token("connection", "upgrade") && rest == b"body");
        assert!(read_head(&mut b"GET / HTTP/1.1\r\n".as_slice()).is_none());
    }
}
