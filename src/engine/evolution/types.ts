/**
 * Core types for the M14 Parameter Evolution Sandbox.
 *
 * Design constraints (M14 scope):
 *  - number and boolean params are mutable within declared bounds.
 *  - string params are NOT mutated — copied verbatim from parent to child.
 *  - capital is NOT evolvable — set externally by the season runner or user.
 *  - Cross-param constraints (e.g. mac shortPeriod < longPeriod) are deferred
 *    to a future validation slice.
 */

// ─── Param Bound Entries ──────────────────────────────────────────────────────

export type ParamBoundEntry =
  | { type: "number"; min: number; max: number; step?: number }
  | { type: "boolean" }
  | { type: "string" }; // not mutated in M14 — copied verbatim

/**
 * Declares the mutable parameter space for one archetype.
 * Keys must match the param keys used in the strategy's defaultParams
 * and in botRegistry.ts paramDefs.
 */
export type ArchetypeParamBounds = Record<string, ParamBoundEntry>;

// ─── Evolvable Bot Spec ───────────────────────────────────────────────────────

export type EvolvableBotSpec = {
  /** Deterministic: derived from parentId + generation + seed. */
  id: string;
  name: string;
  /** Matches a key in ARCHETYPE_BOUNDS — e.g. "mac", "mom", "mr", "rnd", "bah". */
  archetype: string;
  /**
   * All params for this bot. Types may be number, boolean, or string.
   * Only number and boolean params with declared bounds are mutated in M14.
   * String params are metadata/categorical values and are copied verbatim.
   */
  params: Record<string, number | boolean | string>;
  generation: number;
  parentIds: string[];
  /**
   * Probability [0, 1] that any individual mutable param is perturbed during
   * one mutation pass. mutationRate=0 produces a perfect clone (generation+1,
   * no param changes). mutationRate=1 mutates every eligible param.
   */
  mutationRate: number;
  /** Not evolvable — copied verbatim from parent. Set externally. */
  capital: number;
  metadata: {
    lineageId: string;
    /** ISO 8601 wall-clock timestamp of when this spec was generated. Not deterministic. */
    createdAt: string;
    /** Comma-separated list of param keys that changed during this mutation. */
    mutationSummary?: string;
    /**
     * Per-generation annotations set externally after mutation.
     * NOT inherited from parent — mutateSpec always sets this to undefined.
     * Carry ancestry through parentIds/lineageId, not notes.
     */
    notes?: string;
  };
};

// ─── Validation Result ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}
