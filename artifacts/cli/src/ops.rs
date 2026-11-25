use std::path::Path;

use serde_json::{Value, json};

use crate::agent::{self, TerminalState};
use crate::model::{
    Anchor, Artifact, ArtifactId, Author, Comment, Comments, Draft, Published, Status, artifact_id_for, fnv1a,
    live_stem, parse_url,
};
use crate::store::Store;

pub struct Out {
    pub json: Value,
    pub text: String,
}

pub struct NewComment {
    pub artifact: ArtifactId,
    pub version: Option<u32>,
    pub draft: Draft,
}

pub fn this_terminal() -> Option<String> {
    std::env::var("HC_TERMINAL_ID").ok().filter(|t| !t.is_empty())
}

pub fn default_author() -> Author {
    this_terminal().map_or(Author::Person, |address| Author::Terminal { address })
}

pub fn name(status: Status) -> String {
    serde_json::to_value(status).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

pub fn publish(
    store: &Store,
    file: &Path,
    title: Option<String>,
    note: Option<String>,
    resolves: &[String],
    status: Status,
    now: &str,
) -> Result<Out, String> {
    let source = file.canonicalize().map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    let content = std::fs::read(&source).map_err(|e| format!("cannot read {}: {e}", source.display()))?;
    let file_name = source.file_name().and_then(|n| n.to_str()).ok_or("the file name is not valid UTF-8")?.to_owned();
    let stem = source.file_stem().and_then(|n| n.to_str()).unwrap_or(&file_name);
    let source_text = source.to_str().ok_or("the file path is not valid UTF-8")?;
    let _lock = store.lock()?;
    let id = artifact_id_for(source_text, stem, |id| store.artifact(id).ok().map(|a| a.source));
    let mut artifact = if store.exists(&id) {
        store.artifact(&id)?
    } else {
        Artifact::new(id.clone(), file_name.clone(), source_text.to_owned(), this_terminal(), now)
    };
    let mut comments = store.comments(&id)?;
    refuse_unknown(&comments, resolves, &id)?;
    if let Some(title) = title {
        artifact.title = title;
    }
    let published = artifact.publish(&file_name, &format!("{:016x}", fnv1a(&content)), note, resolves, now);
    let version = published.version();
    artifact.status = status;
    let path = match published {
        Published::New(n) => store.snapshot(&id, n, &file_name, &content)?,
        Published::Unchanged(n) => store.version_path(&id, n, &file_name),
    };
    close_resolved(store, &id, &mut comments, resolves, version)?;
    store.save_artifact(&artifact)?;

    let what = match published {
        Published::New(n) => format!("published {id} v{n}"),
        Published::Unchanged(n) => format!("{id} is unchanged since v{n}"),
    };
    let closed = if resolves.is_empty() { String::new() } else { format!(", resolved {}", resolves.join(" ")) };
    Ok(Out {
        text: format!("{what}{closed}"),
        json: json!({ "id": id, "version": version, "new": matches!(published, Published::New(_)), "path": path,
                      "status": status, "resolved": resolves }),
    })
}

fn refuse_unknown(comments: &Comments, resolves: &[String], id: &ArtifactId) -> Result<(), String> {
    match resolves.iter().find(|r| !comments.comments.iter().any(|c| &c.id == *r)) {
        Some(missing) => Err(format!("no comment {missing} on {id}")),
        None => Ok(()),
    }
}

fn close_resolved(
    store: &Store,
    id: &ArtifactId,
    comments: &mut Comments,
    resolves: &[String],
    version: u32,
) -> Result<(), String> {
    if resolves.is_empty() {
        return Ok(());
    }
    for resolved in resolves {
        if let Some(comment) = comments.get(resolved) {
            comment.resolve(Some(version));
        }
    }
    store.save_comments(id, comments)
}

pub fn publish_url(
    store: &Store,
    url: &str,
    title: Option<String>,
    note: Option<String>,
    resolves: &[String],
    status: Status,
    now: &str,
) -> Result<Out, String> {
    let (upstream, path) = parse_url(url)?;
    let _lock = store.lock()?;
    let id = artifact_id_for(url, &live_stem(&upstream, &path), |id| store.artifact(id).ok().map(|a| a.source));
    let mut artifact = if store.exists(&id) {
        store.artifact(&id)?
    } else {
        Artifact::live(id.clone(), url.to_owned(), this_terminal(), now)
    };
    let mut comments = store.comments(&id)?;
    refuse_unknown(&comments, resolves, &id)?;
    if let Some(title) = title {
        artifact.title = title;
    }
    let version = artifact.publish_live(&path, note, resolves, now);
    artifact.status = status;
    close_resolved(store, &id, &mut comments, resolves, version)?;
    store.save_artifact(&artifact)?;
    let closed = if resolves.is_empty() { String::new() } else { format!(", resolved {}", resolves.join(" ")) };
    Ok(Out {
        text: format!("published {id} v{version} (live at {url}){closed}"),
        json: json!({ "id": id, "version": version, "new": true, "url": url, "status": status, "resolved": resolves }),
    })
}

pub fn list(store: &Store, status: Option<Status>) -> Result<Out, String> {
    let mut rows = Vec::new();
    for id in store.ids()? {
        let artifact = store.artifact(&id)?;
        if status.is_none_or(|s| s == artifact.status) {
            rows.push((artifact, store.comments(&id)?.open()));
        }
    }
    rows.sort_by(|a, b| b.0.updated.cmp(&a.0.updated));
    let text = if rows.is_empty() {
        "no artifacts".to_owned()
    } else {
        rows.iter()
            .map(|(a, open)| format!("{}  v{}  {}  {} open  {}", a.id, a.latest(), name(a.status), open, a.title))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let json = rows
        .iter()
        .map(|(a, open)| {
            json!({ "id": a.id, "title": a.title, "kind": a.kind, "status": a.status, "version": a.latest(),
                    "updated": a.updated, "first_publisher": a.first_publisher, "source": a.source,
                    "open_comments": open })
        })
        .collect();
    Ok(Out { text, json })
}

pub fn show(store: &Store, id: &ArtifactId) -> Result<Out, String> {
    let artifact = store.artifact(id)?;
    let comments = store.comments(id)?;
    let mut text = format!(
        "{} ({})  {}  v{}\nsource: {}",
        artifact.title,
        artifact.id,
        name(artifact.status),
        artifact.latest(),
        artifact.source
    );
    for v in &artifact.versions {
        text.push_str(&format!("\nv{}  {}  {}", v.n, v.at, v.note.as_deref().unwrap_or("")));
    }
    for c in &comments.comments {
        text.push_str(&format!("\n{}", thread(c)));
    }
    Ok(Out { text, json: json!({ "artifact": artifact, "comments": comments.comments }) })
}

fn thread(c: &Comment) -> String {
    let state = match (c.open, c.resolved_in) {
        (true, _) => "open".to_owned(),
        (false, Some(v)) => format!("resolved in v{v}"),
        (false, None) => "resolved".to_owned(),
    };
    let anchor = match &c.anchor {
        Some(Anchor::Pin { x, y, label }) => {
            format!(" pin {x:.3},{y:.3}{}", label.as_ref().map(|l| format!(" ({l})")).unwrap_or_default())
        }
        Some(Anchor::Text { quote, line }) => {
            format!(" quote{} \"{quote}\"", line.map(|l| format!(" line {l}")).unwrap_or_default())
        }
        Some(Anchor::Element { selector, label, text, .. }) => format!(
            " element {}{} [{selector}]",
            label.as_deref().unwrap_or("?"),
            text.as_ref().filter(|t| !t.is_empty()).map(|t| format!(" \"{t}\"")).unwrap_or_default()
        ),
        None => String::new(),
    };
    let mut text = format!("{} [{state}, v{}]{anchor}\n  {}: {}", c.id, c.version, c.author, c.body);
    for r in &c.replies {
        text.push_str(&format!("\n  {}: {}", r.author, r.body));
    }
    text
}

pub fn comment(store: &Store, new: NewComment, now: &str) -> Result<Out, String> {
    let _lock = store.lock()?;
    let artifact = store.artifact(&new.artifact)?;
    let version = new.version.unwrap_or_else(|| artifact.latest());
    if !artifact.versions.iter().any(|v| v.n == version) {
        return Err(format!("{} has no version {version}", new.artifact));
    }
    let mut comments = store.comments(&new.artifact)?;
    let made = comments.add(version, new.draft, &store.comment_ids()?, now).clone();
    store.save_comments(&new.artifact, &comments)?;
    Ok(Out {
        text: format!("{} on {} v{version}", made.id, new.artifact),
        json: json!({ "artifact": new.artifact, "comment": made }),
    })
}

pub fn change_comment(
    store: &Store,
    comment: &str,
    change: impl FnOnce(&mut Comment) -> &'static str,
) -> Result<Out, String> {
    let _lock = store.lock()?;
    let id = store.owner_of(comment)?;
    let mut comments = store.comments(&id)?;
    let found = comments.get(comment).ok_or_else(|| format!("no comment {comment} on {id}"))?;
    let did = change(found);
    let after = found.clone();
    store.save_comments(&id, &comments)?;
    Ok(Out { text: format!("{did} {comment} on {id}"), json: json!({ "artifact": id, "comment": after }) })
}

pub fn set_status(store: &Store, id: &ArtifactId, status: Status, now: &str) -> Result<Out, String> {
    let _lock = store.lock()?;
    let mut artifact = store.artifact(id)?;
    artifact.status = status;
    artifact.updated = now.into();
    store.save_artifact(&artifact)?;
    Ok(Out { text: format!("{id} is {}", name(status)), json: json!({ "id": id, "status": status }) })
}

fn record_delivery(store: &Store, id: &ArtifactId, comment: &str, now: &str) -> Result<(), String> {
    let _lock = store.lock()?;
    let mut comments = store.comments(id)?;
    comments.get(comment).ok_or_else(|| format!("no comment {comment} on {id}"))?.sent_to_agent = true;
    store.save_comments(id, &comments)?;
    let mut artifact = store.artifact(id)?;
    if artifact.status != Status::Working {
        artifact.status = Status::ChangesRequested;
        artifact.updated = now.into();
        store.save_artifact(&artifact)?;
    }
    Ok(())
}

pub fn send_and_request_changes(store: &Store, comment: &str, now: &str) -> Result<Out, String> {
    let id = store.owner_of(comment)?;
    let artifact = store.artifact(&id)?;
    let found = store
        .comments(&id)?
        .comments
        .into_iter()
        .find(|c| c.id == comment)
        .ok_or_else(|| format!("no comment {comment} on {id}"))?;
    let terminal = artifact
        .first_publisher
        .clone()
        .ok_or_else(|| format!("{id} was not published from a terminal: nobody to send to"))?;
    match agent::status(&terminal) {
        TerminalState::Gone => return Err(format!("{terminal} is not running: the comment is saved, not sent")),
        TerminalState::NoAgent => {
            return Err(format!("{terminal} is not running an agent now: the comment is saved, not sent"));
        }
        TerminalState::Agent(_) => {}
    }
    agent::type_and_submit(&terminal, &agent::message(&artifact, &found))?;
    record_delivery(store, &id, comment, now)?;
    Ok(Out {
        text: format!("sent {comment} to {terminal}"),
        json: json!({ "artifact": id, "comment": comment, "terminal": terminal }),
    })
}
