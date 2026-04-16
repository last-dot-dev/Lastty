#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(dead_code)]

mod commands;
mod events;
mod input;
mod protocol;
mod renderer;
mod terminal;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

use renderer::TerminalRenderer;
use terminal::manager::TerminalManager;
use terminal::session::SessionId;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("lastty=debug".parse().unwrap()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();

            // Create wakeup channel for render coordination.
            let (wakeup_tx, wakeup_rx) = mpsc::channel::<SessionId>();

            // Create terminal manager.
            let manager = TerminalManager::new(app.handle().clone(), wakeup_tx);

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

            // Initialize wgpu renderer and start render loop.
            let size = window.inner_size().unwrap();
            let app_handle = app.handle().clone();

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
                        let term = term_arc.lock();
                        if let Err(e) = renderer.render(&term) {
                            tracing::error!("initial render error: {}", e);
                        }
                    }
                }

                // Render loop: wait for wakeup signals, then render.
                loop {
                    match wakeup_rx.recv() {
                        Ok(sid) => {
                            // Drain pending wakeups (coalesce).
                            while wakeup_rx.try_recv().is_ok() {}

                            let manager = app_handle.state::<TerminalManager>();
                            let term_arc = manager.get(&sid).map(|s| s.term.clone());
                            drop(manager);
                            if let Some(term_arc) = term_arc {
                                let term = term_arc.lock();
                                if let Err(e) = renderer.render(&term) {
                                    tracing::error!("render error: {}", e);
                                }
                            }
                        }
                        Err(_) => break,
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
        ])
        .run(tauri::generate_context!())
        .expect("error running lastty");
}
