import type { UnitCosts, UsageInputs } from "./types";

export const defaultUsageInputs: UsageInputs = {
  peakConcurrentUsers: 5000,
  dau: 20000,
  mau: 200000,
  peakRpsOverride: 0,
  reqPerSession: 25,
  sessionDurationMin: 20,
  /** 0 = pace from reqPerSession / sessionDuration; > 0 = Locust-style VU pacing */
  thinkTimeSec: 0,
  pctAnonymous: 60,
  pctAuthenticated: 40,
  pctBrowse: 75,
  pctAuthor: 10,
  pctFormPost: 15,
  searchAttachRate: 0.4,
  searchesPerHit: 1.5,
  damAttachRate: 0.1,
  assetsPerPage: 3,
  peakAuthoringUsers: 20,
  uploadsPerDay: 50,
  avgUploadMb: 2,
  damRetentionFactor: 1.2,
  contentItems: 50000,
  cacheHitRatio: 0.4,
  damRequestShare: 0,
  damCacheHitRatio: 0.4,
  iqAttachRate: 0,
  iqMsgsPerSession: 4,
  iqTokensIn: 800,
  iqTokensOut: 400,
  azCount: 2,
  targetAvailability: "99.9%",
  targetP95Ms: 800,
  growthCagr: 0.15,
  loadMultiplier: 1,
  sessionBytesKb: 150,
  productionPlatform: false,
  // Headroom targets from the design plan (docs/SPEC.md §6)
  targetCpuUtil: 0.6,
  targetMemUtil: 0.7,
  targetDiskUtil: 0.7,
  busyHourFactor: 4,
  // Environment-specific measurements: 0 = feature off until you enter real values
  baselineP95Ms: 0,
  avgPageKb: 0,
  avgAssetKb: 0,
  authTokenKb: 0,
};

export const defaultUnitCosts: UnitCosts = {
  vcpuPerHour: 0.04,
  memGiBPerHour: 0.005,
  storageGiBPerMonth: 0.1,
  egressGb: 0.09,
  tokensPer1k: 0.002,
  dxLicensePerNodeMonth: 0,
  selfHostLlmRamGiB: 8,
  selfHostLlmRamGiBHour: 0.01,
};

export const HOURS_PER_MONTH = 730;
