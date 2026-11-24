//! The store on disk: `<root>/<id>/artifact.json`, `comments.json` and `v<n>/<file>`.
//! Every write replaces its file whole (temp file, then rename), so a reader never sees half of one.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use crate::model::{Artifact, Comments, valid_id};

pub struct Store {
    root: PathBuf,
}

/// Held while a command reads, decides and writes. Removed on drop.
pub struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

fn err(what: &str, path: &Path, e: impl std::fmt::Display) -> String {
    format!("{what} {}: {e}", path.display())
}

impl Store {
    /// `HERDR_ARTIFACTS_HOME`, else `~/.herdr/artifacts`.
    pub fn open() -> Result<Self, String> {
        let root = match std::env::var_os("HERDR_ARTIFACTS_HOME").filter(|v| !v.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => {
                std::env::home_dir().ok_or("no home folder: set HERDR_ARTIFACTS_HOME")?.join(".herdr").join("artifacts")
            }
        };
        fs::create_dir_all(&root).map_err(|e| err("cannot create", &root, e))?;
        Ok(Self { root })
    }

    pub fn dir(&self, id: &str) -> Result<PathBuf, String> {
        if valid_id(id) { Ok(self.root.join(id)) } else { Err(format!("not an artifact id: {id}")) }
    }

    /// One writer at a time. A lock older than ten seconds was left by a killed command and is taken over.
    pub fn lock(&self) -> Result<Lock, String> {
        let path = self.root.join(".lock");
        for _ in 0..100 {
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Lock(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    let age = fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| SystemTime::now().duration_since(t).ok());
                    if age.is_some_and(|a| a > Duration::from_secs(10)) {
                        let _ = fs::remove_dir(&path);
                    } else {
                        sleep(Duration::from_millis(30));
                    }
                }
                Err(e) => return Err(err("cannot lock", &path, e)),
            }
        }
        Err(format!("the store is busy: {} is held", path.display()))
    }

    /// Every artifact id, in name order.
    pub fn ids(&self) -> Result<Vec<String>, String> {
        let mut ids: Vec<String> = fs::read_dir(&self.root)
            .map_err(|e| err("cannot read", &self.root, e))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| valid_id(name) && self.root.join(name).join("artifact.json").is_file())
            .collect();
        ids.sort();
        Ok(ids)
    }

    pub fn exists(&self, id: &str) -> Result<bool, String> {
        Ok(self.dir(id)?.join("artifact.json").is_file())
    }

    pub fn artifact(&self, id: &str) -> Result<Artifact, String> {
        let path = self.dir(id)?.join("artifact.json");
        if !path.is_file() {
            return Err(format!("no artifact {id}"));
        }
        let text = fs::read_to_string(&path).map_err(|e| err("cannot read", &path, e))?;
        serde_json::from_str(&text).map_err(|e| err("cannot parse", &path, e))
    }

    /// An artifact nobody commented on has no comments file.
    pub fn comments(&self, id: &str) -> Result<Comments, String> {
        let path = self.dir(id)?.join("comments.json");
        if !path.is_file() {
            return Ok(Comments::default());
        }
        let text = fs::read_to_string(&path).map_err(|e| err("cannot read", &path, e))?;
        serde_json::from_str(&text).map_err(|e| err("cannot parse", &path, e))
    }

    pub fn save_artifact(&self, artifact: &Artifact) -> Result<(), String> {
        write_whole(&self.dir(&artifact.id)?.join("artifact.json"), &to_json(artifact))
    }

    pub fn save_comments(&self, id: &str, comments: &Comments) -> Result<(), String> {
        write_whole(&self.dir(id)?.join("comments.json"), &to_json(comments))
    }

    /// Copies the published content into `v<n>/<file>` and returns where it is.
    pub fn snapshot(&self, id: &str, n: u32, file: &str, content: &[u8]) -> Result<PathBuf, String> {
        let path = self.version_path(id, n, file)?;
        write_whole(&path, content)?;
        Ok(path)
    }

    pub fn version_path(&self, id: &str, n: u32, file: &str) -> Result<PathBuf, String> {
        Ok(self.dir(id)?.join(format!("v{n}")).join(file))
    }

    /// The artifact holding a comment. Comment ids are unique inside an artifact, so two artifacts
    /// can share one: then the caller has to say which.
    pub fn owner_of(&self, comment: &str) -> Result<String, String> {
        let mut owners = Vec::new();
        for id in self.ids()? {
            if self.comments(&id)?.comments.iter().any(|c| c.id == comment) {
                owners.push(id);
            }
        }
        match owners.as_slice() {
            [one] => Ok(one.clone()),
            [] => Err(format!("no comment {comment}")),
            many => Err(format!("comment {comment} is on several artifacts ({}): pass --artifact", many.join(", "))),
        }
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(value).expect("store types serialize");
    text.push('\n');
    text.into_bytes()
}

fn write_whole(path: &Path, content: &[u8]) -> Result<(), String> {
    let dir = path.parent().expect("store paths have a parent");
    fs::create_dir_all(dir).map_err(|e| err("cannot create", dir, e))?;
    let temp = dir.join(format!(".tmp-{}", std::process::id()));
    fs::write(&temp, content).map_err(|e| err("cannot write", &temp, e))?;
    fs::rename(&temp, path).map_err(|e| err("cannot write", path, e))
}
