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
}

export interface UnitCosts {
  vcpuPerHour: number;
  memGiBPerHour: number;
  storageGiBPerMonth: number;
  egressGb: number;
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
  util: number;
  utilBand: "green" | "amber" | "red" | "n/a";
  replicas: number;
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
