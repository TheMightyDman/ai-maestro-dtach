// AI Maestro Session Engine
// dtach-backed session management daemon

mod dtach;
mod engine;
mod registry;
mod scrollback;
mod types;

use anyhow::{Context, Result};
use std::path::PathBuf;
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

use engine::{EngineConfig, SessionEngine};

fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info"))
        )
        .init();

    info!("Starting AI Maestro Session Engine v{}", env!("CARGO_PKG_VERSION"));

    // Load configuration
    let config = load_config()?;

    // Initialize engine
    let engine = SessionEngine::new(config)
        .context("Failed to initialize session engine")?;

    info!("Session engine initialized successfully");

    // For Phase 0, just verify the engine can be created
    // In Phase 1, we'll add the IPC server here

    info!("Session engine ready");
    info!("Sessions loaded: {}", engine.list_sessions().len());

    // TODO: Start IPC server in Phase 1
    println!("AI Maestro Session Engine v{}", env!("CARGO_PKG_VERSION"));
    println!("Status: Ready (Phase 0 - Foundation)");
    println!("Sessions: {}", engine.list_sessions().len());

    Ok(())
}

/// Load engine configuration from environment variables and defaults
fn load_config() -> Result<EngineConfig> {
    let home = std::env::var("HOME")
        .unwrap_or_else(|_| {
            error!("HOME environment variable not set, using /tmp");
            "/tmp".to_string()
        });

    let base_dir = PathBuf::from(&home).join(".aimaestro");

    // Check if custom dtach path is provided
    let dtach_binary = std::env::var("AIMAESTRO_DTACH_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            // Try to find dtach in common locations
            let candidates = vec![
                PathBuf::from("./dist/bin/dtach"),
                PathBuf::from("/usr/local/bin/dtach"),
                PathBuf::from("/usr/bin/dtach"),
            ];

            for path in candidates {
                if path.exists() {
                    return path;
                }
            }

            // Default to local dist/bin
            PathBuf::from("./dist/bin/dtach")
        });

    info!("Configuration:");
    info!("  dtach binary: {:?}", dtach_binary);
    info!("  registry: {:?}", base_dir.join("sessions.json"));
    info!("  sockets: {:?}", base_dir.join("sockets"));
    info!("  scrollback: {:?}", base_dir.join("scrollback"));

    // Verify dtach binary exists
    if !dtach_binary.exists() {
        error!("dtach binary not found at {:?}", dtach_binary);
        error!("Please ensure dtach is built and available");
        return Err(anyhow::anyhow!("dtach binary not found"));
    }

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
