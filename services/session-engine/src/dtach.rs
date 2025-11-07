// dtach Process Management
// Wrapper for spawning and managing dtach sessions

use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tracing::{debug, info};

/// dtach process manager
pub struct DtachProcess {
    /// Path to dtach socket
    pub socket_path: PathBuf,

    /// Process ID of dtach master (if available)
    pub pid: Option<u32>,
}

impl DtachProcess {
    /// Spawn a new dtach session
    ///
    /// # Arguments
    /// * `dtach_binary` - Path to dtach executable
    /// * `socket` - Path where socket should be created
    /// * `shell` - Shell command to execute
    /// * `cwd` - Working directory
    /// * `env` - Environment variables to set
    ///
    /// # Returns
    /// * `Ok(DtachProcess)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn spawn_new(
        dtach_binary: &PathBuf,
        socket: PathBuf,
        shell: PathBuf,
        cwd: PathBuf,
        env: HashMap<String, String>,
    ) -> Result<Self> {
        info!(
            "Spawning dtach session: socket={:?}, shell={:?}",
            socket, shell
        );

        // Ensure socket parent directory exists
        if let Some(parent) = socket.parent() {
            std::fs::create_dir_all(parent).context("Failed to create socket directory")?;
        }

        // Execute: dtach -n <socket> <shell>
        let mut command = Command::new(dtach_binary);
        command
            .arg("-n")
            .arg(&socket)
            .arg(&shell)
            .current_dir(&cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());

        // Set environment variables
        for (key, value) in env.iter() {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(|error| {
            anyhow!(
                "Failed to spawn dtach process (binary: {:?}): {}",
                dtach_binary,
                error
            )
        })?;

        if let Ok(Some(status)) = child.try_wait() {
            let mut stderr_output = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                let _ = stderr.read_to_string(&mut stderr_output);
            }
            let message = if stderr_output.trim().is_empty() {
                format!("dtach exited immediately with status {}", status)
            } else {
                format!(
                    "dtach exited immediately with status {}: {}",
                    status, stderr_output
                )
            };
            return Err(anyhow!(message));
        }

        // Close stderr handle so dtach is not blocked if we don't read it
        if let Some(mut stderr) = child.stderr.take() {
            debug!("dtach starting, closing stderr pipe");
            // Drain once to avoid blocking if there is already data
            let mut buffer = String::new();
            let _ = stderr.read_to_string(&mut buffer);
        }

        let pid = child.id();

        debug!("dtach spawned: pid={}, socket={:?}", pid, socket);

        Ok(Self {
            socket_path: socket,
            pid: Some(pid),
        })
    }

    /// Check if dtach session is still alive
    ///
    /// # Returns
    /// * `true` if socket exists and is accessible
    /// * `false` otherwise
    pub fn is_alive(&self) -> bool {
        self.socket_path.exists()
    }

    /// Kill dtach session by removing socket
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn kill(&self) -> Result<()> {
        if self.socket_path.exists() {
            info!("Killing dtach session: socket={:?}", self.socket_path);
            std::fs::remove_file(&self.socket_path).context("Failed to remove dtach socket")?;
        }

        Ok(())
    }

    /// Get socket path for attaching
    ///
    /// # Returns
    /// Socket path if session is alive
    pub fn socket_path(&self) -> Option<&PathBuf> {
        if self.is_alive() {
            Some(&self.socket_path)
        } else {
            None
        }
    }
}

/// Validate session name follows dtach/tmux naming conventions
///
/// # Arguments
/// * `name` - Session name to validate
///
/// # Returns
/// * `true` if name is valid (^[A-Za-z0-9_-]+$)
/// * `false` otherwise
pub fn validate_session_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }

    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_session_name() {
        assert!(validate_session_name("test-session"));
        assert!(validate_session_name("test_session"));
        assert!(validate_session_name("test123"));
        assert!(validate_session_name("TestSession"));

        assert!(!validate_session_name(""));
        assert!(!validate_session_name("test session"));
        assert!(!validate_session_name("test.session"));
        assert!(!validate_session_name("test/session"));
        assert!(!validate_session_name("test@session"));
    }
}
