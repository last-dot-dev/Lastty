//! Benchmark comparing the two renderer paths exposed by `LASTTY_RENDERER`:
//!
//! - `xterm`: Rust builds an ANSI frame per damage wakeup and ships the bytes
//!   to xterm.js (`terminal::render::render_viewport`).
//! - `wgpu`: Rust snapshots Term state and rasterizes cells via the atlas +
//!   wgpu pipeline (`renderer::TerminalRenderer::{snapshot, render_to_view}`).
//!
//! Both paths run against the same `alacritty_terminal::Term` state so the
//! comparison reflects the real Rust-side work each path does per frame.

use std::env;
use std::fs;
use std::sync::Arc;
use std::time::Instant;

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config as TermConfig, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use anyhow::{Context, Result};
use lastty::font_config::FontConfig;
use lastty::renderer::atlas::GlyphAtlas;
use lastty::renderer::panes::GpuContext;
use lastty::renderer::TerminalRenderer;
use lastty::terminal::render::render_viewport;

const SCALE_FACTOR: f32 = 2.0;

struct Config {
    iterations: usize,
    warmup_iterations: usize,
    cols: usize,
    rows: usize,
    out_path: Option<String>,
}

#[derive(serde::Serialize)]
struct BenchResult {
    renderer: &'static str,
    case: &'static str,
    iterations: usize,
    warmup_iterations: usize,
    cols: usize,
    rows: usize,
    mean_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}

/// A workload is a pair of byte streams: `seed` runs once before warmup/measure
/// to establish initial screen state; `tick` runs once per iteration to
/// simulate the incremental damage each mode would observe in production.
struct Workload {
    name: &'static str,
    seed: Box<dyn Fn(usize, usize) -> Vec<u8>>,
    tick: Box<dyn Fn(usize, usize, usize) -> Vec<u8>>,
}

fn main() -> Result<()> {
    let config = parse_args();
    let workloads = workloads();

    let (gpu, atlas) = pollster::block_on(bootstrap_gpu())?;
    let cell_w = atlas.cell_width;
    let cell_h = atlas.cell_height;
    let width = (config.cols as f32 * cell_w).ceil() as u32;
    let height = (config.rows as f32 * cell_h).ceil() as u32;
    let atlas = Arc::new(std::sync::Mutex::new(atlas));

    let mut results = Vec::new();
    for workload in &workloads {
        results.push(bench_xterm(workload, &config));
        results.push(bench_wgpu(
            workload, &config, &gpu, &atlas, width, height,
        )?);
    }

    println!(
        "renderer  case                     mean_ms  p50_ms  p95_ms  max_ms  iterations"
    );
    println!(
        "--------  -----------------------  -------  ------  ------  ------  ----------"
    );
    for r in &results {
        println!(
            "{:<8}  {:<23}  {:>7.3}  {:>6.3}  {:>6.3}  {:>6.3}  {:>10}",
            r.renderer, r.case, r.mean_ms, r.p50_ms, r.p95_ms, r.max_ms, r.iterations,
        );
    }

    if let Some(path) = config.out_path {
        let json = serde_json::to_string_pretty(&results).context("serialize results")?;
        fs::write(&path, json).with_context(|| format!("write {path}"))?;
    }
    Ok(())
}

fn parse_args() -> Config {
    let mut config = Config {
        iterations: 40,
        warmup_iterations: 5,
        cols: 180,
        rows: 48,
        out_path: None,
    };
    let args: Vec<String> = env::args().collect();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--iterations" => {
                i += 1;
                if let Some(v) = args.get(i).and_then(|s| s.parse().ok()) {
                    config.iterations = v;
                }
            }
            "--warmup" => {
                i += 1;
                if let Some(v) = args.get(i).and_then(|s| s.parse().ok()) {
                    config.warmup_iterations = v;
                }
            }
            "--cols" => {
                i += 1;
                if let Some(v) = args.get(i).and_then(|s| s.parse().ok()) {
                    config.cols = v;
                }
            }
            "--rows" => {
                i += 1;
                if let Some(v) = args.get(i).and_then(|s| s.parse().ok()) {
                    config.rows = v;
                }
            }
            "--out" => {
                i += 1;
                config.out_path = args.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }
    config
}

async fn bootstrap_gpu() -> Result<(GpuContext, GlyphAtlas)> {
    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        })
        .await
        .context("request wgpu adapter")?;
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor::default())
        .await
        .context("request wgpu device")?;
    let format = wgpu::TextureFormat::Bgra8UnormSrgb;
    let gpu = GpuContext {
        instance,
        adapter,
        device,
        queue,
        format,
    };
    let atlas = GlyphAtlas::new(&gpu.device, &gpu.queue, FontConfig::DEFAULT, SCALE_FACTOR)
        .context("build glyph atlas")?;
    Ok((gpu, atlas))
}

fn bench_xterm(workload: &Workload, config: &Config) -> BenchResult {
    let mut term = make_term(config.cols, config.rows);
    let mut parser = Processor::<StdSyncHandler>::new();
    parser.advance(&mut term, &(workload.seed)(config.cols, config.rows));

    for i in 0..config.warmup_iterations {
        parser.advance(&mut term, &(workload.tick)(config.cols, config.rows, i));
        std::hint::black_box(render_viewport(&term));
    }

    let mut samples = Vec::with_capacity(config.iterations);
    for i in 0..config.iterations {
        parser.advance(&mut term, &(workload.tick)(config.cols, config.rows, i));
        let start = Instant::now();
        std::hint::black_box(render_viewport(&term));
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    stats("xterm", workload.name, config, &samples)
}

fn bench_wgpu(
    workload: &Workload,
    config: &Config,
    gpu: &GpuContext,
    atlas: &Arc<std::sync::Mutex<GlyphAtlas>>,
    width: u32,
    height: u32,
) -> Result<BenchResult> {
    let mut renderer = TerminalRenderer::new_offscreen(
        gpu.clone(),
        width,
        height,
        Arc::clone(atlas),
        SCALE_FACTOR,
    )
    .context("build offscreen renderer")?;

    let target_texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("bench offscreen target"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: gpu.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = target_texture.create_view(&wgpu::TextureViewDescriptor::default());

    let mut term = make_term(config.cols, config.rows);
    let mut parser = Processor::<StdSyncHandler>::new();
    parser.advance(&mut term, &(workload.seed)(config.cols, config.rows));

    for i in 0..config.warmup_iterations {
        parser.advance(&mut term, &(workload.tick)(config.cols, config.rows, i));
        let snapshot = TerminalRenderer::snapshot(&mut term);
        renderer
            .render_to_view(&snapshot, &view)
            .context("warmup render")?;
    }

    let mut samples = Vec::with_capacity(config.iterations);
    for i in 0..config.iterations {
        parser.advance(&mut term, &(workload.tick)(config.cols, config.rows, i));
        let start = Instant::now();
        let snapshot = TerminalRenderer::snapshot(&mut term);
        renderer
            .render_to_view(&snapshot, &view)
            .context("bench render")?;
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    Ok(stats("wgpu", workload.name, config, &samples))
}

fn make_term(cols: usize, rows: usize) -> Term<VoidListener> {
    struct Size {
        cols: usize,
        rows: usize,
    }
    impl Dimensions for Size {
        fn total_lines(&self) -> usize {
            self.rows
        }
        fn screen_lines(&self) -> usize {
            self.rows
        }
        fn columns(&self) -> usize {
            self.cols
        }
    }
    Term::new(
        TermConfig::default(),
        &Size { cols, rows },
        VoidListener,
    )
}

fn stats(renderer: &'static str, case: &'static str, config: &Config, samples: &[f64]) -> BenchResult {
    let total: f64 = samples.iter().sum();
    BenchResult {
        renderer,
        case,
        iterations: config.iterations,
        warmup_iterations: config.warmup_iterations,
        cols: config.cols,
        rows: config.rows,
        mean_ms: total / samples.len() as f64,
        p50_ms: percentile(samples, 50.0),
        p95_ms: percentile(samples, 95.0),
        max_ms: samples.iter().copied().fold(0.0, f64::max),
    }
}

fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let idx = (((p / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted[idx]
}

fn workloads() -> Vec<Workload> {
    vec![
        Workload {
            name: "full_redraw_plain",
            seed: Box::new(|_, _| Vec::new()),
            tick: Box::new(|cols, rows, _| {
                let mut out = home_clear();
                let line: String = std::iter::repeat('x').take(cols).collect();
                for i in 0..rows {
                    out.extend_from_slice(line.as_bytes());
                    if i + 1 < rows {
                        out.extend_from_slice(b"\r\n");
                    }
                }
                out
            }),
        },
        Workload {
            name: "full_redraw_sgr_mixed",
            seed: Box::new(|_, _| Vec::new()),
            tick: Box::new(|cols, rows, iter| {
                let mut out = home_clear();
                for row in 0..rows {
                    let fg = 30 + ((row + iter) % 8);
                    out.extend_from_slice(format!("\x1b[1;{fg}m").as_bytes());
                    let chunk = format!(" row {row:03} iter {iter:04} ");
                    let mut line = String::with_capacity(cols);
                    while line.len() < cols {
                        line.push_str(&chunk);
                    }
                    line.truncate(cols);
                    out.extend_from_slice(line.as_bytes());
                    if row + 1 < rows {
                        out.extend_from_slice(b"\r\n");
                    }
                }
                out.extend_from_slice(b"\x1b[0m");
                out
            }),
        },
        Workload {
            name: "append_bottom_1_line",
            seed: Box::new(|cols, rows| fill_screen(cols, rows, "seed")),
            tick: Box::new(|cols, _rows, iter| {
                let mut out = Vec::new();
                out.extend_from_slice(b"\r\n");
                let text = format!("[{iter:06}] append line with some padding text ");
                let mut line = String::with_capacity(cols);
                while line.len() < cols {
                    line.push_str(&text);
                }
                line.truncate(cols);
                out.extend_from_slice(line.as_bytes());
                out
            }),
        },
        Workload {
            name: "scroll_burst_8_lines",
            seed: Box::new(|cols, rows| fill_screen(cols, rows, "seed")),
            tick: Box::new(|cols, _rows, iter| {
                let mut out = Vec::new();
                for k in 0..8 {
                    out.extend_from_slice(b"\r\n");
                    let text = format!("scroll {iter:05}/{k} chunk ");
                    let mut line = String::with_capacity(cols);
                    while line.len() < cols {
                        line.push_str(&text);
                    }
                    line.truncate(cols);
                    out.extend_from_slice(line.as_bytes());
                }
                out
            }),
        },
        Workload {
            name: "unicode_full_redraw",
            seed: Box::new(|_, _| Vec::new()),
            tick: Box::new(|_cols, rows, iter| {
                let mut out = home_clear();
                for row in 0..rows {
                    let color = 31 + ((row + iter) % 6);
                    out.extend_from_slice(format!("\x1b[{color}m").as_bytes());
                    let line = format!(
                        "λ render ✓ café 日本語 résumé naïve row {row} iter {iter}"
                    );
                    out.extend_from_slice(line.as_bytes());
                    if row + 1 < rows {
                        out.extend_from_slice(b"\r\n");
                    }
                }
                out.extend_from_slice(b"\x1b[0m");
                out
            }),
        },
    ]
}

fn home_clear() -> Vec<u8> {
    b"\x1b[H\x1b[2J".to_vec()
}

fn fill_screen(cols: usize, rows: usize, tag: &str) -> Vec<u8> {
    let mut out = home_clear();
    for row in 0..rows {
        let text = format!("{tag} row {row:03} ");
        let mut line = String::with_capacity(cols);
        while line.len() < cols {
            line.push_str(&text);
        }
        line.truncate(cols);
        out.extend_from_slice(line.as_bytes());
        if row + 1 < rows {
            out.extend_from_slice(b"\r\n");
        }
    }
    out
}
