//! Reaching the agent that published an artifact, through herdr-core's `hc`.

use std::process::Command;

use crate::model::{Anchor, Artifact, Comment};

/// `HERDR_ARTIFACT_HC` names another program to run as hc (tests use it).
fn hc() -> Command {
    Command::new(std::env::var("HERDR_ARTIFACT_HC").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "hc".into()))
}

/// What the publishing agent reads when a comment is sent to it.
pub fn message(a: &Artifact, c: &Comment) -> String {
    // With replies, the person is answering in the thread: say so, and show the thread below.
    let what = if c.replies.is_empty() { "Comment" } else { "Reply in a comment thread" };
    let mut lines = vec![format!("[Herdr artifact] {what} on \"{}\" v{} ({})", a.title, c.version, a.id)];
    match &c.anchor {
        Some(Anchor::Pin { x, y, label }) => lines.push(format!(
            "Pinned at {x:.3},{y:.3} of the rendered artifact (fractions of its width and height){}",
            label.as_ref().map(|l| format!(": {l}")).unwrap_or_default()
        )),
        Some(Anchor::Text { quote, line }) => {
            lines.push(format!("On{}: \"{quote}\"", line.map(|l| format!(" line {l}")).unwrap_or_default()));
        }
        Some(Anchor::Element { selector, label, text, x, y }) => lines.push(format!(
            "Pinned on the element {}{}, {:.0}% across and {:.0}% down it (selector: {selector})",
            label.as_deref().unwrap_or("?"),
            text.as_ref().filter(|t| !t.is_empty()).map(|t| format!(" \"{t}\"")).unwrap_or_default(),
            x * 100.0,
            y * 100.0
        )),
        None => {}
    }
    lines.push(format!("\"{}\"", c.body));
    for r in &c.replies {
        lines.push(format!("  {}: \"{}\"", if r.author == "user" { "the person" } else { r.author.as_str() }, r.body));
    }
    lines.push(format!("Source: {}", a.source));
    let publish = format!("\"{}\"", a.source);
    lines.push(format!(
        "Reply: herdr-artifact reply {} \"...\" | After fixing: herdr-artifact publish {publish} -m \"what changed\" --resolves {} | Manual: herdr-artifact --skill",
        c.id, c.id
    ));
    lines.join("\n")
}

/// Types the text into the terminal and submits it.
pub fn send(terminal: &str, text: &str) -> Result<(), String> {
    let out = hc().args(["send", terminal, text]).output().map_err(|e| format!("cannot run hc: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let said =
            String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_owned();
        Err(if said.is_empty() { format!("hc send to {terminal} failed") } else { said })
    }
}

/// The terminal's status as core reports it (`working`, `idle`, ...), `live` when it reports none,
/// and None when it is not running or hc cannot say.
pub fn status(terminal: &str) -> Option<String> {
    let out = hc().args(["ls", "--json"]).output().ok().filter(|o| o.status.success())?;
    let listed: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let found = listed["terminals"].as_array()?.iter().find(|t| t["address"] == terminal)?;
    Some(found["status"].as_str().unwrap_or("live").to_owned())
}

#[cfg(test)]
mod tests {
    use super::message;
    use crate::model::{Anchor, Artifact, Comments};

    #[test]
    fn the_message_names_the_element_the_comment_and_how_to_answer() {
        let a = Artifact::new("p-1".into(), "Pricing".into(), "/site/p.html".into(), Some("t7".into()), "t");
        let mut c = Comments::default();
        let anchor = Anchor::Element {
            selector: "body > a".into(),
            label: Some("a.btn".into()),
            text: Some("Book a demo".into()),
            x: 0.5,
            y: 0.5,
        };
        let comment = c.add("p-1", 3, Some(anchor), "Open the calendar".into(), "user".into(), true, "t").clone();
        let text = message(&a, &comment);
        assert!(
            text.contains("\"Pricing\" v3 (p-1)")
                && text.contains("a.btn \"Book a demo\", 50% across and 50% down it (selector: body > a)")
        );
        assert!(text.contains("\"Open the calendar\"") && text.contains(&format!("reply {}", comment.id)));
        assert!(text.contains(&format!("publish \"/site/p.html\" -m \"what changed\" --resolves {}", comment.id)));
    }
}
