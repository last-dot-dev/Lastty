export default function PaneFooter({
  worktreeLabel,
  isolated,
}: {
  worktreeLabel: string | null;
  isolated: boolean;
}) {
  return (
    <div className="agent-pane-footer">
      <span
        className="agent-pane-footer__worktree"
        title="this pane's worktree (locked after launch)"
      >
        {worktreeLabel ?? "no worktree"}
      </span>
      {isolated && <span className="agent-pane-footer__tag">isolated</span>}
    </div>
  );
}
