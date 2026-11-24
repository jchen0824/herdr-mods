//! herdr-artifact: publish files as Herdr artifacts with versions, statuses and comment threads.
//! One call per command; `--json` prints what the command made.

mod agent;
mod model;
mod ops;
mod store;
mod time;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand};
use serde_json::json;

use model::{Anchor, Status, parse_pin};
use ops::{NewComment, Out, default_author};
use store::Store;

#[derive(Parser)]
#[command(
    name = "herdr-artifact",
    version,
    about = "Publish files as Herdr artifacts: versions, statuses and comments"
)]
struct Cli {
    /// Print the result as JSON, or {"error": "..."} with exit code 1.
    #[arg(long, global = true)]
    json: bool,
    /// Print the manual for agents.
    #[arg(long)]
    skill: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Publish a file: the first time makes an artifact, later times make versions.
    Publish {
        file: PathBuf,
        /// The artifact's name (default: the file name). Renames an existing artifact.
        #[arg(long)]
        title: Option<String>,
        /// What changed in this version.
        #[arg(short = 'm', long)]
        note: Option<String>,
        /// A comment this version resolves. Repeat for several.
        #[arg(long, value_name = "COMMENT")]
        resolves: Vec<String>,
        /// working: still changing it. Default: ready for review.
        #[arg(long, value_enum, default_value = "ready")]
        status: Status,
    },
    /// Every artifact with its status, version and open comments.
    List {
        #[arg(long, value_enum)]
        status: Option<Status>,
    },
    /// One artifact, its versions and its comment threads.
    Show { id: String },
    /// Add a comment to an artifact.
    Comment {
        id: String,
        body: String,
        /// The version commented on (default: the latest).
        #[arg(long)]
        version: Option<u32>,
        /// A point on the rendered artifact: X,Y as fractions from 0 to 1.
        #[arg(long, value_name = "X,Y", conflicts_with = "quote")]
        pin: Option<String>,
        /// What is under the pin.
        #[arg(long, requires = "pin")]
        label: Option<String>,
        /// The text commented on.
        #[arg(long)]
        quote: Option<String>,
        /// The quote's 1-based line in the file.
        #[arg(long, requires = "quote")]
        line: Option<u32>,
        /// Sent to the publishing agent, not only kept as a note.
        #[arg(long)]
        to_agent: bool,
        /// Who wrote it (default: this terminal's address, else user).
        #[arg(long)]
        author: Option<String>,
    },
    /// Reply in a comment's thread.
    Reply {
        comment: String,
        body: String,
        /// Also close the comment.
        #[arg(long)]
        resolve: bool,
        #[arg(long)]
        author: Option<String>,
        /// The artifact, when two artifacts have a comment with this id.
        #[arg(long)]
        artifact: Option<String>,
    },
    /// Close a comment.
    Resolve {
        comment: String,
        #[arg(long)]
        artifact: Option<String>,
    },
    /// Open a closed comment again.
    Reopen {
        comment: String,
        #[arg(long)]
        artifact: Option<String>,
    },
    /// Set an artifact's status.
    Status {
        id: String,
        #[arg(value_enum)]
        status: Status,
    },
    /// Type a comment into the terminal of the agent that published its artifact.
    Send {
        comment: String,
        #[arg(long)]
        artifact: Option<String>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.skill {
        print!("{}", include_str!("SKILL.md"));
        return ExitCode::SUCCESS;
    }
    let Some(command) = cli.command else {
        let _ = Cli::command().print_help();
        return ExitCode::from(2);
    };
    match run(command) {
        Ok(out) if cli.json => println!("{}", out.json),
        Ok(out) => println!("{}", out.text),
        Err(error) => {
            if cli.json {
                println!("{}", json!({ "error": error }));
            } else {
                eprintln!("herdr-artifact: {error}");
            }
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

fn run(command: Command) -> Result<Out, String> {
    let store = Store::open()?;
    let now = time::now();
    match command {
        Command::Publish { file, title, note, resolves, status } => {
            ops::publish(&store, &file, title, note, &resolves, status, &now)
        }
        Command::List { status } => ops::list(&store, status),
        Command::Show { id } => ops::show(&store, &id),
        Command::Comment { id, body, version, pin, label, quote, line, to_agent, author } => {
            let anchor = match (pin, quote) {
                (Some(pin), _) => {
                    let (x, y) = parse_pin(&pin)?;
                    Some(Anchor::Pin { x, y, label })
                }
                (None, Some(quote)) => Some(Anchor::Text { quote, line }),
                (None, None) => None,
            };
            let author = author.unwrap_or_else(default_author);
            ops::comment(&store, NewComment { artifact: id, body, version, anchor, to_agent, author }, &now)
        }
        Command::Reply { comment, body, resolve, author, artifact } => {
            let author = author.unwrap_or_else(default_author);
            ops::change_comment(&store, &comment, artifact, |c| {
                c.reply(author, body, &now);
                if resolve {
                    c.resolve(None);
                }
                if resolve { "replied and resolved" } else { "replied" }
            })
        }
        Command::Resolve { comment, artifact } => ops::change_comment(&store, &comment, artifact, |c| {
            c.resolve(None);
            "resolved"
        }),
        Command::Reopen { comment, artifact } => ops::change_comment(&store, &comment, artifact, |c| {
            c.reopen();
            "reopened"
        }),
        Command::Status { id, status } => ops::set_status(&store, &id, status, &now),
        Command::Send { comment, artifact } => ops::deliver(&store, &comment, artifact, &now),
    }
}
