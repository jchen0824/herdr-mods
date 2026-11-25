use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::{Artifact, ArtifactId, Comments};

pub struct Store {
    root: PathBuf,
}

pub struct Lock {
    _held: fs::File,
}

fn err(what: &str, path: &Path, e: impl std::fmt::Display) -> String {
    format!("{what} {}: {e}", path.display())
}

impl Store {
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

    fn dir(&self, id: &ArtifactId) -> PathBuf {
        self.root.join(id.as_str())
    }

    pub fn lock(&self) -> Result<Lock, String> {
        let path = self.root.join(".lock");
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(|e| err("cannot lock", &path, e))?;
        file.lock().map_err(|e| err("cannot lock", &path, e))?;
        Ok(Lock { _held: file })
    }

    pub fn ids(&self) -> Result<Vec<ArtifactId>, String> {
        let mut ids: Vec<ArtifactId> = fs::read_dir(&self.root)
            .map_err(|e| err("cannot read", &self.root, e))?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok()?.parse().ok())
            .filter(|id| self.exists(id))
            .collect();
        ids.sort();
        Ok(ids)
    }

    pub fn exists(&self, id: &ArtifactId) -> bool {
        self.dir(id).join("artifact.json").is_file()
    }

    pub fn artifact(&self, id: &ArtifactId) -> Result<Artifact, String> {
        let path = self.dir(id).join("artifact.json");
        if !path.is_file() {
            return Err(format!("no artifact {id}"));
        }
        let text = fs::read_to_string(&path).map_err(|e| err("cannot read", &path, e))?;
        serde_json::from_str(&text).map_err(|e| err("cannot parse", &path, e))
    }

    pub fn comments(&self, id: &ArtifactId) -> Result<Comments, String> {
        let path = self.dir(id).join("comments.json");
        if !path.is_file() {
            return Ok(Comments::default());
        }
        let text = fs::read_to_string(&path).map_err(|e| err("cannot read", &path, e))?;
        serde_json::from_str(&text).map_err(|e| err("cannot parse", &path, e))
    }

    pub fn comment_ids(&self) -> Result<HashSet<String>, String> {
        let mut ids = HashSet::new();
        for id in self.ids()? {
            ids.extend(self.comments(&id)?.comments.into_iter().map(|c| c.id));
        }
        Ok(ids)
    }

    pub fn save_artifact(&self, artifact: &Artifact) -> Result<(), String> {
        write_whole(&self.dir(&artifact.id).join("artifact.json"), &to_json(artifact))
    }

    pub fn save_comments(&self, id: &ArtifactId, comments: &Comments) -> Result<(), String> {
        write_whole(&self.dir(id).join("comments.json"), &to_json(comments))
    }

    pub fn snapshot(&self, id: &ArtifactId, n: u32, file: &str, content: &[u8]) -> Result<PathBuf, String> {
        let path = self.version_path(id, n, file);
        write_whole(&path, content)?;
        Ok(path)
    }

    pub fn version_path(&self, id: &ArtifactId, n: u32, file: &str) -> PathBuf {
        self.dir(id).join(format!("v{n}")).join(file)
    }

    pub fn owner_of(&self, comment: &str) -> Result<ArtifactId, String> {
        for id in self.ids()? {
            if self.comments(&id)?.comments.iter().any(|c| c.id == comment) {
                return Ok(id);
            }
        }
        Err(format!("no comment {comment}"))
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
