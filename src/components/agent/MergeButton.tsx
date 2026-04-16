export default function MergeButton({ doneCount }: { doneCount: number }) {
  return (
    <button
      type="button"
      className="agent-merge-button"
      disabled
      title="Merge flow requires a backend command that isn't implemented yet"
    >
      <span>Merge done branches</span>
      <span
        className={`agent-merge-button__count ${doneCount === 0 ? "is-zero" : ""}`}
      >
        {doneCount}
      </span>
    </button>
  );
}
