//! Deterministic terminal-output corpora used by Phase 0 benches and the
//! `bench_pipeline` binary. Each workload is a sequence of byte chunks with
//! optional inter-chunk delays so latency-sensitive benches can replay the
//! original cadence (`keystroke_echo`) while throughput benches just feed
//! `bytes()` straight to a parser.

use std::io::Write as _;
use std::time::Duration;

#[derive(Clone)]
pub struct WorkloadChunk {
    pub bytes: Vec<u8>,
    /// Delay before this chunk is fed (used by latency benches; throughput
    /// benches ignore it).
    pub delay: Duration,
}

#[derive(Clone)]
pub struct Workload {
    pub name: &'static str,
    pub chunks: Vec<WorkloadChunk>,
}

impl Workload {
    pub fn bytes(&self) -> Vec<u8> {
        let total = self.total_bytes();
        let mut out = Vec::with_capacity(total);
        for c in &self.chunks {
            out.extend_from_slice(&c.bytes);
        }
        out
    }

    pub fn total_bytes(&self) -> usize {
        self.chunks.iter().map(|c| c.bytes.len()).sum()
    }
}

/// xorshift64. Stable, good enough for deterministic corpus generation;
/// avoids dragging `rand` into the dev tree.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn range(&mut self, n: usize) -> usize {
        (self.next_u64() as usize) % n
    }
}

const WORDS: &[&str] = &[
    "lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "eiusmod",
    "tempor",
    "incididunt",
    "labore",
    "magna",
    "aliqua",
    "enim",
    "minim",
    "veniam",
    "quis",
    "nostrud",
    "exercitation",
    "ullamco",
    "laboris",
    "nisi",
    "aliquip",
    "commodo",
    "consequat",
    "duis",
    "aute",
    "irure",
    "voluptate",
    "velit",
    "esse",
    "cillum",
    "fugiat",
    "nulla",
    "pariatur",
    "excepteur",
    "sint",
    "occaecat",
];

fn push_words(rng: &mut Rng, out: &mut Vec<u8>, count: usize) {
    for w in 0..count {
        if w > 0 {
            out.push(b' ');
        }
        out.extend_from_slice(WORDS[rng.range(WORDS.len())].as_bytes());
    }
}

pub fn all() -> Vec<Workload> {
    vec![
        plain_scroll(),
        colored_log(),
        vim_refresh(),
        agent_tui(),
        keystroke_echo(),
    ]
}

pub fn by_name(name: &str) -> Option<Workload> {
    match name {
        "plain_scroll" => Some(plain_scroll()),
        "colored_log" => Some(colored_log()),
        "vim_refresh" => Some(vim_refresh()),
        "agent_tui" => Some(agent_tui()),
        "keystroke_echo" => Some(keystroke_echo()),
        _ => None,
    }
}

pub fn plain_scroll() -> Workload {
    let mut rng = Rng::new(0xa5a5_a5a5_a5a5_a5a5);
    let mut bytes = Vec::with_capacity(10_000 * 80);
    for _ in 0..10_000 {
        let count = 6 + rng.range(8);
        push_words(&mut rng, &mut bytes, count);
        bytes.extend_from_slice(b"\r\n");
    }
    Workload {
        name: "plain_scroll",
        chunks: vec![WorkloadChunk {
            bytes,
            delay: Duration::ZERO,
        }],
    }
}

pub fn colored_log() -> Workload {
    let mut rng = Rng::new(0xdead_beef_dead_beef);
    let mut bytes = Vec::with_capacity(5_000 * 120);
    for line in 0..5_000_u32 {
        match line % 3 {
            0 => {
                let fg = 30 + rng.range(8);
                let _ = write!(&mut bytes, "\x1b[{fg}m");
            }
            1 => {
                let idx = rng.range(256);
                let _ = write!(&mut bytes, "\x1b[38;5;{idx}m");
            }
            _ => {
                let (r, g, b) = (rng.range(256), rng.range(256), rng.range(256));
                let _ = write!(&mut bytes, "\x1b[38;2;{r};{g};{b}m");
            }
        }
        let count = 6 + rng.range(10);
        push_words(&mut rng, &mut bytes, count);
        bytes.extend_from_slice(b"\x1b[0m\r\n");
    }
    Workload {
        name: "colored_log",
        chunks: vec![WorkloadChunk {
            bytes,
            delay: Duration::ZERO,
        }],
    }
}

pub fn vim_refresh() -> Workload {
    let mut rng = Rng::new(0xbeef_cafe_beef_cafe);
    let mut bytes = Vec::new();
    // 50 alt-screen full-repaint cycles (file open / close pattern).
    for _ in 0..50 {
        bytes.extend_from_slice(b"\x1b[?1049h\x1b[H");
        for line in 0..60_u32 {
            let _ = write!(&mut bytes, "\x1b[{};1H", line + 1);
            let parts = 4 + rng.range(4);
            for p in 0..parts {
                if p > 0 {
                    bytes.push(b' ');
                }
                let color = match rng.range(4) {
                    0 => 32,
                    1 => 36,
                    2 => 33,
                    _ => 37,
                };
                let _ = write!(&mut bytes, "\x1b[{color}m");
                bytes.extend_from_slice(WORDS[rng.range(WORDS.len())].as_bytes());
                bytes.extend_from_slice(b"\x1b[0m");
            }
        }
        bytes.extend_from_slice(b"\x1b[7m-- INSERT --\x1b[0m");
        bytes.extend_from_slice(b"\x1b[?1049l");
    }
    Workload {
        name: "vim_refresh",
        chunks: vec![WorkloadChunk {
            bytes,
            delay: Duration::ZERO,
        }],
    }
}

pub fn agent_tui() -> Workload {
    let mut rng = Rng::new(0x1234_5678_9abc_def0);
    let mut bytes = Vec::new();
    for i in 0..2_000_u32 {
        if i % 5 == 0 {
            // Plausible-shaped envelope; payload contents are opaque to the
            // parsers we care about, only the framing matters.
            let _ = write!(
                &mut bytes,
                "\x1b]7770;{{\"type\":\"ToolCall\",\"data\":{{\"id\":\"t{i}\",\"name\":\"bench\",\"args\":{{}}}}}}\x07"
            );
        }
        let count = 8 + rng.range(8);
        push_words(&mut rng, &mut bytes, count);
        bytes.extend_from_slice(b"\r\n");
    }
    Workload {
        name: "agent_tui",
        chunks: vec![WorkloadChunk {
            bytes,
            delay: Duration::ZERO,
        }],
    }
}

pub fn keystroke_echo() -> Workload {
    let mut rng = Rng::new(0xf00d_d00d_f00d_d00d);
    let alphabet: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789 ";
    let mut chunks = Vec::with_capacity(1_000);
    for _ in 0..1_000 {
        let byte = alphabet[rng.range(alphabet.len())];
        chunks.push(WorkloadChunk {
            bytes: vec![byte],
            delay: Duration::from_millis(5),
        });
    }
    Workload {
        name: "keystroke_echo",
        chunks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workloads_are_deterministic() {
        assert_eq!(plain_scroll().bytes(), plain_scroll().bytes());
        assert_eq!(colored_log().bytes(), colored_log().bytes());
        assert_eq!(vim_refresh().bytes(), vim_refresh().bytes());
        assert_eq!(agent_tui().bytes(), agent_tui().bytes());
    }

    #[test]
    fn workloads_are_nonempty() {
        for w in all() {
            assert!(w.total_bytes() > 0, "{} produced no bytes", w.name);
        }
    }

    #[test]
    fn keystroke_echo_has_per_byte_delays() {
        let w = keystroke_echo();
        assert_eq!(w.chunks.len(), 1_000);
        for c in &w.chunks {
            assert_eq!(c.bytes.len(), 1);
            assert_eq!(c.delay, Duration::from_millis(5));
        }
    }
}
