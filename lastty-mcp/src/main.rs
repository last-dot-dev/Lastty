mod cli;
mod mcp;
mod socket;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let stdio_mode = args.is_empty() || (args.len() == 1 && args[0] == "--stdio");
    if stdio_mode {
        mcp::run();
    } else {
        cli::run(&args);
    }
}
