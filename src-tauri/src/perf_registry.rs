use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

use crate::terminal::session::SessionId;

const SAMPLE_CAP: usize = 16_384;

#[derive(Default)]
pub struct SessionPerf {
    pub scenario: Option<String>,
    pub marks: u64,
    pub first_pending_mark: Option<Instant>,
    pub emits: u64,
    pub mark_to_emit_us: Vec<u64>,
    pub render_us: Vec<u64>,
    pub emit_us: Vec<u64>,
    pub ansi_bytes: Vec<u32>,
    pub frontend_write_ms: Vec<f64>,
}

#[derive(Default)]
pub struct LifecycleSamples {
    pub stages: HashMap<String, Vec<f64>>,
}

pub struct PerfRegistry {
    sessions: Mutex<HashMap<SessionId, Arc<Mutex<SessionPerf>>>>,
    lifecycle: Mutex<LifecycleSamples>,
}

impl PerfRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            lifecycle: Mutex::new(LifecycleSamples::default()),
        }
    }

    pub fn record_lifecycle(&self, stage: impl Into<String>, ms: f64) {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        lifecycle.stages.entry(stage.into()).or_default().push(ms);
    }

    pub fn register(&self, session_id: SessionId, scenario: Option<String>) {
        let entry = self.entry(session_id);
        let mut perf = entry.lock().unwrap();
        if perf.scenario.is_none() {
            perf.scenario = scenario;
        }
    }

    pub fn record_mark(&self, session_id: SessionId) {
        let entry = self.entry(session_id);
        let mut perf = entry.lock().unwrap();
        perf.marks = perf.marks.saturating_add(1);
        if perf.first_pending_mark.is_none() {
            perf.first_pending_mark = Some(Instant::now());
        }
    }

    pub fn take_mark_to_emit(&self, session_id: SessionId) -> Option<u64> {
        let entry = self.entry(session_id);
        let mut perf = entry.lock().unwrap();
        let first = perf.first_pending_mark.take()?;
        let us = first.elapsed().as_micros().min(u64::MAX as u128) as u64;
        if perf.mark_to_emit_us.len() < SAMPLE_CAP {
            perf.mark_to_emit_us.push(us);
        }
        Some(us)
    }

    pub fn record_emit(
        &self,
        session_id: SessionId,
        render_us: u64,
        emit_us: u64,
        ansi_bytes: u32,
    ) {
        let entry = self.entry(session_id);
        let mut perf = entry.lock().unwrap();
        perf.emits = perf.emits.saturating_add(1);
        if perf.render_us.len() < SAMPLE_CAP {
            perf.render_us.push(render_us);
        }
        if perf.emit_us.len() < SAMPLE_CAP {
            perf.emit_us.push(emit_us);
        }
        if perf.ansi_bytes.len() < SAMPLE_CAP {
            perf.ansi_bytes.push(ansi_bytes);
        }
    }

    pub fn record_frontend_write(&self, session_id: SessionId, write_ms: f64) {
        let entry = self.entry(session_id);
        let mut perf = entry.lock().unwrap();
        if perf.frontend_write_ms.len() < SAMPLE_CAP {
            perf.frontend_write_ms.push(write_ms);
        }
    }

    pub fn snapshot(&self) -> PerfReport {
        let entries: Vec<(SessionId, Arc<Mutex<SessionPerf>>)> = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .iter()
                .map(|(id, arc)| (*id, arc.clone()))
                .collect()
        };
        let mut out = Vec::with_capacity(entries.len());
        for (id, perf_arc) in entries {
            let perf = perf_arc.lock().unwrap();
            out.push(session_report(id, &perf));
        }
        out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        let aggregate = aggregate_report(&out);
        let hotspots = compute_hotspots(&out);
        let lifecycle = {
            let lifecycle = self.lifecycle.lock().unwrap();
            lifecycle
                .stages
                .iter()
                .map(|(stage, samples)| (stage.clone(), stats_f64(samples)))
                .collect()
        };
        PerfReport {
            sessions: out,
            aggregate,
            hotspots,
            lifecycle,
        }
    }

    fn entry(&self, session_id: SessionId) -> Arc<Mutex<SessionPerf>> {
        let mut map = self.sessions.lock().unwrap();
        map.entry(session_id)
            .or_insert_with(|| Arc::new(Mutex::new(SessionPerf::default())))
            .clone()
    }
}

impl Default for PerfRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StageStats {
    pub samples: usize,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
    pub avg: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionReport {
    pub session_id: String,
    pub scenario: Option<String>,
    pub marks: u64,
    pub emits: u64,
    pub coalesce_ratio: f64,
    pub mark_to_emit_us: StageStats,
    pub render_us: StageStats,
    pub emit_us: StageStats,
    pub ansi_bytes: StageStats,
    pub frontend_write_ms: StageStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hotspot {
    pub session_id: String,
    pub scenario: Option<String>,
    pub stage: &'static str,
    pub p95: f64,
    pub total_ms: f64,
    pub share_of_total_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PerfReport {
    pub sessions: Vec<SessionReport>,
    pub aggregate: AggregateReport,
    pub hotspots: Vec<Hotspot>,
    pub lifecycle: HashMap<String, StageStats>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AggregateReport {
    pub total_marks: u64,
    pub total_emits: u64,
    pub coalesce_ratio: f64,
    pub render_us: StageStats,
    pub emit_us: StageStats,
    pub mark_to_emit_us: StageStats,
    pub frontend_write_ms: StageStats,
    pub ansi_bytes: StageStats,
}

fn session_report(id: SessionId, perf: &SessionPerf) -> SessionReport {
    let coalesce_ratio = if perf.marks == 0 {
        0.0
    } else {
        perf.emits as f64 / perf.marks as f64
    };
    SessionReport {
        session_id: id.to_string(),
        scenario: perf.scenario.clone(),
        marks: perf.marks,
        emits: perf.emits,
        coalesce_ratio,
        mark_to_emit_us: stats_u64(&perf.mark_to_emit_us),
        render_us: stats_u64(&perf.render_us),
        emit_us: stats_u64(&perf.emit_us),
        ansi_bytes: stats_u32(&perf.ansi_bytes),
        frontend_write_ms: stats_f64(&perf.frontend_write_ms),
    }
}

fn aggregate_report(sessions: &[SessionReport]) -> AggregateReport {
    if sessions.is_empty() {
        return AggregateReport::default();
    }
    let total_marks: u64 = sessions.iter().map(|s| s.marks).sum();
    let total_emits: u64 = sessions.iter().map(|s| s.emits).sum();
    AggregateReport {
        total_marks,
        total_emits,
        coalesce_ratio: if total_marks == 0 {
            0.0
        } else {
            total_emits as f64 / total_marks as f64
        },
        render_us: merge_stats(sessions.iter().map(|s| &s.render_us)),
        emit_us: merge_stats(sessions.iter().map(|s| &s.emit_us)),
        mark_to_emit_us: merge_stats(sessions.iter().map(|s| &s.mark_to_emit_us)),
        frontend_write_ms: merge_stats(sessions.iter().map(|s| &s.frontend_write_ms)),
        ansi_bytes: merge_stats(sessions.iter().map(|s| &s.ansi_bytes)),
    }
}

/// Ranks stages by total wall time spent (p95 × emits, converted to ms).
fn compute_hotspots(sessions: &[SessionReport]) -> Vec<Hotspot> {
    const STAGES: &[(&str, fn(&SessionReport) -> &StageStats, f64)] = &[
        ("render_us", |s| &s.render_us, 1_000.0),
        ("emit_us", |s| &s.emit_us, 1_000.0),
        ("mark_to_emit_us", |s| &s.mark_to_emit_us, 1_000.0),
        ("frontend_write_ms", |s| &s.frontend_write_ms, 1.0),
    ];
    let mut rows: Vec<Hotspot> = Vec::new();
    for s in sessions {
        for &(stage, get_stats, divisor_to_ms) in STAGES {
            let stats = get_stats(s);
            if stats.samples == 0 || s.emits == 0 {
                continue;
            }
            rows.push(Hotspot {
                session_id: s.session_id.clone(),
                scenario: s.scenario.clone(),
                stage,
                p95: stats.p95,
                total_ms: stats.p95 * s.emits as f64 / divisor_to_ms,
                share_of_total_pct: 0.0,
            });
        }
    }
    let total_ms: f64 = rows.iter().map(|r| r.total_ms).sum();
    if total_ms > 0.0 {
        for row in rows.iter_mut() {
            row.share_of_total_pct = row.total_ms / total_ms * 100.0;
        }
    }
    rows.sort_by(|a, b| {
        b.total_ms
            .partial_cmp(&a.total_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(10);
    rows
}

fn stats_from_sorted(mut sorted: Vec<f64>, total: f64) -> StageStats {
    if sorted.is_empty() {
        return StageStats::default();
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let last = sorted.len() - 1;
    let p50 = sorted[(sorted.len() * 50 / 100).min(last)];
    let p95 = sorted[(sorted.len() * 95 / 100).min(last)];
    StageStats {
        samples: sorted.len(),
        p50,
        p95,
        max: sorted[last],
        avg: total / sorted.len() as f64,
        total,
    }
}

fn stats_u64(samples: &[u64]) -> StageStats {
    let total: u64 = samples.iter().sum();
    stats_from_sorted(samples.iter().map(|v| *v as f64).collect(), total as f64)
}

fn stats_u32(samples: &[u32]) -> StageStats {
    let total: u64 = samples.iter().map(|v| *v as u64).sum();
    stats_from_sorted(samples.iter().map(|v| *v as f64).collect(), total as f64)
}

fn stats_f64(samples: &[f64]) -> StageStats {
    let total: f64 = samples.iter().sum();
    stats_from_sorted(samples.to_vec(), total)
}

/// Percentile-of-percentiles isn't statistically rigorous but is good enough
/// for a "which stage dominated the whole run" summary; `samples`, `total`,
/// and `avg` are exact.
fn merge_stats<'a, I: Iterator<Item = &'a StageStats>>(stats: I) -> StageStats {
    let mut samples = 0usize;
    let mut total = 0f64;
    let mut max = 0f64;
    let mut p50_acc = 0f64;
    let mut p95_acc = 0f64;
    let mut count = 0usize;
    for s in stats {
        if s.samples == 0 {
            continue;
        }
        samples += s.samples;
        total += s.total;
        max = max.max(s.max);
        p50_acc += s.p50;
        p95_acc += s.p95;
        count += 1;
    }
    if count == 0 {
        return StageStats::default();
    }
    StageStats {
        samples,
        p50: p50_acc / count as f64,
        p95: p95_acc / count as f64,
        max,
        avg: total / samples as f64,
        total,
    }
}

impl Default for StageStats {
    fn default() -> Self {
        Self {
            samples: 0,
            p50: 0.0,
            p95: 0.0,
            max: 0.0,
            avg: 0.0,
            total: 0.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_marks_and_emits() {
        let registry = PerfRegistry::new();
        let id = SessionId::new();
        registry.register(id, Some("fade".into()));
        registry.record_mark(id);
        registry.record_mark(id);
        let latency = registry.take_mark_to_emit(id);
        assert!(latency.is_some());
        registry.record_emit(id, 100, 30, 1500);
        registry.record_frontend_write(id, 1.2);

        let report = registry.snapshot();
        assert_eq!(report.sessions.len(), 1);
        let s = &report.sessions[0];
        assert_eq!(s.marks, 2);
        assert_eq!(s.emits, 1);
        assert_eq!(s.scenario.as_deref(), Some("fade"));
        assert_eq!(s.render_us.samples, 1);
        assert_eq!(s.frontend_write_ms.samples, 1);
    }

    #[test]
    fn hotspots_sorted_by_total_time() {
        let registry = PerfRegistry::new();
        let slow = SessionId::new();
        let fast = SessionId::new();
        registry.register(slow, Some("slow".into()));
        registry.register(fast, Some("fast".into()));
        for _ in 0..200 {
            registry.record_emit(slow, 800, 50, 1000);
            registry.record_emit(fast, 50, 20, 500);
        }
        let report = registry.snapshot();
        assert!(!report.hotspots.is_empty());
        // The slow session's render stage should dominate the top hotspot.
        let top = &report.hotspots[0];
        assert_eq!(top.stage, "render_us");
        assert_eq!(top.scenario.as_deref(), Some("slow"));
    }
}
