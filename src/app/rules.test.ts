import { describe, expect, it } from "vitest";

import type { BusEvent, RuleDefinition } from "../lib/ipc";
import {
  recentRuleTriggerCounts,
  summarizeRuleAction,
  summarizeRuleFilter,
  summarizeRuleTrigger,
} from "./rules";

describe("rule summaries", () => {
  const rule: RuleDefinition = {
    name: "follow-up-review",
    trigger: {
      event: "agent_finished",
      filter: {
        agent_id: "codex",
        phase: null,
        tool: null,
        path: null,
        choice: null,
        session_id: null,
      },
    },
    action: {
      launch_agent: "claude",
      prompt: "Review {{summary}}",
      cwd: "{{session_id}}",
      isolate_in_worktree: true,
      branch_name: "follow-up",
    },
    debounce_ms: 2_500,
  };

  it("summarizes triggers with filters", () => {
    expect(summarizeRuleTrigger(rule)).toBe("agent_finished · agent=codex");
    expect(summarizeRuleFilter(rule.trigger.filter)).toBe("agent=codex");
  });

  it("summarizes actions with orchestration details", () => {
    expect(summarizeRuleAction(rule)).toBe(
      "launch claude · cwd {{session_id}} · isolated worktree · 2500ms debounce",
    );
  });

  it("counts recent trigger events per rule name", () => {
    const events: BusEvent[] = [
      {
        type: "rule_triggered",
        session_id: "session-a",
        rule_name: "follow-up-review",
        launched_session_id: "session-b",
        launched_agent_id: "claude",
      },
      {
        type: "rule_triggered",
        session_id: "session-a",
        rule_name: "follow-up-review",
        launched_session_id: "session-c",
        launched_agent_id: "claude",
      },
      {
        type: "agent_finished",
        session_id: "session-a",
        agent_id: "codex",
        summary: "done",
        exit_code: 0,
      },
    ];

    expect(recentRuleTriggerCounts(events)).toEqual({ "follow-up-review": 2 });
  });
});
