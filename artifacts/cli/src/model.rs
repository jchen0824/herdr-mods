use std::collections::HashSet;
use std::fmt;
use std::str::FromStr;

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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(try_from = "String")]
pub struct ArtifactId(String);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(try_from = "f64")]
pub struct Fraction(f64);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Author {
    Person,
    Terminal { address: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Published {
    New(u32),
    Unchanged(u32),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Artifact {
    pub id: ArtifactId,
    pub title: String,
    pub source: String,
    pub kind: Kind,
    pub status: Status,
    pub first_publisher: Option<String>,
    pub created: String,
    pub updated: String,
    pub versions: Vec<Version>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Version {
    pub n: u32,
    pub at: String,
    pub file: String,
    pub hash: String,
    pub note: Option<String>,
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
    pub version: u32,
    pub anchor: Option<Anchor>,
    pub body: String,
    pub author: Author,
    #[serde(default)]
    pub sent_to_agent: bool,
    pub at: String,
    pub open: bool,
    pub resolved_in: Option<u32>,
    #[serde(default)]
    pub replies: Vec<Reply>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Anchor {
    Pin { x: Fraction, y: Fraction, label: Option<String> },
    Text { quote: String, line: Option<u32> },
    Element { selector: String, label: Option<String>, text: Option<String>, x: Fraction, y: Fraction },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Reply {
    pub author: Author,
    pub body: String,
    pub at: String,
}

pub struct Draft {
    pub anchor: Option<Anchor>,
    pub body: String,
    pub author: Author,
}

impl ArtifactId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for ArtifactId {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        let folder_safe =
            !text.is_empty() && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if folder_safe { Ok(Self(text.to_owned())) } else { Err(format!("not an artifact id: {text}")) }
    }
}

impl TryFrom<String> for ArtifactId {
    type Error = String;

    fn try_from(text: String) -> Result<Self, String> {
        text.parse()
    }
}

impl fmt::Display for ArtifactId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Fraction {
    pub fn get(self) -> f64 {
        self.0
    }
}

impl TryFrom<f64> for Fraction {
    type Error = String;

    fn try_from(value: f64) -> Result<Self, String> {
        if (0.0..=1.0).contains(&value) {
            Ok(Self(value))
        } else {
            Err(format!("{value} is not a fraction from 0 to 1"))
        }
    }
}

impl fmt::Display for Fraction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl FromStr for Author {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        match text {
            "person" => Ok(Self::Person),
            "" => Err("--author wants person or a terminal address".into()),
            address => Ok(Self::Terminal { address: address.into() }),
        }
    }
}

impl fmt::Display for Author {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Person => f.write_str("the person"),
            Self::Terminal { address } => f.write_str(address),
        }
    }
}

impl Published {
    pub fn version(self) -> u32 {
        match self {
            Self::New(n) | Self::Unchanged(n) => n,
        }
    }
}

pub fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0000_0100_0000_01b3))
}

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

pub fn artifact_id(source: &str, stem: &str) -> ArtifactId {
    ArtifactId(format!("{}-{:08x}", slug(stem).trim_end_matches('-'), fnv1a(source.as_bytes()) as u32))
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

pub fn parse_pin(text: &str) -> Result<(Fraction, Fraction), String> {
    let bad = || format!("--pin wants X,Y as fractions from 0 to 1 (got {text})");
    let fraction =
        |part: &str| part.trim().parse::<f64>().ok().and_then(|v| Fraction::try_from(v).ok()).ok_or_else(bad);
    let (x, y) = text.split_once(',').ok_or_else(bad)?;
    Ok((fraction(x)?, fraction(y)?))
}

impl Artifact {
    pub fn new(id: ArtifactId, title: String, source: String, first_publisher: Option<String>, now: &str) -> Self {
        let kind = kind_of(&source);
        Self {
            id,
            title,
            source,
            kind,
            status: Status::Working,
            first_publisher,
            created: now.into(),
            updated: now.into(),
            versions: Vec::new(),
        }
    }

    pub fn latest(&self) -> u32 {
        self.versions.last().map_or(0, |v| v.n)
    }

    pub fn publish(
        &mut self,
        file: &str,
        hash: &str,
        note: Option<String>,
        resolves: &[String],
        now: &str,
    ) -> Published {
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
        if is_new { Published::New(version.n) } else { Published::Unchanged(version.n) }
    }
}

impl Comments {
    pub fn get(&mut self, id: &str) -> Option<&mut Comment> {
        self.comments.iter_mut().find(|c| c.id == id)
    }

    pub fn open(&self) -> usize {
        self.comments.iter().filter(|c| c.open).count()
    }

    pub fn add(&mut self, version: u32, draft: Draft, taken: &HashSet<String>, now: &str) -> &Comment {
        let mut seed = fnv1a(draft.body.as_bytes());
        let id = loop {
            let id = format!("c_{:06x}", seed & 0xff_ffff);
            if !taken.contains(&id) && !self.comments.iter().any(|c| c.id == id) {
                break id;
            }
            seed = seed.wrapping_add(1);
        };
        self.comments.push(Comment {
            id,
            version,
            anchor: draft.anchor,
            body: draft.body,
            author: draft.author,
            sent_to_agent: false,
            at: now.into(),
            open: true,
            resolved_in: None,
            replies: Vec::new(),
        });
        self.comments.last().expect("just pushed")
    }
}

impl Comment {
    pub fn reply(&mut self, author: Author, body: String, now: &str) {
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

    fn draft(body: &str) -> Draft {
        Draft { anchor: None, body: body.into(), author: Author::Person }
    }

    #[test]
    fn the_same_source_always_gets_the_same_id_and_ids_are_folder_safe() {
        let id = artifact_id("/site/Pricing Page.html", "Pricing Page");
        assert_eq!(id, artifact_id("/site/Pricing Page.html", "Pricing Page"));
        assert!(id.as_str().starts_with("pricing-page-") && id.as_str().parse::<ArtifactId>().is_ok());
        assert_ne!(id, artifact_id("/other/Pricing Page.html", "Pricing Page"));
        assert!(artifact_id("/x/日本語.md", "日本語").as_str().parse::<ArtifactId>().is_ok());
    }

    #[test]
    fn an_invalid_artifact_id_is_refused() {
        for bad in ["../etc", "", "A", "a/b", "a.b"] {
            assert!(bad.parse::<ArtifactId>().is_err(), "{bad:?}");
            assert!(serde_json::from_value::<ArtifactId>(serde_json::json!(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn unchanged_content_adds_no_version_but_keeps_its_note_and_resolves() {
        let mut a = Artifact::new("a-1".parse().unwrap(), "A".into(), "/a.md".into(), None, "t0");
        assert_eq!(a.publish("a.md", "h1", None, &[], "t1"), Published::New(1));
        assert_eq!(a.publish("a.md", "h1", Some("same".into()), &["c_1".into()], "t2"), Published::Unchanged(1));
        assert_eq!(a.publish("a.md", "h2", None, &["c_2".into()], "t3"), Published::New(2));
        assert_eq!(a.versions[0].note.as_deref(), Some("same"));
        assert_eq!(a.versions[0].resolves, ["c_1"]);
        assert_eq!((a.versions[1].resolves.as_slice(), a.updated.as_str()), (["c_2".to_string()].as_slice(), "t3"));
    }

    #[test]
    fn comments_get_distinct_ids_and_resolve_and_reopen() {
        let mut c = Comments::default();
        let first = c.add(1, draft("same"), &HashSet::new(), "t").id.clone();
        let second = c.add(1, draft("same"), &HashSet::new(), "t").id.clone();
        assert_ne!(first, second);
        c.get(&first).unwrap().resolve(Some(2));
        assert_eq!((c.open(), c.get(&first).unwrap().resolved_in), (1, Some(2)));
        c.get(&first).unwrap().reopen();
        assert_eq!((c.open(), c.get(&first).unwrap().resolved_in), (2, None));
    }

    #[test]
    fn kinds_come_from_the_extension() {
        assert_eq!(
            (kind_of("a.HTML"), kind_of("a.md"), kind_of("a.png"), kind_of("a")),
            (Kind::Html, Kind::Markdown, Kind::Image, Kind::Other)
        );
    }

    #[test]
    fn a_fraction_outside_0_to_1_is_refused() {
        assert_eq!(parse_pin("0.5, 0.25").map(|(x, y)| (x.get(), y.get())), Ok((0.5, 0.25)));
        assert!(parse_pin("742,404").is_err() && parse_pin("0.5,-0.1").is_err() && parse_pin("0.5").is_err());
        assert!(Fraction::try_from(1.5).is_err() && Fraction::try_from(f64::NAN).is_err());
        let stored = serde_json::json!({ "kind": "pin", "x": 2.0, "y": 0.5, "label": null });
        assert!(serde_json::from_value::<Anchor>(stored).is_err());
    }

    #[test]
    fn an_author_flag_is_the_person_or_a_terminal_address() {
        assert_eq!("person".parse(), Ok(Author::Person));
        assert_eq!("t7".parse(), Ok(Author::Terminal { address: "t7".into() }));
        assert!("".parse::<Author>().is_err());
    }
}
