use std::env;
use std::fs;
use std::time::Instant;

use glyphon::{
    Attrs, Buffer, Color as GlyphonColor, Family, FontSystem, Metrics, Shaping,
    Weight as GlyphonWeight,
};

const FONT_SIZE: f32 = 18.0;
const CELL_HEIGHT: f32 = 26.0;

#[derive(Clone, Copy, PartialEq)]
struct Cell {
    c: char,
    fg: [u8; 3],
    bg: [u8; 3],
    bold: bool,
}

#[derive(Clone)]
struct Case {
    name: &'static str,
    rows: Vec<Vec<Cell>>,
    changed_rows: Vec<usize>,
}

#[derive(serde::Serialize)]
struct BenchResult {
    renderer: &'static str,
    case: &'static str,
    iterations: usize,
    warmup_iterations: usize,
    cols: usize,
    rows: usize,
    total_ms: f64,
    mean_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    max_ms: f64,
}

#[derive(Clone, Copy, PartialEq)]
struct LineStyle {
    fg: [u8; 3],
    bold: bool,
}

struct Config {
    iterations: usize,
    warmup_iterations: usize,
    cols: usize,
    rows: usize,
    out_path: Option<String>,
}

fn main() {
    let config = parse_args();
    let cases = vec![
        make_uniform_case("uniform_full_redraw", config.cols, config.rows, config.rows),
        make_uniform_case("uniform_single_line", config.cols, config.rows, 1),
        make_mixed_case("mixed_full_redraw", config.cols, config.rows, config.rows),
        make_mixed_case("mixed_single_line", config.cols, config.rows, 1),
        make_log_case(
            "dense_logs_full_redraw",
            config.cols,
            config.rows,
            config.rows,
        ),
        make_log_case("append_burst_last_8", config.cols, config.rows, 8),
        make_scroll_case("scroll_window_shift", config.cols, config.rows),
        make_unicode_case("unicode_full_redraw", config.cols, config.rows, config.rows),
    ];

    let mut results = Vec::new();
    for case in &cases {
        results.push(run_glyphon_plain(case, &config));
        results.push(run_glyphon_rich(case, &config));
        results.push(run_ansi_builder(case, &config));
    }

    println!("renderer         case                    mean_ms  p95_ms  max_ms  iterations");
    println!("---------------  ----------------------  -------  ------  ------  ----------");
    for result in &results {
        println!(
            "{:<15}  {:<22}  {:>7.2}  {:>6.2}  {:>6.2}  {:>10}",
            result.renderer,
            result.case,
            result.mean_ms,
            result.p95_ms,
            result.max_ms,
            result.iterations,
        );
    }

    if let Some(path) = config.out_path {
        let json = serde_json::to_string_pretty(&results).expect("serialize results");
        fs::write(path, json).expect("write benchmark output");
    }
}

fn parse_args() -> Config {
    let mut config = Config {
        iterations: 30,
        warmup_iterations: 5,
        cols: 221,
        rows: 61,
        out_path: None,
    };

    let args: Vec<String> = env::args().collect();
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--iterations" => {
                idx += 1;
                config.iterations = args
                    .get(idx)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(config.iterations);
            }
            "--warmup" => {
                idx += 1;
                config.warmup_iterations = args
                    .get(idx)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(config.warmup_iterations);
            }
            "--cols" => {
                idx += 1;
                config.cols = args
                    .get(idx)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(config.cols);
            }
            "--rows" => {
                idx += 1;
                config.rows = args
                    .get(idx)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(config.rows);
            }
            "--out" => {
                idx += 1;
                config.out_path = args.get(idx).cloned();
            }
            _ => {}
        }
        idx += 1;
    }

    config
}

fn run_glyphon_plain(case: &Case, config: &Config) -> BenchResult {
    let metrics = Metrics::new(FONT_SIZE, CELL_HEIGHT);
    let mut font_system = FontSystem::new();
    let mut buffers: Vec<Option<Buffer>> = (0..config.rows).map(|_| None).collect();
    let width = config.cols as f32 * 10.0;

    for _ in 0..config.warmup_iterations {
        run_plain_iteration(case, &mut font_system, &mut buffers, metrics, width);
    }

    let mut samples = Vec::with_capacity(config.iterations);
    for _ in 0..config.iterations {
        let start = Instant::now();
        run_plain_iteration(case, &mut font_system, &mut buffers, metrics, width);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    stats_for("glyphon_plain", case, config, &samples)
}

fn run_plain_iteration(
    case: &Case,
    font_system: &mut FontSystem,
    buffers: &mut [Option<Buffer>],
    metrics: Metrics,
    width: f32,
) {
    for &row_idx in &case.changed_rows {
        let row = &case.rows[row_idx];
        let mut buffer = buffers[row_idx]
            .take()
            .unwrap_or_else(|| Buffer::new(font_system, metrics));
        buffer.set_size(font_system, Some(width), Some(CELL_HEIGHT));

        let text = build_line_text(row);
        let style = uniform_line_style(row).unwrap_or(LineStyle {
            fg: [220, 220, 220],
            bold: false,
        });
        let attrs = attrs_for_style(style);
        buffer.set_text(font_system, &text, &attrs, Shaping::Basic, None);
        buffer.shape_until_scroll(font_system, false);
        buffers[row_idx] = Some(buffer);
    }
}

fn run_glyphon_rich(case: &Case, config: &Config) -> BenchResult {
    let metrics = Metrics::new(FONT_SIZE, CELL_HEIGHT);
    let mut font_system = FontSystem::new();
    let mut buffers: Vec<Option<Buffer>> = (0..config.rows).map(|_| None).collect();
    let width = config.cols as f32 * 10.0;

    for _ in 0..config.warmup_iterations {
        run_rich_iteration(case, &mut font_system, &mut buffers, metrics, width);
    }

    let mut samples = Vec::with_capacity(config.iterations);
    for _ in 0..config.iterations {
        let start = Instant::now();
        run_rich_iteration(case, &mut font_system, &mut buffers, metrics, width);
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    stats_for("glyphon_rich", case, config, &samples)
}

fn run_rich_iteration(
    case: &Case,
    font_system: &mut FontSystem,
    buffers: &mut [Option<Buffer>],
    metrics: Metrics,
    width: f32,
) {
    for &row_idx in &case.changed_rows {
        let row = &case.rows[row_idx];
        let mut buffer = buffers[row_idx]
            .take()
            .unwrap_or_else(|| Buffer::new(font_system, metrics));
        buffer.set_size(font_system, Some(width), Some(CELL_HEIGHT));

        let mut spans: Vec<(String, Attrs)> = Vec::new();
        let mut run_text = String::new();
        let mut run_style: Option<LineStyle> = None;
        let mut last_col = 0usize;

        for (col, cell) in row.iter().enumerate() {
            if col > last_col {
                flush_run(&mut spans, &mut run_text, &mut run_style);
                spans.push((
                    gap_spaces(col - last_col),
                    Attrs::new().family(Family::Monospace),
                ));
            }
            let style = cell_style(cell);
            if run_style != Some(style) {
                flush_run(&mut spans, &mut run_text, &mut run_style);
                run_style = Some(style);
            }
            run_text.push(if cell.c == '\0' { ' ' } else { cell.c });
            last_col = col + 1;
        }
        flush_run(&mut spans, &mut run_text, &mut run_style);

        let default_attrs = Attrs::new().family(Family::Monospace);
        let span_refs: Vec<(&str, Attrs)> = spans
            .iter()
            .map(|(text, attrs)| (text.as_str(), attrs.clone()))
            .collect();
        buffer.set_rich_text(font_system, span_refs, &default_attrs, Shaping::Basic, None);
        buffer.shape_until_scroll(font_system, false);
        buffers[row_idx] = Some(buffer);
    }
}

fn run_ansi_builder(case: &Case, config: &Config) -> BenchResult {
    for _ in 0..config.warmup_iterations {
        std::hint::black_box(build_ansi_frame(case));
    }

    let mut samples = Vec::with_capacity(config.iterations);
    for _ in 0..config.iterations {
        let start = Instant::now();
        std::hint::black_box(build_ansi_frame(case));
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }

    stats_for("ansi_builder", case, config, &samples)
}

fn build_ansi_frame(case: &Case) -> String {
    let mut out = String::with_capacity(case.rows.len() * case.rows[0].len() * 6);
    let mut prev_style: Option<LineStyle> = None;
    out.push_str("\x1b[H\x1b[2J");

    for (row_idx, row) in case.rows.iter().enumerate() {
        if row_idx > 0 {
            out.push_str("\r\n");
        }

        for cell in row {
            let style = cell_style(cell);
            if prev_style != Some(style) {
                out.push_str("\x1b[0");
                out.push_str(&format!(
                    ";38;2;{};{};{}",
                    style.fg[0], style.fg[1], style.fg[2]
                ));
                if style.bold {
                    out.push_str(";1");
                }
                out.push('m');
                prev_style = Some(style);
            }
            out.push(if cell.c == '\0' { ' ' } else { cell.c });
        }
    }

    out.push_str("\x1b[0m");
    out
}

fn stats_for(renderer: &'static str, case: &Case, config: &Config, samples: &[f64]) -> BenchResult {
    let total_ms = samples.iter().sum::<f64>();
    BenchResult {
        renderer,
        case: case.name,
        iterations: config.iterations,
        warmup_iterations: config.warmup_iterations,
        cols: config.cols,
        rows: config.rows,
        total_ms,
        mean_ms: total_ms / samples.len() as f64,
        p50_ms: percentile(samples, 50.0),
        p95_ms: percentile(samples, 95.0),
        max_ms: samples.iter().copied().fold(0.0, f64::max),
    }
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.total_cmp(b));
    let idx = (((percentile / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted[idx]
}

fn make_uniform_case(name: &'static str, cols: usize, rows: usize, changed_lines: usize) -> Case {
    let mut viewport = Vec::with_capacity(rows);
    for row_idx in 0..rows {
        let mut row = vec![blank_cell(); cols];
        let text = format!(
            "file_{row_idx:03}.rs  Cargo.toml  README.md  src  target  scripts  docs  benches"
        );
        fill_text(&mut row, &text, [210, 210, 210], [0, 0, 0], false);
        viewport.push(row);
    }

    Case {
        name,
        rows: viewport,
        changed_rows: (0..changed_lines.min(rows)).collect(),
    }
}

fn make_mixed_case(name: &'static str, cols: usize, rows: usize, changed_lines: usize) -> Case {
    let mut viewport = Vec::with_capacity(rows);
    for row_idx in 0..rows {
        let mut row = vec![blank_cell(); cols];
        fill_text(&mut row, "@@ ", [180, 180, 180], [0, 0, 0], false);
        fill_text_at(
            &mut row,
            3,
            &format!("-{},{} +{},{}", row_idx + 1, 4, row_idx + 1, 4),
            [240, 200, 120],
            [0, 0, 0],
            false,
        );
        fill_text_at(
            &mut row,
            24,
            "-old_value()",
            [255, 90, 90],
            [0, 0, 0],
            false,
        );
        fill_text_at(
            &mut row,
            40,
            "+new_value()",
            [90, 220, 120],
            [0, 0, 0],
            true,
        );
        viewport.push(row);
    }

    Case {
        name,
        rows: viewport,
        changed_rows: (0..changed_lines.min(rows)).collect(),
    }
}

fn make_log_case(name: &'static str, cols: usize, rows: usize, changed_lines: usize) -> Case {
    let mut viewport = Vec::with_capacity(rows);
    for row_idx in 0..rows {
        let mut row = vec![blank_cell(); cols];
        fill_text_at(
            &mut row,
            0,
            &format!("2026-04-16T06:{:02}:12.123Z", row_idx % 60),
            [140, 180, 255],
            [0, 0, 0],
            false,
        );
        fill_text_at(&mut row, 25, " INFO ", [120, 220, 180], [0, 0, 0], true);
        fill_text_at(
            &mut row,
            32,
            "compiler.pipeline: finished chunk render and flushed viewport cache",
            [220, 220, 220],
            [0, 0, 0],
            false,
        );
        viewport.push(row);
    }

    let changed = if changed_lines >= rows {
        (0..rows).collect()
    } else {
        ((rows - changed_lines)..rows).collect()
    };

    Case {
        name,
        rows: viewport,
        changed_rows: changed,
    }
}

fn make_scroll_case(name: &'static str, cols: usize, rows: usize) -> Case {
    let mut viewport = Vec::with_capacity(rows);
    for row_idx in 0..rows {
        let mut row = vec![blank_cell(); cols];
        fill_text_at(
            &mut row,
            0,
            &format!(
                "scroll frame {:03}   cargo test --color=always",
                row_idx + 17
            ),
            [180, 180, 180],
            [0, 0, 0],
            false,
        );
        fill_text_at(&mut row, 44, "PASS", [120, 220, 180], [0, 0, 0], true);
        viewport.push(row);
    }

    Case {
        name,
        rows: viewport,
        changed_rows: (0..rows).collect(),
    }
}

fn make_unicode_case(name: &'static str, cols: usize, rows: usize, changed_lines: usize) -> Case {
    let mut viewport = Vec::with_capacity(rows);
    for row_idx in 0..rows {
        let mut row = vec![blank_cell(); cols];
        let color = match row_idx % 3 {
            0 => [255, 160, 90],
            1 => [120, 220, 255],
            _ => [180, 255, 140],
        };
        fill_text_at(
            &mut row,
            0,
            &format!("λ render ✓ café 👩‍💻 日本語 résumé naïve row {}", row_idx),
            color,
            [0, 0, 0],
            row_idx % 2 == 0,
        );
        viewport.push(row);
    }

    Case {
        name,
        rows: viewport,
        changed_rows: (0..changed_lines.min(rows)).collect(),
    }
}

fn blank_cell() -> Cell {
    Cell {
        c: ' ',
        fg: [220, 220, 220],
        bg: [0, 0, 0],
        bold: false,
    }
}

fn fill_text(row: &mut [Cell], text: &str, fg: [u8; 3], bg: [u8; 3], bold: bool) {
    fill_text_at(row, 0, text, fg, bg, bold);
}

fn fill_text_at(row: &mut [Cell], offset: usize, text: &str, fg: [u8; 3], bg: [u8; 3], bold: bool) {
    for (idx, ch) in text.chars().enumerate() {
        let Some(cell) = row.get_mut(offset + idx) else {
            break;
        };
        *cell = Cell {
            c: ch,
            fg,
            bg,
            bold,
        };
    }
}

fn build_line_text(cells: &[Cell]) -> String {
    let mut text = String::with_capacity(cells.len());
    for cell in cells {
        text.push(cell.c);
    }
    text
}

fn gap_spaces(count: usize) -> String {
    let mut spaces = String::with_capacity(count);
    spaces.extend(std::iter::repeat_n(' ', count));
    spaces
}

fn cell_style(cell: &Cell) -> LineStyle {
    LineStyle {
        fg: cell.fg,
        bold: cell.bold,
    }
}

fn attrs_for_style(style: LineStyle) -> Attrs<'static> {
    Attrs::new()
        .family(Family::Monospace)
        .color(GlyphonColor::rgb(style.fg[0], style.fg[1], style.fg[2]))
        .weight(if style.bold {
            GlyphonWeight::BOLD
        } else {
            GlyphonWeight::NORMAL
        })
}

fn uniform_line_style(cells: &[Cell]) -> Option<LineStyle> {
    let first = cells.first()?;
    let style = cell_style(first);
    cells
        .iter()
        .all(|cell| cell_style(cell) == style)
        .then_some(style)
}

fn flush_run(
    spans: &mut Vec<(String, Attrs<'static>)>,
    run_text: &mut String,
    run_style: &mut Option<LineStyle>,
) {
    if run_text.is_empty() {
        return;
    }

    let style = run_style.take().unwrap_or(LineStyle {
        fg: [220, 220, 220],
        bold: false,
    });
    spans.push((std::mem::take(run_text), attrs_for_style(style)));
}
