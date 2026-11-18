/**
 * Tool policy: assumptions owned by this tool, NOT taken from HCL documentation.
 * HCL-sourced figures live in hclGuidance.ts. Every value here is documented in
 * docs/SPEC.md §6 so it can be reviewed and changed deliberately.
 */
import type { CapacityProfile } from "./types";

// ---------------------------------------------------------------------------
// Availability → replica floor
// ---------------------------------------------------------------------------

export interface AvailabilityPolicy {
  /** Minimum replicas for scalable components */
  minReplicas: number;
  /** Spare replicas added on top of load-driven count (N+spare) */
  spare: number;
  /** Whether profile HA floor and AZ count apply (production-grade) */
  production: boolean;
}

/** Selectable targets, lowest to highest. */
export const AVAILABILITY_TARGETS = ["99%", "99.5%", "99.9%", "99.95%", "99.99%"] as const;

/**
 * Replica floor per availability target.
 * - below 99.9%: lab / non-prod — a single replica is allowed
 * - 99.9%: at least 2 replicas, spread across AZs
 * - 99.95%: N+1 on top of load
 * - 99.99%: at least 3 replicas, N+1
 * Unknown strings fall back to the 99.9% policy.
 */
export function availabilityPolicy(target: string): AvailabilityPolicy {
  const pct = Number.parseFloat(target);
  if (!Number.isFinite(pct)) return { minReplicas: 2, spare: 0, production: true };
  if (pct < 99.9) return { minReplicas: 1, spare: 0, production: false };
  if (pct < 99.95) return { minReplicas: 2, spare: 0, production: true };
  if (pct < 99.99) return { minReplicas: 2, spare: 1, production: true };
  return { minReplicas: 3, spare: 1, production: true };
}

// ---------------------------------------------------------------------------
// Uncertainty on capacity constants
// ---------------------------------------------------------------------------

/**
 * Log-normal spread (σ) on rpsPerReplica. Default profiles are guesses;
 * lab-calibrated profiles are measured. p90 util = util × e^(z90·σ).
 */
export const CAPACITY_SIGMA: Record<CapacityProfile["confidence"], number> = {
  default: 0.25,
  "lab-calibrated": 0.1,
};

const Z90 = 1.2816;

export function utilP90(util: number, confidence: CapacityProfile["confidence"]): number {
  return util * Math.exp(Z90 * CAPACITY_SIGMA[confidence]);
}

// ---------------------------------------------------------------------------
// Queueing (M/M/c) for the latency check
// ---------------------------------------------------------------------------

/**
 * Erlang C: probability an arriving request waits, for c servers and offered
 * load a = λ/μ (in erlangs). Returns 1 when the system is saturated (a ≥ c).
 */
export function erlangC(c: number, a: number): number {
  if (c <= 0) return 1;
  if (a <= 0) return 0;
  if (a >= c) return 1;
  // Erlang B by recurrence (numerically stable), then convert to C.
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  const rho = a / c;
  return b / (1 - rho * (1 - b));
}

/**
 * Mean response-time inflation vs. an unloaded system: R/S = 1 + C(c,a)/(c − a).
 * Applied to a measured low-load p95 as an approximation of p95 at peak.
 * Infinity when saturated.
 */
export function latencyInflation(c: number, a: number): number {
  if (a >= c) return Number.POSITIVE_INFINITY;
  return 1 + erlangC(c, a) / (c - a);
}

/** Upper bound on replicas the latency search will try before giving up. */
export const MAX_LATENCY_REPLICAS = 200;
