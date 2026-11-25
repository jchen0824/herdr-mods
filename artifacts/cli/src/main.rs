mod agent;
mod http;
mod model;
mod ops;
mod proxy;
mod server;
mod store;
mod time;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand};
use serde_json::json;

use model::{Anchor, Author, Draft, Status, parse_pin};
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
        #[arg(required_unless_present = "url", conflicts_with = "url")]
        file: Option<PathBuf>,
        /// A live page on a dev server (http://localhost:5173/pricing), reviewed through a proxy. Nothing is copied.
        #[arg(long)]
        url: Option<String>,
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
        /// Who wrote it: person or a terminal address (default: this terminal's address, else person).
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
    },
    /// Close a comment.
    Resolve { comment: String },
    /// Open a closed comment again.
    Reopen { comment: String },
    /// Set an artifact's status.
    Status {
        id: String,
        #[arg(value_enum)]
        status: Status,
    },
    /// Type a comment into the terminal of the agent that published its artifact.
    Send { comment: String },
    /// Serve review pages for this computer's browser: the artifact rendered, with comments on it.
    Serve {
        /// 0 picks a free port.
        #[arg(long, default_value_t = server::DEFAULT_PORT)]
        port: u16,
        /// Also answer on this name of this computer (its tailnet name, say), for reviewing from another
        /// device on a private network. Anyone who can reach it can send comments to your agents.
        #[arg(long, value_name = "NAME")]
        host: Vec<String>,
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
    match run(command, cli.json) {
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

fn run(command: Command, json: bool) -> Result<Out, String> {
    let store = Store::open()?;
    let now = time::now();
    match command {
        Command::Publish { file, url, title, note, resolves, status } => match (file, url) {
            (_, Some(url)) => ops::publish_url(&store, &url, title, note, &resolves, status, &now),
            (Some(file), None) => ops::publish(&store, &file, title, note, &resolves, status, &now),
            (None, None) => Err("give a file or --url".into()),
        },
        Command::List { status } => ops::list(&store, status),
        Command::Show { id } => ops::show(&store, &id.parse()?),
        Command::Comment { id, body, version, pin, label, quote, line, author } => {
            let anchor = match (pin, quote) {
                (Some(pin), _) => {
                    let (x, y) = parse_pin(&pin)?;
                    Some(Anchor::Pin { x, y, label, page: None })
                }
                (None, Some(quote)) => Some(Anchor::Text { quote, line }),
                (None, None) => None,
            };
            let draft = Draft { anchor, body, author: author_or_default(author)? };
            ops::comment(&store, NewComment { artifact: id.parse()?, version, draft }, &now)
        }
        Command::Reply { comment, body, resolve, author } => {
            let author = author_or_default(author)?;
            ops::change_comment(&store, &comment, |c| {
                c.reply(author, body, &now);
                if resolve {
                    c.resolve(None);
                }
                if resolve { "replied and resolved" } else { "replied" }
            })
        }
        Command::Resolve { comment } => ops::change_comment(&store, &comment, |c| {
            c.resolve(None);
            "resolved"
        }),
        Command::Reopen { comment } => ops::change_comment(&store, &comment, |c| {
            c.reopen();
            "reopened"
        }),
        Command::Status { id, status } => ops::set_status(&store, &id.parse()?, status, &now),
        Command::Send { comment } => ops::send_and_request_changes(&store, &comment, &now),
        Command::Serve { port, host } => server::serve(port, &host, json),
    }
}

fn author_or_default(flag: Option<String>) -> Result<Author, String> {
    flag.map_or_else(|| Ok(default_author()), |author| author.parse())
}
