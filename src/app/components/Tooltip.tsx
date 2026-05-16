/**
 * Inline help tooltip — a small "?" badge that shows explanatory text on hover.
 * Use next to label text for confusing UI concepts.
 */

import { useRef, useState } from "react";
import type { CSSProperties } from "react";

interface TooltipProps {
  text: string;
}

interface TooltipPosition {
  top: number;
  left: number;
  placement: "above" | "below";
}

const TOOLTIP_WIDTH = 240;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_GAP = 8;

export function Tooltip({ text }: TooltipProps) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  function showTooltip() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const maxLeft = window.innerWidth - TOOLTIP_WIDTH - TOOLTIP_MARGIN;
    const centeredLeft = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    const left = Math.max(TOOLTIP_MARGIN, Math.min(centeredLeft, maxLeft));

    const shouldPlaceAbove = rect.bottom + 120 > window.innerHeight && rect.top > 120;
    const top = shouldPlaceAbove
      ? rect.top - TOOLTIP_GAP
      : rect.bottom + TOOLTIP_GAP;

    setPosition({
      top,
      left,
      placement: shouldPlaceAbove ? "above" : "below",
    });
  }

  const style = position
    ? ({
        "--tooltip-top": `${position.top}px`,
        "--tooltip-left": `${position.left}px`,
        "--tooltip-width": `${TOOLTIP_WIDTH}px`,
      } as CSSProperties)
    : undefined;

  return (
    <span
      className="tooltip-wrap"
      onMouseEnter={showTooltip}
      onMouseLeave={() => setPosition(null)}
      onFocus={showTooltip}
      onBlur={() => setPosition(null)}
    >
      <span ref={triggerRef} className="tooltip-trigger" tabIndex={0}>?</span>
      {position && (
        <span
          className={`tooltip-body tooltip-body--${position.placement}`}
          style={style}
        >
          {text}
        </span>
      )}
    </span>
  );
}
