// Session Engine Types
// Type definitions for AI Maestro session management

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Unique session identifier (must match pattern: ^[A-Za-z0-9_-]+$)
pub type SessionId = String;

/// Session metadata stored in registry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEntry {
    /// Unique session identifier
    pub id: SessionId,

    /// Path to dtach socket file
    pub socket_path: PathBuf,

    /// Working directory where session was created
    pub cwd: PathBuf,

    /// Session creation timestamp
    pub created_at: DateTime<Utc>,

    /// Last activity timestamp
    pub last_activity: DateTime<Utc>,

    /// Environment variables captured at session creation
    pub env: HashMap<String, String>,

    /// Optional agent ID if session is linked to an AI agent
    pub agent_id: Option<String>,

    /// Session status
    pub status: SessionStatus,

    /// Process ID of dtach master (if available)
    pub pid: Option<u32>,
}

/// Session status enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    /// Session is active and running
    Active,

    /// Session is detached but alive
    Detached,

    /// Session has exited/died
    Dead,
}

/// Request to create a new session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    /// Session name (must match ^[A-Za-z0-9_-]+$)
    pub name: String,

    /// Working directory for the session
    pub cwd: PathBuf,

    /// Environment variables to set
    #[serde(default)]
    pub env: HashMap<String, String>,

    /// Shell command to run (defaults to $SHELL or /bin/bash)
    pub shell: Option<PathBuf>,
}

/// IPC Request types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum IpcRequest {
    /// List all sessions
    #[serde(rename = "list_sessions")]
    ListSessions,

    /// Create a new session
    #[serde(rename = "create_session")]
    CreateSession(CreateSessionRequest),

    /// Get socket path for attaching to a session
    #[serde(rename = "attach_session")]
    AttachSession { id: SessionId },

    /// Delete a session
    #[serde(rename = "delete_session")]
    DeleteSession { id: SessionId },

    /// Get session metadata
    #[serde(rename = "get_metadata")]
    GetMetadata { id: SessionId },

    /// Get scrollback history
    #[serde(rename = "get_scrollback")]
    GetScrollback {
        id: SessionId,
        lines: usize,
    },
}

/// IPC Response types
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResponse<T> {
    /// Request ID (matches request)
    pub id: String,

    /// Response result (if successful)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,

    /// Error message (if failed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// List sessions response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSessionsResponse {
    pub sessions: Vec<SessionEntry>,
}

/// Create session response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionResponse {
    pub id: SessionId,
    pub socket_path: PathBuf,
}

/// Attach session response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachSessionResponse {
    pub socket_path: PathBuf,
}

/// Delete session response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteSessionResponse {
    pub deleted: bool,
}

/// Get scrollback response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetScrollbackResponse {
    pub content: String,
    pub total_lines: usize,
}
