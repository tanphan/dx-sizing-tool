export type Product = "dxcn" | "compose";

export type ComponentPlane = "hcl" | "platform" | "client";

export type ComponentId =
  | "users"
  | "cdn"
  | "haproxy"
  | "core"
  | "webEngine"
  | "loggingSidecar"
  | "runtimeController"
  | "prereqsChecker"
  | "openLdap"
  | "externalIdp"
  | "externalDb"
  | "remoteSearch"
  | "contentComposer"
  | "ringApi"
  | "dam"
  | "imageProcessor"
  | "persistenceNode"
  | "persistencePool"
  | "persistenceMetrics"
  | "damPluginGoogleVision"
  | "damPluginKaltura"
  | "searchMiddleware"
  | "openSearch"
  | "fileProcessor"
  | "licenseManager"
  | "peopleService"
  | "iqIntegrator"
  | "mcpService"
  | "dnsGslb"
  | "waf"
  | "cloudLb"
  | "dxDbSecondary"
  | "rwxStorage"
  | "objectStorage"
  | "redis"
  | "secretsKms"
  | "observability"
  | "backupDr"
  | "containerRegistry"
  | "egressNat";

export type ComponentToggleKey = Exclude<
  ComponentId,
  | "users"
  | "cdn"
  | "haproxy"
  | "core"
  | "webEngine"
  | "loggingSidecar"
  | "runtimeController"
  | "prereqsChecker"
  | "externalDb"
>;

export interface UsageInputs {
  peakConcurrentUsers: number;
  dau: number;
  mau: number;
  /** If > 0, overrides derived front-door RPS */
  peakRpsOverride: number;
  reqPerSession: number;
  sessionDurationMin: number;
  thinkTimeSec: number;
  pctAnonymous: number;
  pctAuthenticated: number;
  pctBrowse: number;
  pctAuthor: number;
  pctFormPost: number;
  searchAttachRate: number;
  searchesPerHit: number;
  damAttachRate: number;
  assetsPerPage: number;
  peakAuthoringUsers: number;
  uploadsPerDay: number;
  avgUploadMb: number;
  damRetentionFactor: number;
  contentItems: number;
  /** Page/portal cache hit ratio at CDN (0–1) */
  cacheHitRatio: number;
  /**
   * Fraction of front-door requests that are DAM asset requests (0–1).
   * 0 = derive from damAttachRate × assetsPerPage. HCL rendering mix uses 0.3.
   */
  damRequestShare: number;
  /** DAM asset cache hit ratio at CDN / DAM proxy (0–1); assets cache far better than pages */
  damCacheHitRatio: number;
  iqAttachRate: number;
  iqMsgsPerSession: number;
  iqTokensIn: number;
  iqTokensOut: number;
  azCount: number;
  targetAvailability: string;
  targetP95Ms: number;
  growthCagr: number;
  loadMultiplier: number;
  sessionBytesKb: number;
  /** Include cloud-native platform plane (WAF, LB, DB HA, …) */
  productionPlatform: boolean;

  // --- Headroom targets (plan defaults: CPU 0.6, memory 0.7, disk 0.7) ---
  /** Size scalable replicas so utilization at peak ≤ this (0–1) */
  targetCpuUtil: number;
  /** Provision memory so working set ≤ this share (non Core/webEngine) */
  targetMemUtil: number;
  /** Provision demand-driven storage so it is ≤ this share full */
  targetDiskUtil: number;

  /** Peak ÷ average multiplier used when only DAU is given (peak users = 0) */
  busyHourFactor: number;
  /** Measured Core/webEngine page p95 at low load (ms). 0 = latency check off */
  baselineP95Ms: number;
  /** Avg origin response size for pages (KB). 0 = egress not estimated */
  avgPageKb: number;
  /** Avg origin response size for DAM assets (KB). 0 = egress not estimated */
  avgAssetKb: number;
  /** Extra per-session memory for authenticated users (LTPA/JWT subject, KB) */
  authTokenKb: number;
}

/** Internet egress price tier: GB up to `upToGb` (null = unbounded) at `price` $/GB */
export interface EgressTier {
  upToGb: number | null;
  price: number;
}

export interface UnitCosts {
  vcpuPerHour: number;
  memGiBPerHour: number;
  storageGiBPerMonth: number;
  /** Flat $/GB, used when no tiers are set */
  egressGb: number;
  /** Tiered egress from the price book (list prices only) */
  egressTiers?: EgressTier[];
  /** Savings plan / reserved / committed-use discount on cloud spend, % (0–99) */
  cloudDiscountPct: number;
  /** Enterprise agreement discount (EDP, MACC, …) applied on top, % (0–99) */
  enterpriseDiscountPct: number;
  tokensPer1k: number;
  dxLicensePerNodeMonth: number;
  selfHostLlmRamGiB: number;
  selfHostLlmRamGiBHour: number;
}

export interface ComponentProfile {
  id: ComponentId;
  label: string;
  rpsPerReplica: number;
  cpuBase: number;
  cpuPerRps: number;
  memBaseGi: number;
  memPerSessionMi: number;
  memPerRpsMi: number;
  storageBaseGi: number;
  minReplicas: number;
  haMinReplicas: number;
  scalable: boolean;
  fixed: boolean;
  licenseNode: boolean;
}

export interface CapacityProfile {
  id: string;
  product: Product;
  cfTag: string;
  confidence: "default" | "lab-calibrated";
  components: Record<string, ComponentProfile>;
}

export interface TopologyEdge {
  id: string;
  source: ComponentId;
  target: ComponentId;
  /** Fraction of source offered RPS that fans out to target */
  ratioKey:
    | "portal"
    | "db"
    | "search"
    | "dam"
    | "image"
    | "persist"
    | "auth"
    | "iq"
    | "author"
    | "ring"
    | "cdn_miss"
    | "fixed";
  label: string;
}

export interface TopologyNode {
  id: ComponentId;
  label: string;
  always: boolean;
  optionalKey?: ComponentToggleKey;
  /** Visual / BOM grouping: HCL DX vs cloud platform vs client */
  plane: ComponentPlane;
}

export interface ProductCatalog {
  product: Product;
  label: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export type ComponentToggles = Partial<Record<ComponentToggleKey, boolean>>;

export interface Demand {
  frontDoorRps: number;
  /** Front-door requests that are pages/portal (pre-cache) */
  pageFrontDoorRps: number;
  /** Front-door requests that are DAM assets (pre-cache) */
  damFrontDoorRps: number;
  /** Seconds between requests per concurrent user actually used */
  pacingSec: number;
  pacingSource: "thinkTime" | "session" | "override";
  /** Page/portal origin RPS (after cache) → HAProxy → Core/webEngine */
  portalRps: number;
  originRps: number;
  dbRps: number;
  searchRps: number;
  damRps: number;
  imageRps: number;
  persistRps: number;
  authRps: number;
  iqRps: number;
  authorRps: number;
  ringRps: number;
  concurrentSessions: number;
  /** "input" = peak users given; "busyHour" = derived from DAU × busy-hour factor */
  peakUsersSource: "input" | "busyHour";
  /** Share of front-door requests that are DAM assets */
  damShare: number;
  /** Session bytes incl. auth token overhead weighted by % authenticated */
  sessionBytesKbEff: number;
  /** Origin → internet egress per month (GB); 0 when response sizes not set */
  egressGbMonth: number;
  sessionsPerDay: number;
  damStorageGiMonth: number;
  searchIndexGi: number;
  rwxStorageGi: number;
  tokensPerMonth: number;
  iqEnabled: boolean;
}

export interface SizedNode {
  id: ComponentId;
  label: string;
  plane: ComponentPlane;
  offeredRps: number;
  capacityRps: number;
  /** p50 utilization (point estimate) */
  util: number;
  /** p90 utilization given profile uncertainty (default vs lab-calibrated) */
  utilP90: number;
  utilBand: "green" | "amber" | "red" | "n/a";
  replicas: number;
  /** Replicas the engine recommends (differs from `replicas` when overridden) */
  recommendedReplicas: number;
  /** Lowest replica count the HA / availability policy allows */
  minSafeReplicas: number;
  /** Whether the UI may add/remove replicas for this component */
  scalable: boolean;
  /** Estimated page p95 at peak (Core/webEngine, when baseline p95 is set) */
  p95Ms?: number;
  cpuCores: number;
  memGi: number;
  storageGi: number;
  infraCostMonth: number;
  licenseCostMonth: number;
  notes: string[];
}

export interface SessionSummary {
  concurrentSessions: number;
  sessionsPerDay: number;
  sessionFootprintMi: number;
  recommendedTimeoutMin: number;
  stickySessions: boolean;
  jvmHeapGi?: number;
  podMemoryGi?: number;
  podCpu?: number;
}

export interface CostTotals {
  infraMonth: number;
  platformMonth: number;
  hclRuntimeMonth: number;
  licenseMonth: number;
  tokenMonth: number;
  llmInfraMonth: number;
  egressMonth: number;
  egressGbMonth: number;
  /** Cloud spend (infra + egress) at list price, before discounts */
  cloudListMonth: number;
  /** Discount taken off cloud spend (list − net) */
  cloudDiscountMonth: number;
  /** (1 − cloud%) × (1 − enterprise%) */
  discountFactor: number;
  totalMonth: number;
  vcpuHours: number;
  memGiBHours: number;
  storageGi: number;
  tokens: number;
}

export interface SizingResult {
  product: Product;
  profileId: string;
  confidence: "default" | "lab-calibrated";
  cloudProvider?: string;
  /** Where unit prices came from (snapshot list prices, custom, placeholder) */
  priceSource: import("./pricing").PriceSource;
  demand: Demand;
  nodes: SizedNode[];
  edges: Array<TopologyEdge & { rps: number }>;
  sessions: SessionSummary;
  costs: CostTotals;
  warnings: string[];
  helmHints: HelmHints;
  hclDocUrl: string;
}

export interface HelmResources {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

/**
 * Hints keyed by hcl-dx-deployment chart names (CF233/CF237 values.yaml):
 * `scaling.replicas.<name>` and `resources.<name>`.
 */
export interface HelmHints {
  /** → scaling.replicas.<chartName> (only names the chart accepts there) */
  scaling: Record<string, number>;
  /** → resources.<chartName> */
  resources: Record<string, HelmResources>;
  /** Components deployed by separate charts (Search V2, DX IQ, People Service) */
  otherCharts: Record<string, { replicas: number } & HelmResources>;
  notes: string[];
}

export interface LiveUtilRow {
  componentId: ComponentId;
  cpuCoresObserved: number;
  memGiObserved: number;
}
