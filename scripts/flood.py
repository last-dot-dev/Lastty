#!/usr/bin/env python3
"""Flood the terminal with output to stress the renderer.

Modes control what kind of pressure the renderer sees:
  truecolor  (default) random 24-bit fg per glyph — maximum atlas keyspace
  palette    8-color SGR per glyph — moderate keyspace
  plain      no SGR — baseline, measures raw write throughput

Examples:
  ./scripts/flood.py
  ./scripts/flood.py --rate 200 --duration 30
  ./scripts/flood.py --mode plain --glyphs boxes
"""

import argparse
import random
import shutil
import string
import sys
import time

GLYPHS = {
    "ascii": string.ascii_letters + string.digits + string.punctuation,
    "boxes": "─│┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝╠╣╦╩╬█▀▄▌▐░▒▓",
    "mixed": string.ascii_letters + string.digits + "─│┌┐└┘├┤┬┴┼╭╮╯╰█▀▄░▒▓●○◆◇★☆",
}


def cell_truecolor(ch: str) -> str:
    r, g, b = random.randint(30, 255), random.randint(30, 255), random.randint(30, 255)
    return f"\x1b[38;2;{r};{g};{b}m{ch}"


def cell_palette(ch: str) -> str:
    return f"\x1b[3{random.randint(1, 7)}m{ch}"


def cell_plain(ch: str) -> str:
    return ch


MODES = {"truecolor": cell_truecolor, "palette": cell_palette, "plain": cell_plain}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rate", type=float, default=0, help="lines per second (0 = unbounded)")
    ap.add_argument("--duration", type=float, default=0, help="seconds to run (0 = forever, Ctrl+C to stop)")
    ap.add_argument("--mode", choices=MODES, default="truecolor")
    ap.add_argument("--glyphs", choices=GLYPHS, default="mixed")
    ap.add_argument("--cols", type=int, default=0, help="columns per line (0 = detect from terminal)")
    args = ap.parse_args()

    cols = args.cols or shutil.get_terminal_size().columns
    glyphs = GLYPHS[args.glyphs]
    render_cell = MODES[args.mode]
    sleep_per_line = 1.0 / args.rate if args.rate > 0 else 0.0
    deadline = time.monotonic() + args.duration if args.duration > 0 else None

    out = sys.stdout.write
    flush = sys.stdout.flush
    choose = random.choice
    lines = 0
    start = time.monotonic()
    try:
        while True:
            if deadline is not None and time.monotonic() >= deadline:
                break
            parts = [render_cell(choose(glyphs)) for _ in range(cols)]
            parts.append("\x1b[0m\n")
            out("".join(parts))
            lines += 1
            if lines % 200 == 0:
                flush()
            if sleep_per_line:
                time.sleep(sleep_per_line)
    except (KeyboardInterrupt, BrokenPipeError):
        pass
    finally:
        try:
            flush()
        except BrokenPipeError:
            pass
        elapsed = max(time.monotonic() - start, 1e-6)
        sys.stderr.write(f"\n[flood] {lines} lines in {elapsed:.2f}s ({lines / elapsed:.0f} lps)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
