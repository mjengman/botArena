import type { Speed } from "../constants.ts";

interface ControlsProps {
  isPlaying: boolean;
  isComplete: boolean;
  speed: Speed;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
  onSpeedChange: (s: Speed) => void;
}

const SPEEDS: Speed[] = ["1x", "4x", "16x", "max"];

export function Controls({
  isPlaying,
  isComplete,
  speed,
  onPlay,
  onPause,
  onStep,
  onReset,
  onSpeedChange,
}: ControlsProps) {
  return (
    <div className="controls">
      <button
        className="ctrl-btn"
        onClick={onStep}
        disabled={isPlaying || isComplete}
        title="Step one candle"
      >
        ›
      </button>

      {isPlaying ? (
        <button className="ctrl-btn ctrl-btn--primary" onClick={onPause} title="Pause">
          ⏸
        </button>
      ) : (
        <button
          className="ctrl-btn ctrl-btn--primary"
          onClick={onPlay}
          disabled={isComplete}
          title={speed === "max" ? "Run to end instantly" : "Play"}
        >
          {speed === "max" ? "⚡" : "▶"}
        </button>
      )}

      <button className="ctrl-btn" onClick={onReset} title="Reset">
        ↺
      </button>

      <div className="speed-group">
        {SPEEDS.map((s) => (
          <button
            key={s}
            className={`speed-btn ${speed === s ? "speed-btn--active" : ""}`}
            onClick={() => onSpeedChange(s)}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
