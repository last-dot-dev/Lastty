//! L2 headless pipeline harness. Wires up a real `Term` + `EventProxy`-style
//! mark feeder + `RenderCoordinator` + frame-emitter loop, but the Tauri
//! emit is replaced by a sink that just times + counts frames. Designed to
//! catch behaviour the criterion microbenches can't: real mark cadence after
//! a parse batch, lock contention between producer and emitter, and output
//! size variance across workloads.

use std::env;
use std::fs;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};

use lastty::bench_corpus::{self, Workload, WorkloadChunk};
use lastty::render_sync::RenderCoordinator;
use lastty::terminal::render::render_viewport;
use lastty::terminal::session::SessionId;

const COLS: usize = 120;
const ROWS: usize = 40;
const DEFAULT_FRAME_CAP_MS: u64 = 8;
/// Bulk single-chunk workloads (everything except keystroke_echo) are fed in
/// slices this big so the producer's mark-dirty cadence approximates real
/// PTY read sizes — otherwise we'd see one giant mark per workload and the
/// coalesce/latency numbers would be meaningless.
const PRODUCER_CHUNK_BYTES: usize = 4096;

struct PipeSize;

impl Dimensions for PipeSize {
    fn total_lines(&self) -> usize {
        ROWS
    }
    fn screen_lines(&self) -> usize {
        ROWS
    }
    fn columns(&self) -> usize {
        COLS
    }
}

#[derive(serde::Serialize)]
struct Report {
    workload: String,
    cols: usize,
    rows: usize,
    frame_cap_ms: u64,
    wall_ms: u128,
    bytes_in: usize,
    marks: u64,
    emits: u64,
    coalesce_ratio: f64,
    avg_ansi_bytes: f64,
    p50_render_us: u64,
    p95_render_us: u64,
    p50_mark_to_emit_us: u64,
    p95_mark_to_emit_us: u64,
}

fn main() -> ExitCode {
    let mut workload_name: Option<String> = None;
    let mut output_path: Option<String> = None;
    let mut cap_ms: u64 = DEFAULT_FRAME_CAP_MS;
    let mut absorb_ms: u64 = 0;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--workload" => workload_name = args.next(),
            "--output" => output_path = args.next(),
            "--cap-ms" => {
                cap_ms = match args.next().and_then(|s| s.parse().ok()) {
                    Some(v) => v,
                    None => {
                        eprintln!("--cap-ms requires a non-negative integer");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--absorb-ms" => {
                absorb_ms = match args.next().and_then(|s| s.parse().ok()) {
                    Some(v) => v,
                    None => {
                        eprintln!("--absorb-ms requires a non-negative integer");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--help" | "-h" => {
                print_help();
                return ExitCode::SUCCESS;
            }
            other => {
                eprintln!("unknown arg: {other}");
                print_help();
                return ExitCode::FAILURE;
            }
        }
    }

    let workloads = match workload_name.as_deref() {
        Some(name) => match bench_corpus::by_name(name) {
            Some(w) => vec![w],
            None => {
                eprintln!("unknown workload: {name}");
                return ExitCode::FAILURE;
            }
        },
        None => bench_corpus::all(),
    };

    let frame_cap = Duration::from_millis(cap_ms);
    let absorb = Duration::from_millis(absorb_ms);
    let mut reports = Vec::with_capacity(workloads.len());
    for workload in workloads {
        reports.push(run_workload(&workload, frame_cap, absorb));
    }

    let json = serde_json::to_string_pretty(&reports).expect("report should serialise");
    match output_path {
        Some(path) => {
            if let Err(e) = fs::write(&path, &json) {
                eprintln!("failed writing {path}: {e}");
                return ExitCode::FAILURE;
            }
            println!("wrote report → {path}");
        }
        None => println!("{json}"),
    }
    ExitCode::SUCCESS
}

fn print_help() {
    eprintln!(
        "bench_pipeline — headless PTY→render→emit harness\n\n\
         Usage:\n\
           bench_pipeline [--workload NAME] [--output PATH] [--cap-ms N] [--absorb-ms N]\n\n\
         Workloads: plain_scroll, colored_log, vim_refresh, agent_tui, keystroke_echo\n\
         --cap-ms     min interval between emits (default 8). 0 disables the cap.\n\
         --absorb-ms  post-wake absorb window for adjacent marks (default 0).\n\
         When --workload is omitted, all workloads are run."
    );
}

fn run_workload(workload: &Workload, frame_cap: Duration, absorb: Duration) -> Report {
    let term = Arc::new(FairMutex::new(Term::new(
        Config::default(),
        &PipeSize,
        VoidListener,
    )));
    let coordinator = Arc::new(RenderCoordinator::new());
    let session = SessionId::new();
    let stop = Arc::new(AtomicBool::new(false));
    let marks = Arc::new(AtomicU64::new(0));
    let first_pending_mark: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    let render_us: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::with_capacity(1024)));
    let latency_us: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::with_capacity(1024)));
    let total_ansi_bytes = Arc::new(AtomicU64::new(0));
    let emits = Arc::new(AtomicU64::new(0));
    // Consumer publishes its last-rendered generation so the producer can
    // wait for full drain without polling internal coordinator state.
    let last_rendered = Arc::new(AtomicU64::new(0));

    // Consumer thread mirrors `spawn_frame_emitter` in terminal/render.rs:
    // wait for next dirty generation, apply frame cap, lock the term, render,
    // count bytes. The emit step is a no-op sink.
    let consumer = {
        let term = term.clone();
        let coordinator = coordinator.clone();
        let stop = stop.clone();
        let render_us = render_us.clone();
        let latency_us = latency_us.clone();
        let first_pending_mark = first_pending_mark.clone();
        let total_ansi_bytes = total_ansi_bytes.clone();
        let emits = emits.clone();
        let last_rendered = last_rendered.clone();
        thread::spawn(move || {
            let mut rendered_generation = coordinator.current_generation();
            let mut last_emit: Option<Instant> = None;
            loop {
                let dirty = coordinator
                    .wait_for_next_timeout(rendered_generation, Duration::from_millis(50));
                if stop.load(Ordering::Relaxed) && dirty.is_none() {
                    break;
                }
                let Some(dirty) = dirty else {
                    continue;
                };
                if !frame_cap.is_zero() {
                    if let Some(last) = last_emit {
                        let elapsed = last.elapsed();
                        if elapsed < frame_cap {
                            thread::sleep(frame_cap - elapsed);
                        }
                    }
                }
                if !absorb.is_zero() {
                    // Soak up any marks that arrive immediately after wake;
                    // turns N adjacent marks into one render without raising
                    // the steady-state floor (frame cap still bounds rate).
                    let _ = coordinator
                        .wait_for_next_timeout(coordinator.current_generation(), absorb);
                }
                let gen_at_render = coordinator.current_generation();
                let mark_instant = first_pending_mark.lock().unwrap().take();
                let render_start = Instant::now();
                let frame = {
                    let mut term = term.lock();
                    render_viewport(&mut term)
                };
                let render_elapsed = render_start.elapsed();
                rendered_generation = gen_at_render;
                last_emit = Some(Instant::now());
                emits.fetch_add(1, Ordering::Relaxed);
                last_rendered.store(gen_at_render, Ordering::Release);
                total_ansi_bytes.fetch_add(frame.ansi.len() as u64, Ordering::Relaxed);
                render_us
                    .lock()
                    .unwrap()
                    .push(render_elapsed.as_micros() as u64);
                if let Some(mark_instant) = mark_instant {
                    latency_us
                        .lock()
                        .unwrap()
                        .push(mark_instant.elapsed().as_micros() as u64);
                }
                let _ = dirty.session_id;
            }
        })
    };

    // Producer: feed corpus chunks into the term, marking dirty after each
    // chunk to mimic what alacritty's event loop does at batch end.
    let wall_start = Instant::now();
    let bytes_in = workload.total_bytes();
    {
        let mut parser = Processor::<StdSyncHandler>::new();
        for WorkloadChunk { bytes, delay } in &workload.chunks {
            if !delay.is_zero() {
                thread::sleep(*delay);
            }
            for slice in bytes.chunks(PRODUCER_CHUNK_BYTES) {
                {
                    let mut term = term.lock();
                    parser.advance(&mut *term, slice);
                }
                {
                    let mut slot = first_pending_mark.lock().unwrap();
                    if slot.is_none() {
                        *slot = Some(Instant::now());
                    }
                }
                coordinator.mark_dirty(session);
                marks.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    // Drain: wait for the consumer to catch up to the final generation, or
    // give up after a generous timeout (keeps a stuck bench from hanging CI).
    let final_gen = coordinator.current_generation();
    let drain_deadline = Instant::now() + Duration::from_secs(5);
    while last_rendered.load(Ordering::Acquire) < final_gen && Instant::now() < drain_deadline {
        thread::sleep(Duration::from_millis(2));
    }
    stop.store(true, Ordering::Relaxed);
    coordinator.mark_dirty(session);
    consumer.join().expect("consumer thread");

    let wall_ms = wall_start.elapsed().as_millis();
    let marks = marks.load(Ordering::Relaxed);
    let emits = emits.load(Ordering::Relaxed);
    let coalesce_ratio = if marks == 0 {
        0.0
    } else {
        emits as f64 / marks as f64
    };
    let avg_ansi_bytes = if emits == 0 {
        0.0
    } else {
        total_ansi_bytes.load(Ordering::Relaxed) as f64 / emits as f64
    };

    let mut render_us = std::mem::take(&mut *render_us.lock().unwrap());
    render_us.sort_unstable();
    let mut latency_us = std::mem::take(&mut *latency_us.lock().unwrap());
    latency_us.sort_unstable();

    Report {
        workload: workload.name.to_string(),
        cols: COLS,
        rows: ROWS,
        frame_cap_ms: frame_cap.as_millis() as u64,
        wall_ms,
        bytes_in,
        marks,
        emits,
        coalesce_ratio,
        avg_ansi_bytes,
        p50_render_us: percentile(&render_us, 50),
        p95_render_us: percentile(&render_us, 95),
        p50_mark_to_emit_us: percentile(&latency_us, 50),
        p95_mark_to_emit_us: percentile(&latency_us, 95),
    }
}

fn percentile(sorted: &[u64], pct: u8) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = (sorted.len() * pct as usize) / 100;
    sorted[idx.min(sorted.len() - 1)]
}
