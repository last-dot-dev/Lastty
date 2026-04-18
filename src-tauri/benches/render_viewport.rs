//! L1 microbench: time `render_viewport` after pre-feeding a workload through
//! alacritty's parser. Establishes baseline cost + output size per workload.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use lastty::bench_corpus::{self, Workload};
use lastty::terminal::render::render_full;

const COLS: usize = 120;
const ROWS: usize = 40;

struct BenchSize;

impl Dimensions for BenchSize {
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

fn prepared_term(workload: &Workload) -> Term<VoidListener> {
    let mut term = Term::new(Config::default(), &BenchSize, VoidListener);
    let mut parser = Processor::<StdSyncHandler>::new();
    parser.advance(&mut term, &workload.bytes());
    term
}

fn bench_render_viewport(c: &mut Criterion) {
    let mut group = c.benchmark_group("render_viewport");
    for workload in bench_corpus::all() {
        let term = prepared_term(&workload);
        // First measurement: serialised ANSI byte count and bytes/cell ratio.
        let ansi = render_full(&term);
        let bytes_per_cell = ansi.len() as f64 / (COLS * ROWS) as f64;
        eprintln!(
            "[render_full] {} → ansi_bytes={} bytes/cell={:.2}",
            workload.name,
            ansi.len(),
            bytes_per_cell
        );

        group.throughput(Throughput::Bytes(ansi.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(workload.name),
            &term,
            |b, term| b.iter(|| render_full(term)),
        );
    }
    group.finish();
}

criterion_group!(benches, bench_render_viewport);
criterion_main!(benches);
