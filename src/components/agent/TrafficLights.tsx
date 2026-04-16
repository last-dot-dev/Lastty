export interface TrafficLightActions {
  onClose: () => void;
  onMaximize: () => void;
  maximized: boolean;
}

export default function TrafficLights({
  onClose,
  onMaximize,
  maximized,
}: TrafficLightActions) {
  const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <span
      className="agent-traffic-lights"
      aria-label="window controls"
      onMouseDown={stopPropagation}
    >
      <button
        type="button"
        className="wd is-red"
        onMouseDown={stopPropagation}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close (kill session)"
        aria-label="close"
      >
        ✕
      </button>
      <button
        type="button"
        className="wd is-green"
        onMouseDown={stopPropagation}
        onClick={(e) => {
          e.stopPropagation();
          onMaximize();
        }}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "restore" : "maximize"}
      >
        {maximized ? "⤓" : "⤢"}
      </button>
    </span>
  );
}
