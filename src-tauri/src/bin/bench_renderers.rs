use std::env;
use std::fs;
use std::time::Instant;

use glyphon::{
    Attrs, Buffer, Color as GlyphonColor, Family, FontSystem, Metrics, Shaping,
    Weight as GlyphonWeight,
};

const VIEWPORT_COLS: usize = 221;
const VIEWPORT_ROWS: usize = 61;
const FONT_SIZE: f32 = 18.0;
const CELL_HEIGHT: f32 = 26.0;
const VIEWPORT_WIDTH: f32 = 2400.0;

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

struct BenchResult {
    renderer: &'static str,
    case: &'static str,
    iterations: usize,
    total_ms: f64,
    mean_ms: f64,
}

fn main() {
    let mut iterations = 30usize;
    let mut out_path: Option<String> = None;
    let args: Vec<String> = env::args().collect();
    let mut idx = 1usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--iterations" => {
                idx += 1;
                iterations = args
                    .get(idx)
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(iterations);
            }
            "--out" => {
                idx += 1;
                out_path = args.get(idx).cloned();
            }
            _ => {}
        }
        idx += 1;
    }

    let cases = vec![
        make_uniform_case("uniform_full_redraw", VIEWPORT_ROWS),
        make_uniform_case("uniform_single_line", 1),
        make_mixed_case("mixed_full_redraw", VIEWPORT_ROWS),
        make_mixed_case("mixed_single_line", 1),
        make_log_case("dense_logs_full_redraw", VIEWPORT_ROWS),
    ];

    let mut results = Vec::new();
    for case in &cases {
        results.push(run_glyphon_plain(case, iterations));
        results.push(run_glyphon_rich(case, iterations));
        results.push(run_ansi_builder(case, iterations));
    }

    println!("renderer         case                    mean_ms  total_ms  iterations");
    println!("---------------  ----------------------  -------  --------  ----------");
    for result in &results {
        println!(
            "{:<15}  {:<22}  {:>7.2}  {:>8.2}  {:>10}",
            result.renderer,
            result.case,
            result.mean_ms,
            result.total_ms,
            result.iterations
        );
    }

    if let Some(path) = out_path {
        let json = serde_json::to_string_pretty(
            &results
                .iter()
                .map(|result| {
                    serde_json::json!({
                        "renderer": result.renderer,
                        "case": result.case,
                        "iterations": result.iterations,
                        "total_ms": result.total_ms,
                        "mean_ms": result.mean_ms,
                    })
                })
                .collect::<Vec<_>>(),
        )
        .expect("serialize results");
        fs::write(path, json).expect("write benchmark output");
    }
}

fn run_glyphon_plain(case: &Case, iterations: usize) -> BenchResult {
    let metrics = Metrics::new(FONT_SIZE, CELL_HEIGHT);
    let mut font_system = FontSystem::new();
    let mut buffers: Vec<Option<Buffer>> = (0..VIEWPORT_ROWS).map(|_| None).collect();

    let start = Instant::now();
    for _ in 0..iterations {
        for &row_idx in &case.changed_rows {
            let row = &case.rows[row_idx];
            let mut buffer = buffers[row_idx]
                .take()
                .unwrap_or_else(|| Buffer::new(&mut font_system, metrics));
            buffer.set_size(&mut font_system, Some(VIEWPORT_WIDTH), Some(CELL_HEIGHT));

            let text = build_line_text(row);
            let style = uniform_line_style(row).unwrap_or(LineStyle {
                fg: [220, 220, 220],
                bold: false,
            });
            let attrs = attrs_for_style(style);
            buffer.set_text(&mut font_system, &text, &attrs, Shaping::Basic, None);
            buffer.shape_until_scroll(&mut font_system, false);
            buffers[row_idx] = Some(buffer);
        }
    }

    let total_ms = start.elapsed().as_secs_f64() * 1000.0;
    BenchResult {
        renderer: "glyphon_plain",
        case: case.name,
        iterations,
        total_ms,
        mean_ms: total_ms / iterations as f64,
    }
}

fn run_glyphon_rich(case: &Case, iterations: usize) -> BenchResult {
    let metrics = Metrics::new(FONT_SIZE, CELL_HEIGHT);
    let mut font_system = FontSystem::new();
    let mut buffers: Vec<Option<Buffer>> = (0..VIEWPORT_ROWS).map(|_| None).collect();

    let start = Instant::now();
    for _ in 0..iterations {
        for &row_idx in &case.changed_rows {
            let row = &case.rows[row_idx];
            let mut buffer = buffers[row_idx]
                .take()
                .unwrap_or_else(|| Buffer::new(&mut font_system, metrics));
            buffer.set_size(&mut font_system, Some(VIEWPORT_WIDTH), Some(CELL_HEIGHT));

            let mut spans: Vec<(String, Attrs)> = Vec::new();
            let mut run_text = String::new();
            let mut run_style: Option<LineStyle> = None;
            let mut last_col = 0usize;

            for (col, cell) in row.iter().enumerate() {
                if col > last_col {
                    flush_run(&mut spans, &mut run_text, &mut run_style);
                    let gap = col - last_col;
                    spans.push((gap_spaces(gap), Attrs::new().family(Family::Monospace)));
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
            let span_refs: Vec<(&str, Attrs)> =
                spans.iter().map(|(text, attrs)| (text.as_str(), attrs.clone())).collect();
            buffer.set_rich_text(
                &mut font_system,
                span_refs,
                &default_attrs,
                Shaping::Basic,
                None,
            );
            buffer.shape_until_scroll(&mut font_system, false);
            buffers[row_idx] = Some(buffer);
        }
    }

    let total_ms = start.elapsed().as_secs_f64() * 1000.0;
    BenchResult {
        renderer: "glyphon_rich",
        case: case.name,
        iterations,
        total_ms,
        mean_ms: total_ms / iterations as f64,
    }
}

fn run_ansi_builder(case: &Case, iterations: usize) -> BenchResult {
    let start = Instant::now();
    for _ in 0..iterations {
        let mut out = String::with_capacity(VIEWPORT_COLS * VIEWPORT_ROWS * 6);
        let mut prev_style: Option<LineStyle> = None;
        for row in &case.rows {
            for cell in row {
                let style = cell_style(cell);
                if prev_style != Some(style) {
                    out.push_str("\x1b[0m");
                    out.push_str(&format!(
                        "\x1b[38;2;{};{};{}m",
                        style.fg[0], style.fg[1], style.fg[2]
                    ));
                    if style.bold {
                        out.push_str("\x1b[1m");
                    }
                    prev_style = Some(style);
                }
                out.push(if cell.c == '\0' { ' ' } else { cell.c });
            }
            out.push_str("\r\n");
        }
        std::hint::black_box(out);
    }

    let total_ms = start.elapsed().as_secs_f64() * 1000.0;
    BenchResult {
        renderer: "ansi_builder",
        case: case.name,
        iterations,
        total_ms,
        mean_ms: total_ms / iterations as f64,
    }
}

fn make_uniform_case(name: &'static str, changed_lines: usize) -> Case {
    let mut rows = Vec::with_capacity(VIEWPORT_ROWS);
    for row_idx in 0..VIEWPORT_ROWS {
        let mut row = vec![blank_cell(); VIEWPORT_COLS];
        let text = format!(
            "file_{row_idx:03}.rs  Cargo.toml  README.md  src  target  scripts  docs"
        );
        fill_text(&mut row, &text, [210, 210, 210], [0, 0, 0], false);
        rows.push(row);
    }
    Case {
        name,
        rows,
        changed_rows: (0..changed_lines.min(VIEWPORT_ROWS)).collect(),
    }
}

fn make_mixed_case(name: &'static str, changed_lines: usize) -> Case {
    let mut rows = Vec::with_capacity(VIEWPORT_ROWS);
    for row_idx in 0..VIEWPORT_ROWS {
        let mut row = vec![blank_cell(); VIEWPORT_COLS];
        fill_text(&mut row, "@@ ", [180, 180, 180], [0, 0, 0], false);
        fill_text_at(
            &mut row,
            3,
            &format!("-{},{} +{},{}", row_idx + 1, 4, row_idx + 1, 4),
            [240, 200, 120],
            [0, 0, 0],
            false,
        );
        fill_text_at(&mut row, 24, "-old_value()", [255, 90, 90], [0, 0, 0], false);
        fill_text_at(&mut row, 38, "+new_value()", [90, 220, 120], [0, 0, 0], true);
        rows.push(row);
    }
    Case {
        name,
        rows,
        changed_rows: (0..changed_lines.min(VIEWPORT_ROWS)).collect(),
    }
}

fn make_log_case(name: &'static str, changed_lines: usize) -> Case {
    let mut rows = Vec::with_capacity(VIEWPORT_ROWS);
    for row_idx in 0..VIEWPORT_ROWS {
        let mut row = vec![blank_cell(); VIEWPORT_COLS];
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
        rows.push(row);
    }
    Case {
        name,
        rows,
        changed_rows: (0..changed_lines.min(VIEWPORT_ROWS)).collect(),
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

fn fill_text_at(
    row: &mut [Cell],
    offset: usize,
    text: &str,
    fg: [u8; 3],
    bg: [u8; 3],
    bold: bool,
) {
    for (idx, ch) in text.chars().enumerate() {
        let Some(cell) = row.get_mut(offset + idx) else {
            break;
        };
        *cell = Cell { c: ch, fg, bg, bold };
    }
}

fn build_line_text(cells: &[Cell]) -> String {
    cells.iter().map(|cell| cell.c).collect()
}

fn gap_spaces(count: usize) -> String {
    " ".repeat(count)
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
    cells.iter().all(|cell| cell_style(cell) == style).then_some(style)
}

#[derive(Clone, Copy, PartialEq)]
struct LineStyle {
    fg: [u8; 3],
    bold: bool,
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
