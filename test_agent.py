import time, sys
sys.path.insert(0, "sdk")
from pane_sdk import emit

emit("Ready", agent="test-agent", version="0.1")
time.sleep(1)
emit("Status", phase="thinking", detail="reading files")
time.sleep(1)
emit("Progress", pct=50, message="halfway there")
print("some normal terminal output")
time.sleep(1)
emit("ToolCall", id="t1", name="read_file", args={"path": "src/main.rs"})
time.sleep(1)
emit("ToolResult", id="t1", result="file contents here", error=None)
emit("Progress", pct=100, message="done")
emit("Finished", summary="All tasks complete", exit_code=0)
