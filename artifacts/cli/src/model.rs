//! The store's types and every decision about them. No IO here: `store.rs` reads and writes.

use clap::ValueEnum;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
#[serde(rename_all = "snake_case")]
#[value(rename_all = "snake_case")]
pub enum Status {
    /// The agent is still changing it.
    Working,
    /// Published and waiting for a person.
    Ready,
    /// A person asked for changes.
    ChangesRequested,
    Approved,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Html,
    Markdown,
    Image,
    Svg,
    Pdf,
    Code,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Artifact {
    pub id: String,
    pub title: String,
    /// The file it was published from, absolute, on the machine that holds this store.
    pub source: String,
    pub kind: Kind,
    pub status: Status,
    /// The terminal that first published it (`HC_TERMINAL_ID`), when there was one.
    pub terminal: Option<String>,
    pub created: String,
    pub updated: String,
    pub versions: Vec<Version>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Version {
    pub n: u32,
    pub at: String,
    /// The snapshot's file name inside `v<n>/`.
    pub file: String,
    /// FNV-1a of the content: tells an unchanged publish from a new version.
    pub hash: String,
    pub note: Option<String>,
    /// Comments this version says it resolves.
    #[serde(default)]
    pub resolves: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Comments {
    pub comments: Vec<Comment>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Comment {
    pub id: String,
    /// The version it was written on.
    pub version: u32,
    pub anchor: Option<Anchor>,
    pub body: String,
    /// A terminal address for an agent, `user` for the person.
    pub author: String,
    /// Sent to the publishing agent, not only kept as a note.
    pub to_agent: bool,
    pub at: String,
    pub open: bool,
    /// The version that resolved it, when a publish did.
    pub resolved_in: Option<u32>,
    #[serde(default)]
    pub replies: Vec<Reply>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Anchor {
    /// A point on the rendered artifact, as fractions of its width and height.
    Pin { x: f64, y: f64, label: Option<String> },
    /// Quoted text, with the 1-based source line when known.
    Text { quote: String, line: Option<u32> },
    /// An element of a live page: how to find it again, what it said, and where in it the click was
    /// (fractions of its width and height).
    Element { selector: String, label: Option<String>, text: Option<String>, x: f64, y: f64 },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Reply {
    pub author: String,
    pub body: String,
    pub at: String,
}

pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// Lowercase letters, digits and single dashes; `artifact` when nothing is left.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() { "artifact".into() } else { out.chars().take(40).collect() }
}

/// One artifact per source file: the same path always publishes to the same id.
pub fn artifact_id(source: &str, stem: &str) -> String {
    format!("{}-{:08x}", slug(stem).trim_end_matches('-'), fnv1a(source.as_bytes()) as u32)
}

/// Ids name folders, so nothing but a slug may be one.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn kind_of(file_name: &str) -> Kind {
    let ext = file_name.rsplit_once('.').map_or("", |(_, e)| e).to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => Kind::Html,
        "md" | "markdown" | "mdx" => Kind::Markdown,
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Kind::Image,
        "svg" => Kind::Svg,
        "pdf" => Kind::Pdf,
        "rs" | "js" | "mjs" | "ts" | "tsx" | "jsx" | "py" | "go" | "json" | "toml" | "yaml" | "yml" | "css" | "sh"
        | "sql" | "txt" => Kind::Code,
        _ => Kind::Other,
    }
}

/// `0.42,0.31`: fractions of the rendered width and height.
pub fn parse_pin(text: &str) -> Result<(f64, f64), String> {
    let bad = || format!("--pin wants X,Y as fractions from 0 to 1 (got {text})");
    let (x, y) = text.split_once(',').ok_or_else(bad)?;
    let (x, y) = (x.trim().parse::<f64>().map_err(|_| bad())?, y.trim().parse::<f64>().map_err(|_| bad())?);
    if (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y) { Ok((x, y)) } else { Err(bad()) }
}

impl Artifact {
    pub fn new(id: String, title: String, source: String, terminal: Option<String>, now: &str) -> Self {
        let kind = kind_of(&source);
        Self {
            id,
            title,
            source,
            kind,
            status: Status::Working,
            terminal,
            created: now.into(),
            updated: now.into(),
            versions: Vec::new(),
        }
    }

    pub fn latest(&self) -> u32 {
        self.versions.last().map_or(0, |v| v.n)
    }

    /// Records a publish and returns its version and whether that version is new. Content equal to the
    /// latest version makes no new one: its note and resolved comments are added to the latest.
    pub fn publish(
        &mut self,
        file: &str,
        hash: &str,
        note: Option<String>,
        resolves: &[String],
        now: &str,
    ) -> (u32, bool) {
        self.updated = now.into();
        let is_new = self.versions.last().is_none_or(|v| v.hash != hash);
        if is_new {
            let n = self.latest() + 1;
            self.versions.push(Version {
                n,
                at: now.into(),
                file: file.into(),
                hash: hash.into(),
                note: None,
                resolves: Vec::new(),
            });
        }
        let version = self.versions.last_mut().expect("a version exists after a publish");
        if note.is_some() {
            version.note = note;
        }
        for id in resolves {
            if !version.resolves.contains(id) {
                version.resolves.push(id.clone());
            }
        }
        (version.n, is_new)
    }
}

impl Comments {
    pub fn get(&mut self, id: &str) -> Option<&mut Comment> {
        self.comments.iter_mut().find(|c| c.id == id)
    }

    pub fn open(&self) -> usize {
        self.comments.iter().filter(|c| c.open).count()
    }

    /// Adds a comment under an id no other comment of this artifact has.
    #[allow(clippy::too_many_arguments)]
    pub fn add(
        &mut self,
        artifact: &str,
        version: u32,
        anchor: Option<Anchor>,
        body: String,
        author: String,
        to_agent: bool,
        now: &str,
    ) -> &Comment {
        let mut seed = fnv1a(format!("{artifact}\n{now}\n{body}\n{}", self.comments.len()).as_bytes());
        let id = loop {
            let id = format!("c_{:06x}", seed & 0xff_ffff);
            if !self.comments.iter().any(|c| c.id == id) {
                break id;
            }
            seed = seed.wrapping_add(1);
        };
        self.comments.push(Comment {
            id,
            version,
            anchor,
            body,
            author,
            to_agent,
            at: now.into(),
            open: true,
            resolved_in: None,
            replies: Vec::new(),
        });
        self.comments.last().expect("just pushed")
    }
}

impl Comment {
    pub fn reply(&mut self, author: String, body: String, now: &str) {
        self.replies.push(Reply { author, body, at: now.into() });
    }

    pub fn resolve(&mut self, version: Option<u32>) {
        self.open = false;
        self.resolved_in = version;
    }

    pub fn reopen(&mut self) {
        self.open = true;
        self.resolved_in = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_source_always_gets_the_same_id_and_ids_are_folder_safe() {
        let id = artifact_id("/site/Pricing Page.html", "Pricing Page");
        assert_eq!(id, artifact_id("/site/Pricing Page.html", "Pricing Page"));
        assert!(id.starts_with("pricing-page-") && valid_id(&id));
        assert_ne!(id, artifact_id("/other/Pricing Page.html", "Pricing Page"));
        assert!(valid_id(&artifact_id("/x/日本語.md", "日本語")));
        assert!(!valid_id("../etc") && !valid_id("") && !valid_id("A"));
    }

    #[test]
    fn unchanged_content_adds_no_version_but_keeps_its_note_and_resolves() {
        let mut a = Artifact::new("a-1".into(), "A".into(), "/a.md".into(), None, "t0");
        assert_eq!(a.publish("a.md", "h1", None, &[], "t1"), (1, true));
        assert_eq!(a.publish("a.md", "h1", Some("same".into()), &["c_1".into()], "t2"), (1, false));
        assert_eq!(a.publish("a.md", "h2", None, &["c_2".into()], "t3"), (2, true));
        assert_eq!(a.versions[0].note.as_deref(), Some("same"));
        assert_eq!(a.versions[0].resolves, ["c_1"]);
        assert_eq!((a.versions[1].resolves.as_slice(), a.updated.as_str()), (["c_2".to_string()].as_slice(), "t3"));
    }

    #[test]
    fn comments_get_distinct_ids_and_resolve_and_reopen() {
        let mut c = Comments::default();
        let first = c.add("a-1", 1, None, "same".into(), "user".into(), true, "t").id.clone();
        let second = c.add("a-1", 1, None, "same".into(), "user".into(), true, "t").id.clone();
        assert_ne!(first, second);
        c.get(&first).unwrap().resolve(Some(2));
        assert_eq!((c.open(), c.get(&first).unwrap().resolved_in), (1, Some(2)));
        c.get(&first).unwrap().reopen();
        assert_eq!((c.open(), c.get(&first).unwrap().resolved_in), (2, None));
    }

    #[test]
    fn kinds_come_from_the_extension_and_pins_must_be_fractions() {
        assert_eq!(
            (kind_of("a.HTML"), kind_of("a.md"), kind_of("a.png"), kind_of("a")),
            (Kind::Html, Kind::Markdown, Kind::Image, Kind::Other)
        );
        assert_eq!(parse_pin("0.5, 0.25"), Ok((0.5, 0.25)));
        assert!(parse_pin("742,404").is_err() && parse_pin("0.5").is_err());
    }
}
