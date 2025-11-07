// Session Registry
// Persistent storage for session metadata

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tracing::{debug, info, warn};

use crate::types::{SessionEntry, SessionId, SessionStatus};

/// Registry file format version
const REGISTRY_VERSION: &str = "1.0";

/// Session registry manages persistent session metadata
#[derive(Debug)]
pub struct SessionRegistry {
    /// In-memory session map
    sessions: HashMap<SessionId, SessionEntry>,

    /// Path to registry file (~/.aimaestro/sessions.json)
    file_path: PathBuf,
}

/// Serializable registry format
#[derive(Debug, Serialize, Deserialize)]
struct RegistryFile {
    version: String,
    sessions: HashMap<SessionId, SessionEntry>,
}

impl SessionRegistry {
    /// Create or load session registry
    ///
    /// # Arguments
    /// * `file_path` - Path to registry JSON file
    ///
    /// # Returns
    /// * `Ok(SessionRegistry)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn new(file_path: PathBuf) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create registry directory")?;
        }

        // Load existing registry or create empty
        let sessions = if file_path.exists() {
            Self::load_from_disk(&file_path)?
        } else {
            info!("Creating new session registry at {:?}", file_path);
            HashMap::new()
        };

        Ok(Self {
            sessions,
            file_path,
        })
    }

    /// Load registry from disk
    fn load_from_disk(path: &PathBuf) -> Result<HashMap<SessionId, SessionEntry>> {
        let contents = std::fs::read_to_string(path).context("Failed to read registry file")?;

        let registry: RegistryFile =
            serde_json::from_str(&contents).context("Failed to parse registry JSON")?;

        debug!("Loaded {} sessions from registry", registry.sessions.len());

        Ok(registry.sessions)
    }

    /// Save registry to disk
    fn save_to_disk(&self) -> Result<()> {
        let registry = RegistryFile {
            version: REGISTRY_VERSION.to_string(),
            sessions: self.sessions.clone(),
        };

        let contents =
            serde_json::to_string_pretty(&registry).context("Failed to serialize registry")?;

        std::fs::write(&self.file_path, contents).context("Failed to write registry file")?;

        debug!("Saved {} sessions to registry", self.sessions.len());

        Ok(())
    }

    /// Add or update a session
    ///
    /// # Arguments
    /// * `session` - Session entry to add/update
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn upsert(&mut self, session: SessionEntry) -> Result<()> {
        let id = session.id.clone();
        self.sessions.insert(id.clone(), session);
        self.save_to_disk()?;
        info!("Session registered: {}", id);
        Ok(())
    }

    /// Get a session by ID
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Some(SessionEntry)` if found
    /// * `None` if not found
    pub fn get(&self, id: &SessionId) -> Option<&SessionEntry> {
        self.sessions.get(id)
    }

    /// Get mutable reference to a session
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Some(&mut SessionEntry)` if found
    /// * `None` if not found
    pub fn get_mut(&mut self, id: &SessionId) -> Option<&mut SessionEntry> {
        self.sessions.get_mut(id)
    }

    /// Remove a session
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn remove(&mut self, id: &SessionId) -> Result<()> {
        if self.sessions.remove(id).is_some() {
            self.save_to_disk()?;
            info!("Session removed: {}", id);
        } else {
            warn!("Attempted to remove non-existent session: {}", id);
        }
        Ok(())
    }

    /// List all sessions
    ///
    /// # Returns
    /// Vector of all session entries
    pub fn list(&self) -> Vec<SessionEntry> {
        self.sessions.values().cloned().collect()
    }

    /// Update session status
    ///
    /// # Arguments
    /// * `id` - Session identifier
    /// * `status` - New status
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` if session not found
    pub fn update_status(&mut self, id: &SessionId, status: SessionStatus) -> Result<()> {
        let session = self.sessions.get_mut(id).context("Session not found")?;

        session.status = status;
        self.save_to_disk()?;

        Ok(())
    }

    /// Update session last activity timestamp
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` if session not found
    pub fn update_activity(&mut self, id: &SessionId) -> Result<()> {
        let session = self.sessions.get_mut(id).context("Session not found")?;

        session.last_activity = chrono::Utc::now();
        self.save_to_disk()?;

        Ok(())
    }

    /// Check if session exists
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `true` if session exists
    /// * `false` otherwise
    pub fn exists(&self, id: &SessionId) -> bool {
        self.sessions.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::collections::HashMap;

    #[test]
    fn test_registry_lifecycle() {
        let temp_dir = std::env::temp_dir();
        let registry_path = temp_dir.join("test-registry.json");

        // Clean up any existing test file
        let _ = std::fs::remove_file(&registry_path);

        // Create new registry
        let mut registry = SessionRegistry::new(registry_path.clone()).unwrap();

        // Add session
        let session = SessionEntry {
            id: "test-session".to_string(),
            socket_path: PathBuf::from("/tmp/test.sock"),
            cwd: PathBuf::from("/tmp"),
            created_at: Utc::now(),
            last_activity: Utc::now(),
            env: HashMap::new(),
            agent_id: None,
            status: SessionStatus::Active,
            pid: Some(1234),
        };

        registry.upsert(session.clone()).unwrap();

        // Verify session exists
        assert!(registry.exists(&"test-session".to_string()));

        // Load registry from disk
        let registry2 = SessionRegistry::new(registry_path.clone()).unwrap();
        assert!(registry2.exists(&"test-session".to_string()));

        // Clean up
        let _ = std::fs::remove_file(&registry_path);
    }
}
