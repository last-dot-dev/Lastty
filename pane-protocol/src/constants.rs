/// OSC namespace ID for agent-to-app messages.
pub const OSC_AGENT_TO_APP: &str = "7770";

/// OSC namespace ID for app-to-agent messages.
pub const OSC_APP_TO_AGENT: &str = "7771";

/// Maximum payload size in bytes before we treat it as malformed.
pub const MAX_PAYLOAD_SIZE: usize = 64 * 1024;

/// OSC start sequence: ESC ]
pub const OSC_START: &[u8] = b"\x1b]";

/// BEL character — string terminator.
pub const BEL: u8 = 0x07;

/// ESC character.
pub const ESC: u8 = 0x1b;

/// Protocol version.
pub const PROTOCOL_VERSION: &str = "0.1.0";
