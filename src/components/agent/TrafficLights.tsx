export interface TrafficLightActions {
  onClose: () => void;
  onMaximize: () => void;
  onInterrupt?: () => void;
  maximized: boolean;
  interruptDisabled?: boolean;
}

export default function TrafficLights({
  onClose,
  onMaximize,
  onInterrupt,
  maximized,
  interruptDisabled = false,
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
        className="wd is-amber"
        onMouseDown={stopPropagation}
        onClick={(e) => {
          e.stopPropagation();
          if (interruptDisabled || !onInterrupt) return;
          onInterrupt();
        }}
        title="Interrupt current turn"
        aria-label="interrupt"
        disabled={!onInterrupt || interruptDisabled}
      >
        ‖
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
