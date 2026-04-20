export default function MergeButton({
  count,
  disabled,
  onClick,
}: {
  count: number;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="agent-merge-button"
      disabled={disabled}
      onClick={onClick}
      title={
        disabled
          ? "no worktrees to open PRs for"
          : "open the pull-request dialog"
      }
    >
      <span>Open pull requests</span>
      <span className={`agent-merge-button__count ${count === 0 ? "is-zero" : ""}`}>
        {count}
      </span>
    </button>
  );
}
