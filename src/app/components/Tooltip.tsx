/**
 * Inline help tooltip — a small "?" badge that shows explanatory text on hover.
 * Use next to label text for confusing UI concepts.
 */

interface TooltipProps {
  text: string;
}

export function Tooltip({ text }: TooltipProps) {
  return (
    <span className="tooltip-wrap">
      <span className="tooltip-trigger">?</span>
      <span className="tooltip-body">{text}</span>
    </span>
  );
}
