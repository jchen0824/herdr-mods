use std::process::Command;

use crate::model::{Anchor, Artifact, Comment};

pub enum TerminalState {
    Gone,
    NoAgent,
    Agent,
}

fn hc() -> Command {
    Command::new(std::env::var("HERDR_ARTIFACT_HC").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "hc".into()))
}

pub fn message(a: &Artifact, c: &Comment) -> String {
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
            x.get() * 100.0,
            y.get() * 100.0
        )),
        None => {}
    }
    lines.push(format!("\"{}\"", c.body));
    for r in &c.replies {
        lines.push(format!("  {}: \"{}\"", r.author, r.body));
    }
    lines.push(format!("Source: {}", a.source));
    let publish = format!("\"{}\"", a.source);
    lines.push(format!(
        "Reply: herdr-artifact reply {} \"...\" | After fixing: herdr-artifact publish {publish} -m \"what changed\" --resolves {} | Manual: herdr-artifact --skill",
        c.id, c.id
    ));
    lines.join("\n")
}

pub fn type_and_submit(terminal: &str, text: &str) -> Result<(), String> {
    let out = hc().args(["send", terminal, text]).output().map_err(|e| format!("cannot run hc: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let said =
            String::from_utf8_lossy(if out.stderr.is_empty() { &out.stdout } else { &out.stderr }).trim().to_owned();
        Err(if said.is_empty() { format!("hc send to {terminal} failed") } else { said })
    }
}

pub fn status(terminal: &str) -> TerminalState {
    let listed = hc()
        .args(["ls", "--json"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok());
    let found = listed.as_ref().and_then(|l| l["terminals"].as_array()?.iter().find(|t| t["address"] == terminal));
    match found {
        None => TerminalState::Gone,
        Some(t) if t["status"].is_string() => TerminalState::Agent,
        Some(_) => TerminalState::NoAgent,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::message;
    use crate::model::{Anchor, Artifact, Author, Comments, Draft, Fraction};

    #[test]
    fn the_message_names_the_element_the_comment_and_how_to_answer() {
        let a = Artifact::new("p-1".parse().unwrap(), "Pricing".into(), "/site/p.html".into(), Some("t7".into()), "t");
        let mut c = Comments::default();
        let half = Fraction::try_from(0.5).unwrap();
        let anchor = Anchor::Element {
            selector: "body > a".into(),
            label: Some("a.btn".into()),
            text: Some("Book a demo".into()),
            x: half,
            y: half,
        };
        let draft = Draft { anchor: Some(anchor), body: "Open the calendar".into(), author: Author::Person };
        let comment = c.add(3, draft, &HashSet::new(), "t").clone();
        let text = message(&a, &comment);
        assert!(
            text.contains("\"Pricing\" v3 (p-1)")
                && text.contains("a.btn \"Book a demo\", 50% across and 50% down it (selector: body > a)")
        );
        assert!(text.contains("\"Open the calendar\"") && text.contains(&format!("reply {}", comment.id)));
        assert!(text.contains(&format!("publish \"/site/p.html\" -m \"what changed\" --resolves {}", comment.id)));
    }
}
