#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]

mod commands;
mod events;
mod input;
mod protocol;
mod render_sync;
mod renderer;
mod terminal;

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{window::Color, Emitter, Manager, TitleBarStyle};
use tracing_subscriber::EnvFilter;

use render_sync::RenderCoordinator;
use renderer::TerminalRenderer;
use terminal::render::{TerminalFrameEvent, render_viewport};
use terminal::manager::TerminalManager;

const PERF_EMIT_INTERVAL: Duration = Duration::from_millis(250);

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("lastty=debug".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let benchmark_mode = std::env::var("LASTTY_BENCH_MODE").ok();
            let renderer_mode = std::env::var("LASTTY_RENDERER").ok();

            #[cfg(target_os = "macos")]
            {
                window.set_title_bar_style(TitleBarStyle::Transparent)?;
                window.set_background_color(Some(Color(69, 69, 80, 255)))?;
            }

            if benchmark_mode.as_deref() == Some("xterm") {
                tracing::info!("starting in benchmark mode: xterm");
                return Ok(());
            }

            let render_coordinator = Arc::new(RenderCoordinator::new());
            let app_handle = app.handle().clone();

            // Create terminal manager.
            let manager = TerminalManager::new(app.handle().clone(), render_coordinator.clone());

            // Create a default terminal session (starts at 80x24, will resize after renderer init).
            let cwd = std::env::var("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|_| PathBuf::from("/"));
            let mut env = HashMap::new();
            env.insert("TERM".to_string(), "xterm-256color".to_string());
            env.insert("COLORTERM".to_string(), "truecolor".to_string());
            env.insert("LASTTY".to_string(), "1".to_string());

            let session_id = manager
                .create_session(None, &cwd, &env, 80, 24)
                .expect("failed to create initial terminal session");

            tracing::info!("created initial session: {}", session_id);

            app.manage(manager);

            if renderer_mode.as_deref() == Some("xterm") {
                tracing::info!("starting in renderer mode: xterm");
                std::thread::spawn(move || {
                    let manager = app_handle.state::<TerminalManager>();
                    let term_arc = manager.get(&session_id).map(|s| s.term.clone());
                    drop(manager);
                    if let Some(term_arc) = term_arc {
                        let term = term_arc.lock();
                        let frame = render_viewport(&term);
                        app_handle
                            .emit(
                                "term:frame",
                                TerminalFrameEvent {
                                    session_id: session_id.to_string(),
                                    frame,
                                },
                            )
                            .ok();
                    }

                    let mut rendered_generation = 0u64;
                    loop {
                        let dirty = render_coordinator.wait_for_next(rendered_generation);
                        let manager = app_handle.state::<TerminalManager>();
                        let term_arc = manager.get(&dirty.session_id).map(|s| s.term.clone());
                        drop(manager);
                        if let Some(term_arc) = term_arc {
                            let term = term_arc.lock();
                            let frame = render_viewport(&term);
                            app_handle
                                .emit(
                                    "term:frame",
                                    TerminalFrameEvent {
                                        session_id: dirty.session_id.to_string(),
                                        frame,
                                    },
                                )
                                .ok();
                            rendered_generation = dirty.generation;
                        }
                    }
                });
                return Ok(());
            }

            // Initialize wgpu renderer and start render loop.
            let size = window.inner_size().unwrap();

            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();

            let renderer: anyhow::Result<TerminalRenderer> =
                rt.block_on(async { TerminalRenderer::new(window, size.width.max(1), size.height.max(1)).await });

            let mut renderer = match renderer {
                Ok(r) => r,
                Err(e) => {
                    tracing::error!("failed to create renderer: {}", e);
                    return Err(e.into());
                }
            };

            std::thread::spawn(move || {
                let trace_start = Instant::now();
                let mut perf_trace = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open("/tmp/lastty-perf.jsonl")
                    .ok();
                let mut last_perf_emit = Instant::now();
                let mut avg_snapshot_ms = 0.0f64;
                let mut avg_render_ms = 0.0f64;
                let mut avg_frame_ms = 0.0f64;
                let mut avg_cache_ms = 0.0f64;
                let mut avg_rect_ms = 0.0f64;
                let mut avg_prepare_ms = 0.0f64;
                let mut avg_gpu_ms = 0.0f64;
                let mut frames_since_emit = 0u64;
                let mut rendered_generation = 0u64;
                let mut last_total_wakeups = 0u64;

                tracing::info!(
                    "renderer initialized: {}x{}, cell: {:.1}x{:.1}",
                    size.width,
                    size.height,
                    renderer.cell_width,
                    renderer.cell_height
                );

                // Resize terminal to match actual window size.
                let (cols, rows) = renderer.grid_size();
                let cell_w = renderer.cell_width as u16;
                let cell_h = renderer.cell_height as u16;
                {
                    let manager = app_handle.state::<TerminalManager>();
                    let event_tx = manager.get(&session_id).map(|s| s.event_tx.clone());
                    let term_arc = manager.get(&session_id).map(|s| s.term.clone());
                    drop(manager);
                    if let (Some(event_tx), Some(term_arc)) = (event_tx, term_arc) {
                        use alacritty_terminal::event::WindowSize;
                        use alacritty_terminal::event_loop::Msg;
                        let ws = WindowSize { num_cols: cols, num_lines: rows, cell_width: cell_w, cell_height: cell_h };
                        let _ = event_tx.send(Msg::Resize(ws));
                        let dims = terminal::session::TermDimensions { cols: cols as usize, lines: rows as usize };
                        term_arc.lock().resize(dims);
                        tracing::info!("resized terminal to {}x{}", cols, rows);
                    }
                }

                // Paint an initial frame immediately so the window is visible
                // before the PTY emits its first wakeup event.
                {
                    let manager = app_handle.state::<TerminalManager>();
                    let term_arc = manager.get(&session_id).map(|s| s.term.clone());
                    drop(manager);
                    if let Some(term_arc) = term_arc {
                        let snapshot_start = Instant::now();
                        let snapshot = {
                            let mut term = term_arc.lock();
                            TerminalRenderer::snapshot(&mut term)
                        };
                        let snapshot_ms = snapshot_start.elapsed().as_secs_f64() * 1000.0;
                        let render_start = Instant::now();
                        if let Err(e) = renderer.render(&snapshot) {
                            tracing::error!("initial render error: {}", e);
                        } else {
                            let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;
                            let frame_ms = snapshot_ms + render_ms;
                            avg_snapshot_ms = snapshot_ms;
                            avg_render_ms = render_ms;
                            avg_frame_ms = frame_ms;
                            frames_since_emit = 1;
                        }
                    }
                }

                // Render loop: wait for wakeup signals, then render.
                loop {
                    let dirty = render_coordinator.wait_for_next(rendered_generation);
                    let manager = app_handle.state::<TerminalManager>();
                    let term_arc = manager.get(&dirty.session_id).map(|s| s.term.clone());
                    drop(manager);
                    if let Some(term_arc) = term_arc {
                        let snapshot_start = Instant::now();
                        let snapshot = {
                            let mut term = term_arc.lock();
                            TerminalRenderer::snapshot(&mut term)
                        };
                        let snapshot_ms = snapshot_start.elapsed().as_secs_f64() * 1000.0;
                        let changed_lines = snapshot.changed_line_count();

                        let render_start = Instant::now();
                        let render_metrics = match renderer.render(&snapshot) {
                            Ok(metrics) => metrics,
                            Err(e) => {
                                tracing::error!("render error: {}", e);
                                continue;
                            }
                        };

                        rendered_generation = dirty.generation;
                        let render_ms = render_start.elapsed().as_secs_f64() * 1000.0;
                        let frame_ms = snapshot_ms + render_ms;
                        let cache_ms = render_metrics.cache_update.as_secs_f64() * 1000.0;
                        let rect_ms = render_metrics.rect_build.as_secs_f64() * 1000.0;
                        let prepare_ms = render_metrics.prepare.as_secs_f64() * 1000.0;
                        let gpu_ms = render_metrics.gpu.as_secs_f64() * 1000.0;
                        avg_snapshot_ms = avg_snapshot_ms * 0.8 + snapshot_ms * 0.2;
                        avg_render_ms = avg_render_ms * 0.8 + render_ms * 0.2;
                        avg_frame_ms = avg_frame_ms * 0.8 + frame_ms * 0.2;
                        avg_cache_ms = avg_cache_ms * 0.8 + cache_ms * 0.2;
                        avg_rect_ms = avg_rect_ms * 0.8 + rect_ms * 0.2;
                        avg_prepare_ms = avg_prepare_ms * 0.8 + prepare_ms * 0.2;
                        avg_gpu_ms = avg_gpu_ms * 0.8 + gpu_ms * 0.2;
                        frames_since_emit += 1;
                        let latest_generation = render_coordinator.current_generation();
                        let total_wakeups = render_coordinator.total_wakeups();
                        let wakeups_since_emit = total_wakeups.saturating_sub(last_total_wakeups);
                        let pending_updates = latest_generation.saturating_sub(rendered_generation);

                        if frame_ms > 33.0 {
                            tracing::debug!(
                                "slow frame generation={} snapshot_ms={:.2} render_ms={:.2} frame_ms={:.2} cache_ms={:.2} rect_ms={:.2} prepare_ms={:.2} gpu_ms={:.2} changed_lines={} cached_lines={} text_areas={} wakeups_since_emit={} pending_updates={}",
                                latest_generation,
                                snapshot_ms,
                                render_ms,
                                frame_ms,
                                cache_ms,
                                rect_ms,
                                prepare_ms,
                                gpu_ms,
                                changed_lines,
                                renderer.cached_line_count(),
                                render_metrics.text_areas,
                                wakeups_since_emit,
                                pending_updates,
                            );
                        }

                        let emit_elapsed = last_perf_emit.elapsed();
                        if emit_elapsed >= PERF_EMIT_INTERVAL {
                            let fps = frames_since_emit as f64 / emit_elapsed.as_secs_f64();
                            app_handle
                                .emit(
                                    "perf:stats",
                                    serde_json::json!({
                                        "snapshot_ms": avg_snapshot_ms,
                                        "render_ms": avg_render_ms,
                                        "frame_ms": avg_frame_ms,
                                        "cache_ms": avg_cache_ms,
                                        "rect_ms": avg_rect_ms,
                                        "prepare_ms": avg_prepare_ms,
                                        "gpu_ms": avg_gpu_ms,
                                        "fps": fps,
                                        "changed_lines": changed_lines,
                                        "cached_lines": renderer.cached_line_count(),
                                        "text_areas": render_metrics.text_areas,
                                        "wakeups": wakeups_since_emit,
                                        "generation": latest_generation,
                                        "pending_updates": pending_updates,
                                    }),
                                )
                                .ok();
                            if let Some(file) = perf_trace.as_mut() {
                                let _ = writeln!(
                                    file,
                                    "{}",
                                    serde_json::json!({
                                        "ts_ms": trace_start.elapsed().as_millis(),
                                        "snapshot_ms": avg_snapshot_ms,
                                        "render_ms": avg_render_ms,
                                        "frame_ms": avg_frame_ms,
                                        "cache_ms": avg_cache_ms,
                                        "rect_ms": avg_rect_ms,
                                        "prepare_ms": avg_prepare_ms,
                                        "gpu_ms": avg_gpu_ms,
                                        "fps": fps,
                                        "changed_lines": changed_lines,
                                        "cached_lines": renderer.cached_line_count(),
                                        "text_areas": render_metrics.text_areas,
                                        "wakeups": wakeups_since_emit,
                                        "generation": latest_generation,
                                        "pending_updates": pending_updates,
                                    })
                                );
                            }
                            last_perf_emit = Instant::now();
                            last_total_wakeups = total_wakeups;
                            frames_since_emit = 0;
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_terminal,
            commands::terminal_resize,
            commands::kill_terminal,
            commands::key_input,
            commands::write_benchmark_report,
            commands::quit_app,
            commands::get_benchmark_mode,
            commands::get_renderer_mode,
            commands::get_primary_session_id,
            commands::terminal_input,
            commands::get_terminal_frame,
        ])
        .run(tauri::generate_context!())
        .expect("error running lastty");
}
