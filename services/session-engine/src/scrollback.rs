// Scrollback Manager
// Captures and stores terminal output for history replay

use anyhow::{Context, Result};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use tracing::{debug, warn};

use crate::types::SessionId;

/// Default maximum scrollback lines (matches tmux default)
pub const DEFAULT_MAX_LINES: usize = 50_000;

/// Scrollback manager handles terminal output capture
pub struct ScrollbackManager {
    /// Base directory for scrollback files (~/.aimaestro/scrollback/)
    base_dir: PathBuf,

    /// Maximum lines to keep per session
    max_lines: usize,
}

impl ScrollbackManager {
    /// Create new scrollback manager
    ///
    /// # Arguments
    /// * `base_dir` - Directory to store scrollback files
    /// * `max_lines` - Maximum lines to keep (ring buffer)
    ///
    /// # Returns
    /// * `Ok(ScrollbackManager)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn new(base_dir: PathBuf, max_lines: Option<usize>) -> Result<Self> {
        std::fs::create_dir_all(&base_dir).context("Failed to create scrollback directory")?;

        Ok(Self {
            base_dir,
            max_lines: max_lines.unwrap_or(DEFAULT_MAX_LINES),
        })
    }

    /// Get scrollback file path for a session
    ///
    /// # Arguments
    /// * `session_id` - Session identifier
    ///
    /// # Returns
    /// Path to scrollback file
    fn get_file_path(&self, session_id: &SessionId) -> PathBuf {
        self.base_dir.join(format!("{}.log", session_id))
    }

    /// Capture output from a session
    ///
    /// # Arguments
    /// * `session_id` - Session identifier
    /// * `data` - Output data to append
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn capture_output(&self, session_id: &SessionId, data: &[u8]) -> Result<()> {
        let file_path = self.get_file_path(session_id);

        // Open file in append mode
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .context("Failed to open scrollback file")?;

        // Write data
        file.write_all(data)
            .context("Failed to write to scrollback file")?;

        // Trim if needed (async operation to avoid blocking)
        self.trim_if_needed(session_id)?;

        Ok(())
    }

    /// Read scrollback history
    ///
    /// # Arguments
    /// * `session_id` - Session identifier
    /// * `lines` - Number of lines to read (from end)
    ///
    /// # Returns
    /// * `Ok((content, total_lines))` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn read_history(&self, session_id: &SessionId, lines: usize) -> Result<(String, usize)> {
        let file_path = self.get_file_path(session_id);

        if !file_path.exists() {
            debug!("No scrollback file for session: {}", session_id);
            return Ok((String::new(), 0));
        }

        let file = File::open(&file_path).context("Failed to open scrollback file")?;

        let reader = BufReader::new(file);
        let all_lines: Vec<String> = reader
            .lines()
            .collect::<std::io::Result<Vec<_>>>()
            .context("Failed to read scrollback lines")?;

        let total_lines = all_lines.len();
        let start_index = if all_lines.len() > lines {
            all_lines.len() - lines
        } else {
            0
        };

        let content = all_lines[start_index..].join("\n");

        Ok((content, total_lines))
    }

    /// Trim scrollback file if it exceeds max_lines
    ///
    /// # Arguments
    /// * `session_id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    fn trim_if_needed(&self, session_id: &SessionId) -> Result<()> {
        let file_path = self.get_file_path(session_id);

        let file = File::open(&file_path).context("Failed to open scrollback file for trimming")?;

        let reader = BufReader::new(file);
        let lines: Vec<String> = reader
            .lines()
            .collect::<std::io::Result<Vec<_>>>()
            .context("Failed to read lines for trimming")?;

        if lines.len() > self.max_lines {
            warn!(
                "Trimming scrollback for {}: {} lines -> {}",
                session_id,
                lines.len(),
                self.max_lines
            );

            // Keep last max_lines
            let start_index = lines.len() - self.max_lines;
            let trimmed = lines[start_index..].join("\n") + "\n";

            std::fs::write(&file_path, trimmed).context("Failed to write trimmed scrollback")?;
        }

        Ok(())
    }

    /// Delete scrollback file for a session
    ///
    /// # Arguments
    /// * `session_id` - Session identifier
    ///
    /// # Returns
    /// * `Ok(())` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn delete(&self, session_id: &SessionId) -> Result<()> {
        let file_path = self.get_file_path(session_id);

        if file_path.exists() {
            std::fs::remove_file(&file_path).context("Failed to delete scrollback file")?;
            debug!("Deleted scrollback for session: {}", session_id);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scrollback_capture_and_read() {
        let temp_dir = std::env::temp_dir().join("test-scrollback");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let manager = ScrollbackManager::new(temp_dir.clone(), Some(100)).unwrap();
        let session_id = "test-session".to_string();

        // Capture some output
        manager.capture_output(&session_id, b"Line 1\n").unwrap();
        manager.capture_output(&session_id, b"Line 2\n").unwrap();
        manager.capture_output(&session_id, b"Line 3\n").unwrap();

        // Read back
        let (content, total_lines) = manager.read_history(&session_id, 10).unwrap();
        assert_eq!(total_lines, 3);
        assert!(content.contains("Line 1"));
        assert!(content.contains("Line 3"));

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_scrollback_trimming() {
        let temp_dir = std::env::temp_dir().join("test-scrollback-trim");
        let _ = std::fs::remove_dir_all(&temp_dir);

        let manager = ScrollbackManager::new(temp_dir.clone(), Some(5)).unwrap();
        let session_id = "test-session".to_string();

        // Add 10 lines (should trim to 5)
        for i in 1..=10 {
            manager
                .capture_output(&session_id, format!("Line {}\n", i).as_bytes())
                .unwrap();
        }

        // Read back - should only have last 5 lines
        let (content, total_lines) = manager.read_history(&session_id, 100).unwrap();
        assert!(total_lines <= 5, "Expected <= 5 lines, got {}", total_lines);
        assert!(content.contains("Line 10"));

        // Clean up
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
