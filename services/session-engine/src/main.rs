// AI Maestro Session Engine
// dtach-backed session management daemon

mod dtach;
mod engine;
mod ipc;
mod registry;
mod scrollback;
mod types;

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use engine::{EngineConfig, SessionEngine};
use ipc::IpcServer;

fn resolve_path(cwd: &Path, candidate: PathBuf) -> PathBuf {
    if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    }
}

fn ensure_writable_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)
        .with_context(|| format!("Failed to create directory {:?}", dir))?;

    let probe = dir.join(".write-test");
    if probe.exists() {
        std::fs::remove_dir_all(&probe).ok();
    }

    std::fs::create_dir_all(&probe)
        .with_context(|| format!("Failed to create probe directory {:?}", probe))?;
    std::fs::remove_dir_all(&probe)
        .with_context(|| format!("Failed to remove probe directory {:?}", probe))?;

    Ok(())
}

fn canonicalize_if_executable(path: &Path) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }

    let metadata = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return None,
    };

    if !metadata.is_file() {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode();
        if mode & 0o111 == 0 {
            warn!("{:?} is not executable; skipping", path);
            return None;
        }
    }

    Some(std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))
}

fn resolve_dtach_binary(cwd: &Path) -> Result<PathBuf> {
    if let Ok(env_path) = std::env::var("AIMAESTRO_DTACH_PATH") {
        let candidate = resolve_path(cwd, PathBuf::from(env_path));
        if let Some(resolved) = canonicalize_if_executable(&candidate) {
            info!(
                "Using dtach binary from AIMAESTRO_DTACH_PATH={:?}",
                resolved
            );
            return Ok(resolved);
        }
        warn!(
            "AIMAESTRO_DTACH_PATH {:?} does not exist or is not executable",
            candidate
        );
    }

    let mut candidates = Vec::new();
    candidates.push(PathBuf::from("dist/bin/dtach"));
    candidates.push(PathBuf::from("../dist/bin/dtach"));
    candidates.push(
        PathBuf::from("services")
            .join("session-engine")
            .join("dist")
            .join("bin")
            .join("dtach"),
    );
    candidates.push(PathBuf::from("/usr/local/bin/dtach"));
    candidates.push(PathBuf::from("/usr/bin/dtach"));
    if let Some(path_env) = std::env::var_os("PATH") {
        for entry in std::env::split_paths(&path_env) {
            candidates.push(entry.join("dtach"));
        }
    }
    candidates.push(PathBuf::from("dtach"));

    for candidate in candidates {
        let resolved = resolve_path(cwd, candidate);
        if let Some(path) = canonicalize_if_executable(&resolved) {
            return Ok(path);
        }
    }

    Err(anyhow!(
        "dtach binary not found. Build it with `npm run build:dtach` (see docs/RUNTIME.md#build-prerequisites) or set AIMAESTRO_DTACH_PATH to the compiled binary."
    ))
}

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    info!(
        "Starting AI Maestro Session Engine v{}",
        env!("CARGO_PKG_VERSION")
    );

    // Load configuration
    let config = load_config()?;

    // Create IPC server
    let socket_path = std::env::var("AIMAESTRO_IPC_SOCKET")
        .map(|path| {
            let resolved = PathBuf::from(path);
            info!("Using IPC socket from AIMAESTRO_IPC_SOCKET={:?}", resolved);
            resolved
        })
        .unwrap_or_else(|_| {
            let default_path = config.socket_dir.join("aimaestro-engine.sock");
            info!(
                "AIMAESTRO_IPC_SOCKET not set, defaulting to {:?}",
                default_path
            );
            default_path
        });

    // Initialize engine
    let engine = SessionEngine::new(config).context("Failed to initialize session engine")?;

    info!("Session engine initialized successfully");
    info!("Sessions loaded: {}", engine.list_sessions().len());

    let server =
        IpcServer::new(engine, socket_path.clone()).context("Failed to create IPC server")?;

    println!("AI Maestro Session Engine v{}", env!("CARGO_PKG_VERSION"));
    println!("Status: Ready (Phase 1 - IPC Server Active)");
    println!("IPC Socket: {:?}", socket_path);
    println!();
    println!("Listening for connections...");

    // Start IPC server (blocking)
    server.listen().await.context("IPC server failed")?;

    Ok(())
}

/// Load engine configuration from environment variables and defaults
fn load_config() -> Result<EngineConfig> {
    let home = std::env::var("HOME").unwrap_or_else(|_| {
        error!("HOME environment variable not set, using /tmp");
        "/tmp".to_string()
    });

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let mut data_dir_candidates: Vec<PathBuf> = Vec::new();

    if let Ok(env_data_dir) = std::env::var("AIMAESTRO_DATA_DIR") {
        data_dir_candidates.push(resolve_path(&cwd, PathBuf::from(env_data_dir)));
    }

    data_dir_candidates.push(resolve_path(&cwd, PathBuf::from(&home).join(".aimaestro")));
    data_dir_candidates.push(resolve_path(&cwd, PathBuf::from("data").join(".aimaestro")));
    data_dir_candidates.push(resolve_path(
        &cwd,
        PathBuf::from("services")
            .join("session-engine")
            .join("data")
            .join(".aimaestro"),
    ));
    data_dir_candidates.push(std::env::temp_dir().join("aimaestro"));

    let mut base_dir = None;
    for candidate in data_dir_candidates {
        match ensure_writable_dir(&candidate) {
            Ok(()) => {
                base_dir = Some(candidate);
                break;
            }
            Err(error) => {
                warn!("Unable to use data directory {:?}: {}", candidate, error);
            }
        }
    }

    let base_dir =
        base_dir.context("Failed to find a writable data directory for the session engine")?;

    // Check if custom dtach path is provided
    let dtach_binary = resolve_dtach_binary(&cwd)?;

    info!("Configuration:");
    info!("  dtach binary: {:?}", dtach_binary);
    info!("  registry: {:?}", base_dir.join("sessions.json"));
    info!("  sockets: {:?}", base_dir.join("sockets"));
    info!("  scrollback: {:?}", base_dir.join("scrollback"));

    // Verify dtach binary exists
    Ok(EngineConfig {
        dtach_binary,
        registry_path: base_dir.join("sessions.json"),
        socket_dir: base_dir.join("sockets"),
        scrollback_dir: base_dir.join("scrollback"),
        max_scrollback_lines: std::env::var("AIMAESTRO_MAX_SCROLLBACK")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(50_000),
    })
}
