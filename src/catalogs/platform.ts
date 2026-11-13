import type { TopologyEdge, TopologyNode } from "../engine/types";

/** Non-HCL platform / edge infrastructure (cloud-native prod). */
export const platformNodes: TopologyNode[] = [
  { id: "dnsGslb", label: "DNS / GSLB", always: false, optionalKey: "dnsGslb", plane: "platform" },
  { id: "waf", label: "WAF (origin)", always: false, optionalKey: "waf", plane: "platform" },
  { id: "cloudLb", label: "Cloud LB", always: false, optionalKey: "cloudLb", plane: "platform" },
  {
    id: "dxDbSecondary",
    label: "DX DB secondary",
    always: false,
    optionalKey: "dxDbSecondary",
    plane: "platform",
  },
  {
    id: "rwxStorage",
    label: "RWX storage",
    always: false,
    optionalKey: "rwxStorage",
    plane: "platform",
  },
  {
    id: "objectStorage",
    label: "Object storage",
    always: false,
    optionalKey: "objectStorage",
    plane: "platform",
  },
  { id: "redis", label: "Redis", always: false, optionalKey: "redis", plane: "platform" },
  {
    id: "secretsKms",
    label: "Secrets / KMS",
    always: false,
    optionalKey: "secretsKms",
    plane: "platform",
  },
  {
    id: "observability",
    label: "Observability",
    always: false,
    optionalKey: "observability",
    plane: "platform",
  },
  {
    id: "backupDr",
    label: "Backup / DR",
    always: false,
    optionalKey: "backupDr",
    plane: "platform",
  },
  {
    id: "containerRegistry",
    label: "Container registry",
    always: false,
    optionalKey: "containerRegistry",
    plane: "platform",
  },
  {
    id: "egressNat",
    label: "Egress / NAT",
    always: false,
    optionalKey: "egressNat",
    plane: "platform",
  },
];

/**
 * Origin WAF path: CDN miss → WAF → Cloud LB → HAProxy.
 * Lab path keeps cdn → haproxy (selectTopology filters).
 *
 * RWX:
 * - DXCN Core → RWX (Core requires shared FS)
 * - WebEngine does NOT mount RWX
 * - DAM → RWX when DAM is on (either product)
 */
export const platformEdges: TopologyEdge[] = [
  { id: "u-dns", source: "users", target: "dnsGslb", ratioKey: "fixed", label: "DNS" },
  { id: "dns-cdn", source: "dnsGslb", target: "cdn", ratioKey: "fixed", label: "resolve" },
  { id: "cdn-waf", source: "cdn", target: "waf", ratioKey: "cdn_miss", label: "origin miss" },
  { id: "waf-lb", source: "waf", target: "cloudLb", ratioKey: "fixed", label: "clean traffic" },
  { id: "lb-hap", source: "cloudLb", target: "haproxy", ratioKey: "fixed", label: "K8s ingress" },
  {
    id: "db-sec",
    source: "externalDb",
    target: "dxDbSecondary",
    ratioKey: "fixed",
    label: "HA sync",
  },
  {
    id: "core-rwx",
    source: "core",
    target: "rwxStorage",
    ratioKey: "fixed",
    label: "shared FS",
  },
  {
    id: "dam-rwx",
    source: "dam",
    target: "rwxStorage",
    ratioKey: "fixed",
    label: "DAM RWX",
  },
  {
    id: "dam-obj",
    source: "dam",
    target: "objectStorage",
    ratioKey: "fixed",
    label: "binaries",
  },
  {
    id: "core-redis",
    source: "core",
    target: "redis",
    ratioKey: "fixed",
    label: "session/cache",
  },
  {
    id: "we-redis",
    source: "webEngine",
    target: "redis",
    ratioKey: "fixed",
    label: "session/cache",
  },
];

export const productionPlatformDefaults = {
  dnsGslb: true,
  waf: true,
  cloudLb: true,
  dxDbSecondary: true,
  secretsKms: true,
  observability: true,
  backupDr: true,
  containerRegistry: true,
  egressNat: true,
  redis: false,
  rwxStorage: false,
  objectStorage: false,
} as const;
