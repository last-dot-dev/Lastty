import type { BusEvent, RuleDefinition, RuleFilter } from "../lib/ipc";

export function summarizeRuleTrigger(rule: RuleDefinition): string {
  const base = rule.trigger.event;
  const filters = summarizeRuleFilter(rule.trigger.filter);
  return filters ? `${base} · ${filters}` : base;
}

export function summarizeRuleAction(rule: RuleDefinition): string {
  const details = [
    rule.action.cwd ? `cwd ${rule.action.cwd}` : null,
    rule.action.isolate_in_worktree ? "isolated worktree" : null,
    rule.debounce_ms ? `${rule.debounce_ms}ms debounce` : null,
  ].filter(Boolean);

  if (details.length === 0) {
    return `launch ${rule.action.launch_agent}`;
  }

  return `launch ${rule.action.launch_agent} · ${details.join(" · ")}`;
}

export function summarizeRuleFilter(filter: RuleFilter): string {
  const parts = [
    filter.agent_id ? `agent=${filter.agent_id}` : null,
    filter.session_id ? `session=${filter.session_id}` : null,
    filter.phase ? `phase=${filter.phase}` : null,
    filter.tool ? `tool=${filter.tool}` : null,
    filter.path ? `path=${filter.path}` : null,
    filter.choice ? `choice=${filter.choice}` : null,
  ].filter(Boolean);

  return parts.join(", ");
}

export function recentRuleTriggerCounts(events: BusEvent[]): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    if (event.type !== "rule_triggered") {
      return counts;
    }
    counts[event.rule_name] = (counts[event.rule_name] ?? 0) + 1;
    return counts;
  }, {});
}
