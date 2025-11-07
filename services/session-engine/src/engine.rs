// Session Engine
// Core session management logic

use anyhow::{anyhow, Context, Result};
use chrono::Utc;
use std::path::PathBuf;
use tracing::{debug, error, info};

use crate::dtach::{validate_session_name, DtachProcess};
use crate::registry::SessionRegistry;
use crate::scrollback::ScrollbackManager;
use crate::types::*;

/// Main session engine
pub struct SessionEngine {
    /// Session registry
    registry: SessionRegistry,

    /// Scrollback manager
    scrollback: ScrollbackManager,

    /// Path to dtach binary
    dtach_path: PathBuf,

    /// Base directory for sockets (~/.aimaestro/sockets/)
    socket_dir: PathBuf,
}

impl SessionEngine {
    /// Create new session engine
    ///
    /// # Arguments
    /// * `config` - Engine configuration
    ///
    /// # Returns
    /// * `Ok(SessionEngine)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn new(config: EngineConfig) -> Result<Self> {
        info!("Initializing session engine");

        let registry = SessionRegistry::new(config.registry_path)?;
        let scrollback =
            ScrollbackManager::new(config.scrollback_dir, Some(config.max_scrollback_lines))?;

        // Ensure socket directory exists
        std::fs::create_dir_all(&config.socket_dir).context("Failed to create socket directory")?;

        Ok(Self {
            registry,
            scrollback,
            dtach_path: config.dtach_binary,
            socket_dir: config.socket_dir,
        })
    }

    /// List all sessions
    ///
    /// # Returns
    /// Vector of session entries
    pub fn list_sessions(&self) -> Vec<SessionEntry> {
        self.registry.list()
    }

    /// Create a new session
    ///
    /// # Arguments
    /// * `request` - Session creation request
    ///
    /// # Returns
    /// * `Ok(CreateSessionResponse)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn create_session(
        &mut self,
        request: CreateSessionRequest,
    ) -> Result<CreateSessionResponse> {
        // Validate session name
        if !validate_session_name(&request.name) {
            return Err(anyhow!("Invalid session name: must match ^[A-Za-z0-9_-]+$"));
        }

        // Check if session already exists
        if self.registry.exists(&request.name) {
            return Err(anyhow!("Session already exists: {}", request.name));
        }

        info!("Creating session: {}", request.name);

        // Determine shell to use
        let shell = request.shell.unwrap_or_else(|| {
            std::env::var("SHELL")
                .unwrap_or_else(|_| "/bin/bash".to_string())
                .into()
        });

        // Build socket path
        let socket_path = self.socket_dir.join(format!("{}.sock", request.name));

        // Prepare environment variables
        let mut env = request.env.clone();
        // Always set AIMAESTRO_SESSION so scripts can detect current session
        env.insert("AIMAESTRO_SESSION".to_string(), request.name.clone());

        // Spawn dtach session
        let dtach = DtachProcess::spawn_new(
            &self.dtach_path,
            socket_path.clone(),
            shell,
            request.cwd.clone(),
            env.clone(),
        )
        .map_err(|err| {
            error!(
                "Failed to spawn dtach for session {}: {}",
                request.name, err
            );
            err
        })?;

        // Create session entry
        let session = SessionEntry {
            id: request.name.clone(),
            socket_path: socket_path.clone(),
            cwd: request.cwd,
            created_at: Utc::now(),
            last_activity: Utc::now(),
            env, // Use the modified env with AIMAESTRO_SESSION
            agent_id: None,
            status: SessionStatus::Active,
            pid: dtach.pid,
        };

        // Register session
        self.registry.upsert(session)?;

        info!("Session created: {}", request.name);

        Ok(CreateSessionResponse {
            id: request.name,
            socket_path,
        })
    }

    /// Get socket path for attaching to a session
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(AttachSessionResponse)` on success
    /// * `Err(anyhow::Error)` if session not found
    pub fn attach_session(&mut self, id: &SessionId) -> Result<AttachSessionResponse> {
        let socket_path = {
            let session = self
                .registry
                .get(id)
                .ok_or_else(|| anyhow!("Session not found: {}", id))?;
            session.socket_path.clone()
        };
        // Update last activity
        self.registry.update_activity(id)?;

        debug!("Attaching to session: {}", id);

        Ok(AttachSessionResponse { socket_path })
    }

    /// Delete a session
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(DeleteSessionResponse)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn delete_session(&mut self, id: &SessionId) -> Result<DeleteSessionResponse> {
        info!("Deleting session: {}", id);

        let session = self
            .registry
            .get(id)
            .ok_or_else(|| anyhow!("Session not found: {}", id))?;

        // Kill dtach process
        let dtach = DtachProcess {
            socket_path: session.socket_path.clone(),
            pid: session.pid,
        };
        dtach.kill()?;

        // Delete scrollback
        self.scrollback.delete(id)?;

        // Remove from registry
        self.registry.remove(id)?;

        info!("Session deleted: {}", id);

        Ok(DeleteSessionResponse { deleted: true })
    }

    /// Get session metadata
    ///
    /// # Arguments
    /// * `id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(SessionEntry)` on success
    /// * `Err(anyhow::Error)` if session not found
    pub fn get_metadata(&self, id: &SessionId) -> Result<SessionEntry> {
        self.registry
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("Session not found: {}", id))
    }

    /// Get scrollback history
    ///
    /// # Arguments
    /// * `id` - Session identifier
    /// * `lines` - Number of lines to read
    ///
    /// # Returns
    /// * `Ok(GetScrollbackResponse)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn get_scrollback(&self, id: &SessionId, lines: usize) -> Result<GetScrollbackResponse> {
        debug!("Reading scrollback for {}: {} lines", id, lines);

        let (content, total_lines) = self.scrollback.read_history(id, lines)?;

        Ok(GetScrollbackResponse {
            content,
            total_lines,
        })
    }

    /// Capture output for scrollback
    ///
    /// # Arguments
    /// * `id` - Session identifier
    /// * `data` - Output data
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn capture_output(&mut self, id: &SessionId, data: &[u8]) -> Result<()> {
        self.scrollback.capture_output(id, data)?;
        self.registry.update_activity(id)?;
        Ok(())
    }
}

/// Engine configuration
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Path to dtach binary
    pub dtach_binary: PathBuf,

    /// Directory for session registry file
    pub registry_path: PathBuf,

    /// Directory for socket files
    pub socket_dir: PathBuf,

    /// Directory for scrollback files
    pub scrollback_dir: PathBuf,

    /// Maximum scrollback lines per session
    pub max_scrollback_lines: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let base_dir = PathBuf::from(home).join(".aimaestro");

        Self {
            dtach_binary: PathBuf::from("/usr/local/bin/dtach"),
            registry_path: base_dir.join("sessions.json"),
            socket_dir: base_dir.join("sockets"),
            scrollback_dir: base_dir.join("scrollback"),
            max_scrollback_lines: 50_000,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_engine_config_default() {
        let config = EngineConfig::default();
        assert!(config
            .registry_path
            .to_str()
            .unwrap()
            .contains(".aimaestro"));
    }

    #[test]
    fn test_session_name_validation() {
        // This would test actual engine creation if dtach binary exists
        // For now, just verify config creation works
        let _ = EngineConfig::default();
    }
}
