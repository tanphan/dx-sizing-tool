import type { ComponentToggles, Demand, Product, UsageInputs } from "./types";

export function normalizeInputs(
  raw: UsageInputs,
  toggles: ComponentToggles,
  product: Product = "dxcn",
): Demand {
  const growth = 1 + Math.max(0, raw.growthCagr);
  // Scale factor applied exactly once (previously applied twice to derived RPS).
  const scale = growth * raw.loadMultiplier;
  const sessionSec = Math.max(1, raw.sessionDurationMin * 60);

  // Peak users: as given, or — when only DAU is known — the average concurrency
  // (DAU × session length ÷ day) times a busy-hour factor (plan default 4×).
  const busyHour = raw.peakConcurrentUsers <= 0 && raw.dau > 0;
  const basePeakUsers = busyHour
    ? ((raw.dau * raw.sessionDurationMin) / (24 * 60)) * Math.max(1, raw.busyHourFactor)
    : Math.max(0, raw.peakConcurrentUsers);
  const uPeak = basePeakUsers * scale;

  // Pacing: seconds between requests per concurrent user.
  // thinkTimeSec > 0 → closed-loop VU model (Locust `wait_time`), conservative
  // because it ignores response time. Otherwise spread reqPerSession over the session.
  const sessionPacingSec = sessionSec / Math.max(1, raw.reqPerSession);
  const useThink = raw.thinkTimeSec > 0;
  const pacingSec = useThink ? raw.thinkTimeSec : sessionPacingSec;
  const derivedRps = uPeak / pacingSec;
  const overridden = raw.peakRpsOverride > 0;
  const frontDoorRps = overridden ? raw.peakRpsOverride * scale : derivedRps;

  // Split front door into page vs DAM asset requests. DAM assets are routed
  // HAProxy → DAM directly (/dx/api/dam/...), not through Core/webEngine,
  // and are cached separately from pages.
  const damOn = !!toggles.dam;
  const attachAssets = Math.max(0, raw.damAttachRate * raw.assetsPerPage);
  const damShare = !damOn
    ? 0
    : raw.damRequestShare > 0
      ? Math.min(0.95, raw.damRequestShare)
      : attachAssets / (1 + attachAssets);
  const damFrontDoorRps = frontDoorRps * damShare;
  const pageFrontDoorRps = frontDoorRps - damFrontDoorRps;

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const pageMiss = 1 - clamp01(raw.cacheHitRatio);
  const damMiss = 1 - clamp01(raw.damCacheHitRatio);
  const portalRps = pageFrontDoorRps * pageMiss;
  const damRps = damFrontDoorRps * damMiss;
  /** Origin RPS after CDN (hits WAF when production platform on) */
  const originRps = portalRps + damRps;

  const dbRps = portalRps * (0.35 + 0.25 * (raw.pctBrowse / 100));
  const searchOn = !!(toggles.remoteSearch || toggles.searchMiddleware);
  const searchRps = searchOn
    ? portalRps * raw.searchAttachRate * raw.searchesPerHit
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

  // Session memory: base session + auth token/subject overhead for the
  // authenticated share (LTPA / JWT). 0 overhead by default.
  const sessionBytesKbEff =
    raw.sessionBytesKb + Math.max(0, raw.authTokenKb) * authFrac;

  // Origin egress: monthly request volume × origin (cache-miss) share × response
  // size. Uses daily volume, not peak. CDN-served bytes are the CDN's egress and
  // are excluded. 0 unless response sizes are entered.
  const monthlyRequests = sessionsPerDay * 30 * Math.max(0, raw.reqPerSession);
  const originKbPerRequest =
    (1 - damShare) * pageMiss * Math.max(0, raw.avgPageKb) +
    damShare * damMiss * Math.max(0, raw.avgAssetKb);
  const egressGbMonth = (monthlyRequests * originKbPerRequest) / 1024 / 1024;

  const tokensPerMonth = iqEnabled
    ? sessionsPerDay *
      30 *
      raw.iqAttachRate *
      raw.iqMsgsPerSession *
      (raw.iqTokensIn + raw.iqTokensOut)
    : 0;

  return {
    frontDoorRps,
    pageFrontDoorRps,
    damFrontDoorRps,
    pacingSec,
    pacingSource: overridden ? "override" : useThink ? "thinkTime" : "session",
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
    peakUsersSource: busyHour ? "busyHour" : "input",
    damShare,
    sessionBytesKbEff,
    egressGbMonth,
    sessionsPerDay,
    damStorageGiMonth,
    searchIndexGi,
    rwxStorageGi,
    tokensPerMonth,
    iqEnabled,
  };
}
