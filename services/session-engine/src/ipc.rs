// IPC Server
// Unix domain socket server for session engine communication

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;
use tracing::{debug, error, info};

use crate::engine::SessionEngine;
use crate::types::*;

/// IPC message wrapper
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IpcMessage {
    id: String,
    #[serde(flatten)]
    request: IpcRequest,
}

/// IPC server
pub struct IpcServer {
    /// Session engine (shared across connections)
    engine: Arc<Mutex<SessionEngine>>,

    /// Socket path
    socket_path: PathBuf,
}

impl IpcServer {
    /// Create new IPC server
    ///
    /// # Arguments
    /// * `engine` - Session engine instance
    /// * `socket_path` - Path to Unix domain socket
    ///
    /// # Returns
    /// * `Ok(IpcServer)` on success
    /// * `Err(anyhow::Error)` on failure
    pub fn new(engine: SessionEngine, socket_path: PathBuf) -> Result<Self> {
        Ok(Self {
            engine: Arc::new(Mutex::new(engine)),
            socket_path,
        })
    }

    /// Start IPC server
    ///
    /// This is a blocking call that runs the server loop.
    ///
    /// # Returns
    /// * `Ok(())` on graceful shutdown
    /// * `Err(anyhow::Error)` on failure
    pub async fn listen(&self) -> Result<()> {
        // Remove existing socket if it exists
        if self.socket_path.exists() {
            info!("Removing existing socket at {:?}", self.socket_path);
            std::fs::remove_file(&self.socket_path).context("Failed to remove existing socket")?;
        }

        // Ensure parent directory exists
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create socket directory")?;
        }

        // Bind to Unix socket
        let listener =
            UnixListener::bind(&self.socket_path).context("Failed to bind to Unix socket")?;

        info!("IPC server listening on {:?}", self.socket_path);

        // Accept connections
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    debug!("New client connection");
                    let engine = Arc::clone(&self.engine);

                    // Spawn task to handle client
                    tokio::spawn(async move {
                        if let Err(e) = handle_client(stream, engine).await {
                            error!("Client handler error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    error!("Failed to accept connection: {}", e);
                }
            }
        }
    }
}

/// Handle a single client connection
async fn handle_client(stream: UnixStream, engine: Arc<Mutex<SessionEngine>>) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();

        // Read line from client
        let bytes_read = reader
            .read_line(&mut line)
            .await
            .context("Failed to read from client")?;

        if bytes_read == 0 {
            debug!("Client disconnected");
            break;
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        debug!("Received request: {}", line);

        // Parse request
        let message: IpcMessage = match serde_json::from_str(line) {
            Ok(msg) => msg,
            Err(e) => {
                error!("Failed to parse request: {}", e);
                let error_response = create_error_response("invalid-request", &e.to_string());
                send_response(&mut writer, &error_response).await?;
                continue;
            }
        };

        // Handle request
        let response = handle_request(message.id.clone(), message.request, &engine).await;

        // Send response
        send_response(&mut writer, &response).await?;
    }

    Ok(())
}

/// Handle a single IPC request
async fn handle_request(
    request_id: String,
    request: IpcRequest,
    engine: &Arc<Mutex<SessionEngine>>,
) -> String {
    match request {
        IpcRequest::ListSessions => {
            let engine = engine.lock().await;
            let sessions = engine.list_sessions();
            let response = ListSessionsResponse { sessions };
            create_success_response(&request_id, &response)
        }

        IpcRequest::CreateSession(req) => {
            let mut engine = engine.lock().await;
            match engine.create_session(req) {
                Ok(response) => create_success_response(&request_id, &response),
                Err(e) => create_error_response(&request_id, &e.to_string()),
            }
        }

        IpcRequest::AttachSession { id } => {
            let mut engine = engine.lock().await;
            match engine.attach_session(&id) {
                Ok(response) => create_success_response(&request_id, &response),
                Err(e) => create_error_response(&request_id, &e.to_string()),
            }
        }

        IpcRequest::DeleteSession { id } => {
            let mut engine = engine.lock().await;
            match engine.delete_session(&id) {
                Ok(response) => create_success_response(&request_id, &response),
                Err(e) => create_error_response(&request_id, &e.to_string()),
            }
        }

        IpcRequest::GetMetadata { id } => {
            let engine = engine.lock().await;
            match engine.get_metadata(&id) {
                Ok(metadata) => create_success_response(&request_id, &metadata),
                Err(e) => create_error_response(&request_id, &e.to_string()),
            }
        }

        IpcRequest::GetScrollback { id, lines } => {
            let engine = engine.lock().await;
            match engine.get_scrollback(&id, lines) {
                Ok(response) => create_success_response(&request_id, &response),
                Err(e) => create_error_response(&request_id, &e.to_string()),
            }
        }
    }
}

/// Create success response
fn create_success_response<T: Serialize>(id: &str, result: &T) -> String {
    let response = IpcResponse {
        id: id.to_string(),
        result: Some(result),
        error: None,
    };

    serde_json::to_string(&response).unwrap_or_else(|e| {
        error!("Failed to serialize response: {}", e);
        format!(
            r#"{{"id":"{}","result":null,"error":"Serialization failed"}}"#,
            id
        )
    })
}

/// Create error response
fn create_error_response(id: &str, error: &str) -> String {
    let response: IpcResponse<()> = IpcResponse {
        id: id.to_string(),
        result: None,
        error: Some(error.to_string()),
    };

    serde_json::to_string(&response).unwrap_or_else(|e| {
        error!("Failed to serialize error response: {}", e);
        format!(r#"{{"id":"{}","result":null,"error":"{}"}}"#, id, error)
    })
}

/// Send response to client
async fn send_response(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    response: &str,
) -> Result<()> {
    writer
        .write_all(response.as_bytes())
        .await
        .context("Failed to write response")?;
    writer
        .write_all(b"\n")
        .await
        .context("Failed to write newline")?;
    writer.flush().await.context("Failed to flush response")?;

    debug!("Sent response: {}", response);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::EngineConfig;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn test_ipc_response_creation() {
        let response = ListSessionsResponse { sessions: vec![] };
        let json = create_success_response("test-1", &response);

        assert!(json.contains("\"id\":\"test-1\""));
        assert!(json.contains("\"result\""));
    }

    #[tokio::test]
    async fn test_ipc_error_response() {
        let json = create_error_response("test-2", "Test error");

        assert!(json.contains("\"id\":\"test-2\""));
        assert!(json.contains("\"error\":\"Test error\""));
    }

    #[tokio::test]
    async fn test_ipc_message_parsing() {
        let json = r#"{"id":"test-3","method":"list_sessions","params":{}}"#;
        let message: Result<IpcMessage, _> = serde_json::from_str(json);

        assert!(message.is_ok());
        let message = message.unwrap();
        assert_eq!(message.id, "test-3");
    }
}
