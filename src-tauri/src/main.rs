#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, TitleBarStyle};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "bench")]
use lastty::perf_registry::PerfRegistry;
use lastty::render_sync::RenderCoordinator;
#[cfg(feature = "bench")]
use lastty::runtime_modes::{resolved_benchmark_mode, BenchmarkMode};
use lastty::terminal::manager::TerminalManager;
use lastty::terminal::render::spawn_frame_emitter;
use lastty::{bus, commands};

fn main() {
    #[cfg(target_os = "macos")]
    fix_path_from_login_shell();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("lastty=debug".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "macos")]
            {
                window.set_title_bar_style(TitleBarStyle::Overlay)?;
            }

            #[cfg(feature = "bench")]
            {
                let benchmark_mode = resolved_benchmark_mode();
                if benchmark_mode == Some(BenchmarkMode::Xterm) {
                    tracing::info!("starting in benchmark mode: xterm");
                    return Ok(());
                }
                if benchmark_mode == Some(BenchmarkMode::Stress) {
                    tracing::info!("starting in benchmark mode: stress (real app + driver hook)");
                    app.manage(Arc::new(PerfRegistry::new()));
                }
            }

            let render_coordinator = Arc::new(RenderCoordinator::new());
            let app_handle = app.handle().clone();
            let recordings_dir = lastty::bus::resolve_recordings_dir();
            if let Err(error) = lastty::bus::migrate_legacy_recordings(
                &PathBuf::from(".lastty-recordings"),
                &recordings_dir,
            ) {
                tracing::warn!("recordings migration failed: {error}");
            }
            let event_bus = bus::EventBus::new(app.handle().clone(), recordings_dir);
            app.manage(event_bus);

            let manager = TerminalManager::new(app.handle().clone(), render_coordinator.clone());

            let cwd = std::env::var("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/"));
            let mut env = HashMap::new();
            env.insert("TERM".to_string(), "xterm-256color".to_string());
            env.insert("COLORTERM".to_string(), "truecolor".to_string());
            env.insert("LASTTY".to_string(), "1".to_string());

            let session_id = manager
                .create_session(lastty::terminal::session::SessionConfig {
                    cwd,
                    env,
                    cols: 80,
                    rows: 24,
                    ..Default::default()
                })
                .expect("failed to create initial terminal session");
            app.handle()
                .state::<bus::EventBus>()
                .publish(bus::BusEvent::SessionCreated {
                    session_id: session_id.to_string(),
                    agent_id: None,
                });

            tracing::info!("created initial session: {session_id}");

            app.manage(manager);
            match std::env::current_dir() {
                Ok(workspace_root) => {
                    let rule_count = app
                        .handle()
                        .state::<bus::EventBus>()
                        .start_rule_executor(workspace_root)
                        .unwrap_or_else(|error| {
                            tracing::warn!("failed to start rule executor: {error}");
                            0
                        });
                    if rule_count > 0 {
                        tracing::info!("started rule executor with {rule_count} rule(s)");
                    }
                }
                Err(error) => {
                    tracing::warn!("failed to resolve workspace root for rule executor: {error}");
                }
            }

            spawn_frame_emitter(app_handle, render_coordinator, session_id);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::terminal_resize,
            commands::terminal_scroll,
            commands::kill_terminal,
            commands::key_input,
            #[cfg(feature = "bench")]
            commands::write_benchmark_report,
            commands::quit_app,
            commands::get_benchmark_mode,
            #[cfg(feature = "bench")]
            commands::get_benchmark_config,
            #[cfg(feature = "bench")]
            commands::get_stress_bench_config,
            #[cfg(feature = "bench")]
            commands::register_stress_session,
            #[cfg(feature = "bench")]
            commands::submit_stress_frontend_sample,
            #[cfg(feature = "bench")]
            commands::submit_stress_lifecycle,
            #[cfg(feature = "bench")]
            commands::finalize_stress_bench,
            commands::get_font_config,
            commands::get_primary_session_id,
            commands::list_sessions,
            commands::restore_terminal_sessions,
            commands::list_agents,
            commands::list_rules,
            commands::launch_agent,
            commands::respond_to_approval,
            commands::list_recordings,
            commands::read_recording,
            commands::list_history,
            commands::get_history_entry,
            commands::delete_history_entry,
            commands::set_history_entry_pinned,
            commands::resume_history_entry,
            commands::get_git_info,
            commands::git_graph,
            commands::list_git_branches,
            commands::checkout_git_branch,
            commands::list_worktrees,
            commands::is_git_repo,
            commands::worktree_status,
            commands::create_pull_request,
            commands::remove_worktree,
            commands::abandon_worktree,
            commands::list_prunable_worktrees,
            commands::prune_local_if_clean,
            commands::get_workspace_root,
            commands::terminal_input,
            commands::get_terminal_frame,
            commands::check_command_available,
        ])
        .run(tauri::generate_context!())
        .expect("error running lastty");
}

#[cfg(target_os = "macos")]
fn fix_path_from_login_shell() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let Ok(output) = std::process::Command::new(&shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let Ok(path) = std::str::from_utf8(&output.stdout) else {
        return;
    };
    let path = path.trim();
    if path.is_empty() {
        return;
    }
    // SAFETY: runs as the first line of main(), before any threads are spawned.
    unsafe { std::env::set_var("PATH", path) };
}
