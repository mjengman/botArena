export const FRACTIONAL_SHARE_DECIMALS = 9;
export const FRACTIONAL_SHARE_FACTOR = 10 ** FRACTIONAL_SHARE_DECIMALS;

export function floorFractionalShares(quantity: number): number {
  return Math.floor(quantity * FRACTIONAL_SHARE_FACTOR) / FRACTIONAL_SHARE_FACTOR;
}
