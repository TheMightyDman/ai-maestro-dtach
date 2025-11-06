// Integration Tests for AI Maestro Session Engine
//
// These tests verify the complete session lifecycle through the IPC interface.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// IPC Request wrapper
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IpcRequest {
    id: String,
    method: String,
    params: serde_json::Value,
}

/// IPC Response wrapper
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IpcResponse {
    id: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

/// Test helper to send IPC request and get response
async fn send_ipc_request(
    socket_path: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut stream = UnixStream::connect(socket_path)
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    let request = IpcRequest {
        id: format!("test-{}", uuid::Uuid::new_v4()),
        method: method.to_string(),
        params,
    };

    let request_json = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    // Send request
    stream
        .write_all(request_json.as_bytes())
        .await
        .map_err(|e| format!("Failed to write request: {}", e))?;
    stream
        .write_all(b"\n")
        .await
        .map_err(|e| format!("Failed to write newline: {}", e))?;

    // Read response
    let (reader, _writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut response_line = String::new();

    reader
        .read_line(&mut response_line)
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let response: IpcResponse = serde_json::from_str(&response_line)
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    if let Some(error) = response.error {
        return Err(error);
    }

    response
        .result
        .ok_or_else(|| "No result in response".to_string())
}

/// Helper to create test engine configuration
fn get_test_config() -> (PathBuf, PathBuf, String) {
    let temp_dir = std::env::temp_dir();
    let test_id = uuid::Uuid::new_v4().to_string();
    let base_dir = temp_dir.join(format!("aimaestro-test-{}", test_id));
    let socket_path = temp_dir.join(format!("aimaestro-test-{}.sock", test_id));

    std::fs::create_dir_all(&base_dir).unwrap();

    (base_dir, socket_path, test_id)
}

/// Helper to start test engine in background
async fn start_test_engine(
    base_dir: PathBuf,
    socket_path: PathBuf,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // This would start the actual engine
        // For now, we'll skip this as we can't run the full engine in tests
        // without dtach binary
        tokio::time::sleep(Duration::from_secs(3600)).await;
    })
}

#[tokio::test]
#[ignore] // Requires running engine
async fn test_session_lifecycle() {
    let (base_dir, socket_path, test_id) = get_test_config();
    let socket_str = socket_path.to_str().unwrap();

    // Start test engine
    let _engine_task = start_test_engine(base_dir.clone(), socket_path.clone()).await;

    // Wait for engine to start
    tokio::time::sleep(Duration::from_millis(500)).await;

    // 1. List sessions (should be empty)
    let result = send_ipc_request(socket_str, "list_sessions", serde_json::json!({}))
        .await
        .unwrap();

    let sessions = result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 0, "Should start with no sessions");

    // 2. Create session
    let create_params = serde_json::json!({
        "name": format!("test-session-{}", test_id),
        "cwd": "/tmp",
        "env": {}
    });

    let result = send_ipc_request(socket_str, "create_session", create_params)
        .await
        .unwrap();

    let session_id = result["id"].as_str().unwrap();
    assert!(session_id.starts_with("test-session-"));

    // 3. List sessions (should have 1)
    let result = send_ipc_request(socket_str, "list_sessions", serde_json::json!({}))
        .await
        .unwrap();

    let sessions = result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1, "Should have 1 session after creation");

    // 4. Get metadata
    let metadata_params = serde_json::json!({ "id": session_id });
    let result = send_ipc_request(socket_str, "get_metadata", metadata_params)
        .await
        .unwrap();

    assert_eq!(result["id"].as_str().unwrap(), session_id);
    assert_eq!(result["cwd"].as_str().unwrap(), "/tmp");

    // 5. Attach session
    let attach_params = serde_json::json!({ "id": session_id });
    let result = send_ipc_request(socket_str, "attach_session", attach_params)
        .await
        .unwrap();

    let socket_path = result["socket_path"].as_str().unwrap();
    assert!(socket_path.contains(session_id));

    // 6. Delete session
    let delete_params = serde_json::json!({ "id": session_id });
    let result = send_ipc_request(socket_str, "delete_session", delete_params)
        .await
        .unwrap();

    assert_eq!(result["deleted"].as_bool().unwrap(), true);

    // 7. List sessions (should be empty again)
    let result = send_ipc_request(socket_str, "list_sessions", serde_json::json!({}))
        .await
        .unwrap();

    let sessions = result["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 0, "Should be empty after deletion");

    // Cleanup
    let _ = std::fs::remove_dir_all(&base_dir);
}

#[tokio::test]
#[ignore] // Requires running engine
async fn test_concurrent_requests() {
    let (base_dir, socket_path, _test_id) = get_test_config();
    let socket_str = socket_path.to_str().unwrap().to_string();

    // Start test engine
    let _engine_task = start_test_engine(base_dir.clone(), socket_path.clone()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Send multiple concurrent list_sessions requests
    let mut tasks = vec![];

    for _ in 0..10 {
        let socket_clone = socket_str.clone();
        let task = tokio::spawn(async move {
            send_ipc_request(&socket_clone, "list_sessions", serde_json::json!({})).await
        });
        tasks.push(task);
    }

    // All should succeed
    for task in tasks {
        let result = task.await.unwrap();
        assert!(result.is_ok(), "Concurrent request failed");
    }

    // Cleanup
    let _ = std::fs::remove_dir_all(&base_dir);
}

#[tokio::test]
#[ignore] // Requires running engine
async fn test_error_handling() {
    let (base_dir, socket_path, _test_id) = get_test_config();
    let socket_str = socket_path.to_str().unwrap();

    // Start test engine
    let _engine_task = start_test_engine(base_dir.clone(), socket_path.clone()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Try to get metadata for non-existent session
    let params = serde_json::json!({ "id": "non-existent-session" });
    let result = send_ipc_request(socket_str, "get_metadata", params).await;

    assert!(result.is_err(), "Should error for non-existent session");

    // Try to create session with invalid name
    let params = serde_json::json!({
        "name": "invalid/session/name",
        "cwd": "/tmp",
        "env": {}
    });
    let result = send_ipc_request(socket_str, "create_session", params).await;

    assert!(result.is_err(), "Should error for invalid session name");

    // Cleanup
    let _ = std::fs::remove_dir_all(&base_dir);
}

#[test]
fn test_session_name_validation() {
    // Valid names
    assert!(is_valid_session_name("test-session"));
    assert!(is_valid_session_name("test_session"));
    assert!(is_valid_session_name("TestSession123"));

    // Invalid names
    assert!(!is_valid_session_name(""));
    assert!(!is_valid_session_name("test session"));
    assert!(!is_valid_session_name("test/session"));
    assert!(!is_valid_session_name("test.session"));
    assert!(!is_valid_session_name("test@session"));
}

/// Helper function to validate session names
fn is_valid_session_name(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// Mock integration tests that don't require running engine

#[test]
fn test_ipc_request_serialization() {
    let request = IpcRequest {
        id: "test-1".to_string(),
        method: "list_sessions".to_string(),
        params: serde_json::json!({}),
    };

    let json = serde_json::to_string(&request).unwrap();
    assert!(json.contains("\"id\":\"test-1\""));
    assert!(json.contains("\"method\":\"list_sessions\""));
}

#[test]
fn test_ipc_response_parsing() {
    let json = r#"{"id":"test-1","result":{"sessions":[]},"error":null}"#;
    let response: IpcResponse = serde_json::from_str(json).unwrap();

    assert_eq!(response.id, "test-1");
    assert!(response.result.is_some());
    assert!(response.error.is_none());
}

#[test]
fn test_ipc_error_response_parsing() {
    let json = r#"{"id":"test-2","result":null,"error":"Test error"}"#;
    let response: IpcResponse = serde_json::from_str(json).unwrap();

    assert_eq!(response.id, "test-2");
    assert!(response.result.is_none());
    assert_eq!(response.error.unwrap(), "Test error");
}
