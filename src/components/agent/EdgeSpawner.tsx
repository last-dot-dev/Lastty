export type SpawnDirection = "right" | "down";

export default function EdgeSpawner({
  onSpawn,
}: {
  onSpawn: (direction: SpawnDirection) => void;
}) {
  const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <>
      <div className="agent-edge-spawner is-right" aria-hidden>
        <button
          type="button"
          className="agent-edge-spawner__button"
          onMouseDown={stopPropagation}
          onClick={(e) => {
            e.stopPropagation();
            onSpawn("right");
          }}
          aria-label="spawn pane to the right"
          title="Spawn pane to the right"
        >
          +
        </button>
      </div>
      <div className="agent-edge-spawner is-bottom" aria-hidden>
        <button
          type="button"
          className="agent-edge-spawner__button"
          onMouseDown={stopPropagation}
          onClick={(e) => {
            e.stopPropagation();
            onSpawn("down");
          }}
          aria-label="spawn pane below"
          title="Spawn pane below"
        >
          +
        </button>
      </div>
    </>
  );
}
