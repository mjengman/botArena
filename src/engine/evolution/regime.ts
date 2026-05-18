/**
 * M14 Slice 4A — Market regime labelling.
 *
 * computeRegimeLabel() classifies a price window as Uptrend / Sideways / Downtrend
 * based on the first→last close slope. Threshold: ±3% change (exclusive).
 *
 * Regime labels are post-hoc and read-only — strategies never see them during
 * simulation. They are attached to season windows as explanatory context only,
 * to help users understand what market environment each window represents.
 *
 * Invariants:
 *   - slope  >  0.03  → "Uptrend"
 *   - slope  < −0.03  → "Downtrend"
 *   - otherwise        → "Sideways"  (including ±3% exactly)
 *   - invalid/zero first close → "Sideways" fallback
 */

import type { Dataset } from "../types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RegimeLabel = "Uptrend" | "Sideways" | "Downtrend";

// ─── computeRegimeLabel ───────────────────────────────────────────────────────

/**
 * Classify a price window by its first→last close slope.
 *
 * @param dataset  - Full dataset (candles indexed by absolute position).
 * @param startIdx - Inclusive start candle index (absolute, into dataset.candles).
 * @param endIdx   - Inclusive end candle index (absolute, into dataset.candles).
 * @returns "Uptrend"   if slope > +3%
 *          "Downtrend" if slope < −3%
 *          "Sideways"  otherwise (including the ±3% boundary values)
 *
 * Falls back to "Sideways" for missing or zero/negative first-close values.
 */
export function computeRegimeLabel(
  dataset: Dataset,
  startIdx: number,
  endIdx: number,
): RegimeLabel {
  const first = dataset.candles[startIdx]?.close;
  const last = dataset.candles[endIdx]?.close;
  if (first == null || last == null || first <= 0) return "Sideways";
  const slope = (last - first) / first;
  if (slope > 0.03) return "Uptrend";
  if (slope < -0.03) return "Downtrend";
  return "Sideways";
}
