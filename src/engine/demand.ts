import type { ComponentToggles, Demand, Product, UsageInputs } from "./types";

export function normalizeInputs(
  raw: UsageInputs,
  toggles: ComponentToggles,
  product: Product = "dxcn",
): Demand {
  const growth = 1 + Math.max(0, raw.growthCagr);
  const uPeak = raw.peakConcurrentUsers * growth * raw.loadMultiplier;
  const sessionSec = Math.max(1, raw.sessionDurationMin * 60);
  const derivedRps = (uPeak * raw.reqPerSession) / sessionSec;
  const frontDoorRps =
    (raw.peakRpsOverride > 0 ? raw.peakRpsOverride : derivedRps) *
    raw.loadMultiplier *
    growth;

  const miss = Math.max(0, Math.min(1, 1 - raw.cacheHitRatio));
  /** Origin RPS after CDN (hits WAF when production platform on) */
  const originRps = frontDoorRps * miss;
  const portalRps = originRps;
  const dbRps = portalRps * (0.35 + 0.25 * (raw.pctBrowse / 100));
  const searchOn = !!(toggles.remoteSearch || toggles.searchMiddleware);
  const searchRps = searchOn
    ? portalRps * raw.searchAttachRate * raw.searchesPerHit
    : 0;
  const damOn = !!toggles.dam;
  const damRps = damOn
    ? portalRps * raw.damAttachRate * raw.assetsPerPage
    : 0;
  const imageRps = damOn ? damRps * 0.2 : 0;
  const persistRps = damOn ? damRps : 0;
  const authFrac = raw.pctAuthenticated / 100;
  const authRps =
    toggles.openLdap || toggles.externalIdp
      ? portalRps * authFrac * 0.15
      : 0;
  const authorRps = toggles.contentComposer
    ? Math.max(
        portalRps * (raw.pctAuthor / 100),
        raw.peakAuthoringUsers * 0.5,
      )
    : 0;
  const ringRps = toggles.ringApi ? damRps * 0.3 + authorRps * 0.5 : 0;
  const iqEnabled = !!toggles.iqIntegrator;
  const iqRps = iqEnabled
    ? (uPeak * raw.iqAttachRate * raw.iqMsgsPerSession) / sessionSec
    : 0;

  const sessionsPerDay =
    raw.dau > 0
      ? raw.dau * growth
      : (uPeak * (24 * 60)) / Math.max(1, raw.sessionDurationMin);

  const damStorageGiMonth = damOn
    ? (raw.uploadsPerDay * raw.avgUploadMb * 30 * raw.damRetentionFactor) /
      1024
    : 0;

  const searchIndexGi = searchOn
    ? Math.max(5, (raw.contentItems / 1000) * 0.8)
    : 0;

  // RWX: DXCN Core shared FS base + DAM file share when DAM on. Compose/webEngine: DAM-only.
  let rwxStorageGi = 0;
  if (product === "dxcn") {
    rwxStorageGi = Math.max(100, (raw.contentItems / 1000) * 2 + 50);
  }
  if (damOn) {
    rwxStorageGi += Math.max(50, damStorageGiMonth * 0.5 + 20);
  }

  const tokensPerMonth = iqEnabled
    ? sessionsPerDay *
      30 *
      raw.iqAttachRate *
      raw.iqMsgsPerSession *
      (raw.iqTokensIn + raw.iqTokensOut)
    : 0;

  return {
    frontDoorRps,
    portalRps,
    originRps,
    dbRps,
    searchRps,
    damRps,
    imageRps,
    persistRps,
    authRps,
    iqRps,
    authorRps,
    ringRps,
    concurrentSessions: uPeak,
    sessionsPerDay,
    damStorageGiMonth,
    searchIndexGi,
    rwxStorageGi,
    tokensPerMonth,
    iqEnabled,
  };
}
