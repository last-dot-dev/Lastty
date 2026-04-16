"""Pane agent SDK for Python.

Convenience wrapper for emitting OSC 7770 agent UI messages.

Usage:
    from pane_sdk import emit
    emit("Ready", agent="my-agent", version="1.0")
    emit("Status", phase="thinking")
    emit("Progress", pct=50, message="Halfway there")
    emit("Finished", summary="Done!", exit_code=0)
"""

import json
import sys


def emit(msg_type: str, **data) -> None:
    """Emit an agent UI message via OSC 7770.

    Args:
        msg_type: The message type (e.g. "Ready", "Status", "Progress").
        **data: Message data fields.
    """
    payload = json.dumps({"type": msg_type, "data": data})
    sys.stdout.write(f"\x1b]7770;{payload}\x07")
    sys.stdout.flush()
