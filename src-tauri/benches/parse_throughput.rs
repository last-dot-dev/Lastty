//! L1 microbench: bytes/sec of `Processor::advance` on each corpus. The
//! "parse" hot path lives in alacritty_terminal — this is a baseline so we
//! can decide whether parser-level work would pay off.

use alacritty_terminal::event::VoidListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Term};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};
use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

use lastty::bench_corpus;

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

fn bench_parse_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse_throughput");
    for workload in bench_corpus::all() {
        let bytes = workload.bytes();
        group.throughput(Throughput::Bytes(bytes.len() as u64));
        group.bench_with_input(
            BenchmarkId::from_parameter(workload.name),
            &bytes,
            |b, bytes| {
                b.iter(|| {
                    // Fresh term each iter so wrap/scroll state doesn't drift,
                    // and so the parser sees a clean cursor on every run.
                    let mut term = Term::new(Config::default(), &BenchSize, VoidListener);
                    let mut parser = Processor::<StdSyncHandler>::new();
                    parser.advance(&mut term, bytes);
                });
            },
        );
    }
    group.finish();
}

criterion_group!(benches, bench_parse_throughput);
criterion_main!(benches);
