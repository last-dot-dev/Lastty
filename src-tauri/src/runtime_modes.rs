#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BenchmarkMode {
    Xterm,
}

impl BenchmarkMode {
    pub fn from_env_value(value: Option<&str>) -> Option<Self> {
        match value {
            Some("xterm") => Some(Self::Xterm),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Xterm => "xterm",
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
        assert_eq!(BenchmarkMode::from_env_value(Some("other")), None);
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
