//! L1 synthetic bench: producer thread pumps `mark_dirty` against a real
//! `RenderCoordinator` while a consumer thread mimics the frame-emitter loop
//! in `terminal/render.rs`. Reports emits-per-mark coalesce ratio and
//! mark→emit latency percentiles for a few representative cadences.
//!
//! Custom main (criterion's iteration model doesn't fit a steady-state
//! producer/consumer scenario; we just want one timed run per cadence).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use lastty::render_sync::RenderCoordinator;
use lastty::terminal::session::SessionId;

const RENDER_COST: Duration = Duration::from_millis(2);
const RUN_DURATION: Duration = Duration::from_secs(3);
const CAP_VARIANTS: &[Duration] = &[
    Duration::ZERO,
    Duration::from_millis(2),
    Duration::from_millis(4),
    Duration::from_millis(8),
];

struct Scenario {
    name: &'static str,
    mark_interval: Duration,
}

const SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "burst_1ms",
        mark_interval: Duration::from_millis(1),
    },
    Scenario {
        name: "steady_8ms",
        mark_interval: Duration::from_millis(8),
    },
    Scenario {
        name: "keystroke_5ms",
        mark_interval: Duration::from_millis(5),
    },
];

struct Report {
    name: &'static str,
    cap_ms: u64,
    marks: u64,
    emits: u64,
    coalesce_ratio: f64,
    p50_latency_us: u64,
    p95_latency_us: u64,
    max_latency_us: u64,
}

fn main() {
    println!(
        "frame_coalesce — render_cost={:?} run={:?}",
        RENDER_COST, RUN_DURATION
    );
    println!(
        "{:<16} {:>6} {:>10} {:>10} {:>14} {:>10} {:>10} {:>10}",
        "scenario", "cap_ms", "marks", "emits", "emits/marks", "p50_us", "p95_us", "max_us"
    );
    for scenario in SCENARIOS {
        for &cap in CAP_VARIANTS {
            let report = run(scenario, cap);
            println!(
                "{:<16} {:>6} {:>10} {:>10} {:>14.3} {:>10} {:>10} {:>10}",
                report.name,
                report.cap_ms,
                report.marks,
                report.emits,
                report.coalesce_ratio,
                report.p50_latency_us,
                report.p95_latency_us,
                report.max_latency_us,
            );
        }
    }
}

fn run(scenario: &Scenario, frame_cap: Duration) -> Report {
    let coordinator = Arc::new(RenderCoordinator::new());
    let stop = Arc::new(AtomicBool::new(false));
    // Time of the first mark since last emit. Cleared on emit; set on mark
    // when None. Captures "how long has the consumer been behind the
    // producer" for the latency metric.
    let first_pending_mark: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    let session = SessionId::new();

    let producer_marks = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let producer = {
        let coordinator = coordinator.clone();
        let stop = stop.clone();
        let first_pending_mark = first_pending_mark.clone();
        let marks = producer_marks.clone();
        let interval = scenario.mark_interval;
        thread::spawn(move || {
            let start = Instant::now();
            let mut next = start;
            while !stop.load(Ordering::Relaxed) {
                next += interval;
                let now = Instant::now();
                if next > now {
                    thread::sleep(next - now);
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
        })
    };

    // Consumer: replicate the emit loop from terminal/render.rs without the
    // Tauri side. Frame cap and a no-op "render" that just sleeps.
    let mut latencies_us: Vec<u64> = Vec::with_capacity(8 * 1024);
    let mut emits = 0u64;
    let consumer_start = Instant::now();
    let mut rendered_generation = coordinator.current_generation();
    let mut last_emit: Option<Instant> = None;

    while consumer_start.elapsed() < RUN_DURATION {
        let _dirty = coordinator.wait_for_next(rendered_generation);
        if !frame_cap.is_zero() {
            if let Some(last) = last_emit {
                let elapsed = last.elapsed();
                if elapsed < frame_cap {
                    thread::sleep(frame_cap - elapsed);
                }
            }
        }
        let gen_at_render = coordinator.current_generation();
        // Take the first-pending-mark instant *before* simulated render so
        // latency measures producer→render-start, matching what the user
        // perceives as input lag.
        let mark_instant = first_pending_mark.lock().unwrap().take();
        thread::sleep(RENDER_COST);
        rendered_generation = gen_at_render;
        last_emit = Some(Instant::now());
        emits += 1;
        if let Some(mark_instant) = mark_instant {
            let latency = mark_instant.elapsed();
            latencies_us.push(latency.as_micros().min(u64::MAX as u128) as u64);
        }
    }

    stop.store(true, Ordering::Relaxed);
    // Wake the producer if it's mid-sleep — and unblock the consumer if
    // we're already past run duration but the loop is still inside wait.
    coordinator.mark_dirty(session);
    producer.join().expect("producer thread");

    let marks = producer_marks.load(Ordering::Relaxed);
    let coalesce_ratio = if marks == 0 {
        0.0
    } else {
        emits as f64 / marks as f64
    };

    latencies_us.sort_unstable();
    let p50 = percentile(&latencies_us, 50);
    let p95 = percentile(&latencies_us, 95);
    let max = latencies_us.last().copied().unwrap_or(0);

    Report {
        name: scenario.name,
        cap_ms: frame_cap.as_millis() as u64,
        marks,
        emits,
        coalesce_ratio,
        p50_latency_us: p50,
        p95_latency_us: p95,
        max_latency_us: max,
    }
}

fn percentile(sorted: &[u64], pct: u8) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = (sorted.len() * pct as usize) / 100;
    sorted[idx.min(sorted.len() - 1)]
}
