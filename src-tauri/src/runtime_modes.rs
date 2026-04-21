#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BenchmarkMode {
    Xterm,
    Stress,
}

impl BenchmarkMode {
    pub fn from_env_value(value: Option<&str>) -> Option<Self> {
        match value {
            Some("xterm") => Some(Self::Xterm),
            Some("stress") => Some(Self::Stress),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Xterm => "xterm",
            Self::Stress => "stress",
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BenchmarkConfig {
    pub cols: u16,
    pub rows: u16,
    pub iterations: u32,
    pub warmup_iterations: u32,
    pub output_path: String,
    pub force_failure_message: Option<String>,
}

pub fn resolved_benchmark_mode() -> Option<BenchmarkMode> {
    BenchmarkMode::from_env_value(std::env::var("LASTTY_BENCH_MODE").ok().as_deref())
}

pub fn benchmark_config() -> BenchmarkConfig {
    benchmark_config_from_env(|key| std::env::var(key).ok())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StressBenchConfig {
    pub duration_ms: u64,
    pub panes: u32,
    pub scenarios: Vec<String>,
    pub simulator_path: String,
    pub cols: u16,
    pub rows: u16,
    pub output_path: String,
}

pub fn stress_bench_config() -> StressBenchConfig {
    stress_bench_config_from_env(|key| std::env::var(key).ok())
}

fn stress_bench_config_from_env(
    mut get_var: impl FnMut(&str) -> Option<String>,
) -> StressBenchConfig {
    let scenarios = get_var("LASTTY_BENCH_SCENARIOS")
        .map(|raw| {
            raw.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            vec![
                "streaming-text".to_string(),
                "color-cycle".to_string(),
                "fade".to_string(),
                "spinner-log".to_string(),
                "alt-screen-redraw".to_string(),
                "tool-burst".to_string(),
            ]
        });
    let panes = env_u32(&mut get_var, "LASTTY_BENCH_PANES", scenarios.len() as u32);
    StressBenchConfig {
        duration_ms: env_u64(&mut get_var, "LASTTY_BENCH_DURATION_MS", 30_000),
        panes,
        scenarios,
        simulator_path: get_var("LASTTY_BENCH_SIMULATOR")
            .unwrap_or_else(|| "scripts/stress/simulate.mjs".to_string()),
        cols: env_u16(&mut get_var, "LASTTY_BENCH_COLS", 120),
        rows: env_u16(&mut get_var, "LASTTY_BENCH_ROWS", 40),
        output_path: get_var("LASTTY_BENCH_OUTPUT")
            .unwrap_or_else(|| "/tmp/lastty-stress.json".to_string()),
    }
}

fn env_u64(get_var: &mut impl FnMut(&str) -> Option<String>, key: &str, default: u64) -> u64 {
    get_var(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn benchmark_config_from_env(mut get_var: impl FnMut(&str) -> Option<String>) -> BenchmarkConfig {
    BenchmarkConfig {
        cols: env_u16(&mut get_var, "LASTTY_BENCH_COLS", 221),
        rows: env_u16(&mut get_var, "LASTTY_BENCH_ROWS", 61),
        iterations: env_u32(&mut get_var, "LASTTY_BENCH_ITERATIONS", 20),
        warmup_iterations: env_u32(&mut get_var, "LASTTY_BENCH_WARMUP", 5),
        output_path: get_var("LASTTY_BENCH_OUTPUT")
            .unwrap_or_else(|| "/tmp/lastty-xterm-bench.json".to_string()),
        force_failure_message: get_var("LASTTY_BENCH_FORCE_FAILURE").and_then(|value| match value
            .trim()
        {
            "" => None,
            trimmed => Some(trimmed.to_string()),
        }),
    }
}

fn env_u16(get_var: &mut impl FnMut(&str) -> Option<String>, key: &str, default: u16) -> u16 {
    get_var(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn env_u32(get_var: &mut impl FnMut(&str) -> Option<String>, key: &str, default: u32) -> u32 {
    get_var(key)
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{benchmark_config_from_env, BenchmarkMode};

    #[test]
    fn parses_benchmark_mode() {
        assert_eq!(
            BenchmarkMode::from_env_value(Some("xterm")),
            Some(BenchmarkMode::Xterm)
        );
        assert_eq!(
            BenchmarkMode::from_env_value(Some("stress")),
            Some(BenchmarkMode::Stress)
        );
        assert_eq!(BenchmarkMode::from_env_value(Some("other")), None);
    }

    #[test]
    fn stress_config_defaults_when_env_missing() {
        let config = super::stress_bench_config_from_env(|_| None);
        assert_eq!(config.duration_ms, 30_000);
        assert_eq!(config.panes, 6);
        assert_eq!(config.scenarios.len(), 6);
        assert_eq!(config.cols, 120);
        assert_eq!(config.rows, 40);
    }

    #[test]
    fn stress_config_parses_comma_separated_scenarios() {
        let vars = HashMap::from([
            ("LASTTY_BENCH_SCENARIOS", "fade, tool-burst"),
            ("LASTTY_BENCH_PANES", "2"),
            ("LASTTY_BENCH_DURATION_MS", "5000"),
        ]);
        let config =
            super::stress_bench_config_from_env(|key| vars.get(key).map(|value| value.to_string()));
        assert_eq!(config.scenarios, vec!["fade", "tool-burst"]);
        assert_eq!(config.panes, 2);
        assert_eq!(config.duration_ms, 5000);
    }

    #[test]
    fn benchmark_config_reads_optional_failure_message() {
        let vars = HashMap::from([
            ("LASTTY_BENCH_COLS", "120"),
            ("LASTTY_BENCH_ROWS", "40"),
            ("LASTTY_BENCH_ITERATIONS", "7"),
            ("LASTTY_BENCH_WARMUP", "2"),
            ("LASTTY_BENCH_OUTPUT", "/tmp/custom-bench.json"),
            (
                "LASTTY_BENCH_FORCE_FAILURE",
                "intentional benchmark failure",
            ),
        ]);
        let config = benchmark_config_from_env(|key| vars.get(key).map(|value| value.to_string()));
        assert_eq!(config.cols, 120);
        assert_eq!(config.rows, 40);
        assert_eq!(config.iterations, 7);
        assert_eq!(config.warmup_iterations, 2);
        assert_eq!(config.output_path, "/tmp/custom-bench.json");
        assert_eq!(
            config.force_failure_message.as_deref(),
            Some("intentional benchmark failure")
        );
    }

    #[test]
    fn blank_failure_message_is_ignored() {
        let vars = HashMap::from([("LASTTY_BENCH_FORCE_FAILURE", "   ")]);
        let config = benchmark_config_from_env(|key| vars.get(key).map(|value| value.to_string()));
        assert_eq!(config.force_failure_message, None);
    }
}
