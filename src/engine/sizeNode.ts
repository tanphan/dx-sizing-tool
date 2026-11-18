import { HOURS_PER_MONTH } from "./defaults";
import {
  HCL_CORE_POD,
  HCL_SIZING_DOC,
  SESSION_HEAP_FRACTION,
  SESSION_MEM_SAFETY,
} from "./hclGuidance";
import {
  availabilityPolicy,
  latencyInflation,
  MAX_LATENCY_REPLICAS,
  utilP90,
} from "./policy";
import type {
  CapacityProfile,
  ComponentId,
  ComponentPlane,
  ComponentProfile,
  Demand,
  SizedNode,
  TopologyEdge,
  UnitCosts,
  UsageInputs,
} from "./types";

function utilBand(util: number, fixed: boolean): SizedNode["utilBand"] {
  if (fixed || !Number.isFinite(util)) return "n/a";
  if (util < 0.7) return "green";
  if (util < 0.9) return "amber";
  return "red";
}

function offeredFor(id: ComponentId, demand: Demand): number {
  switch (id) {
    case "users":
    case "cdn":
    case "dnsGslb":
      return demand.frontDoorRps;
    case "waf":
    case "cloudLb":
      return demand.originRps + demand.iqRps;
    case "haproxy":
      // Pages + DAM assets (/dx/api/dam routed HAProxy → DAM) + IQ chat
      return demand.portalRps + demand.damRps + demand.iqRps;
    case "core":
    case "webEngine":
      return demand.portalRps;
    case "externalDb":
    case "dxDbSecondary":
      return demand.dbRps;
    case "remoteSearch":
    case "searchMiddleware":
    case "openSearch":
      return demand.searchRps;
    case "fileProcessor":
      return demand.searchRps * 0.1;
    case "dam":
      return demand.damRps;
    case "imageProcessor":
      return demand.imageRps;
    case "persistencePool":
    case "persistenceNode":
    case "persistenceMetrics":
      return demand.persistRps;
    case "contentComposer":
      return demand.authorRps;
    case "ringApi":
      return demand.ringRps;
    case "openLdap":
    case "externalIdp":
      return demand.authRps;
    case "iqIntegrator":
      return demand.iqRps;
    case "mcpService":
      return demand.iqRps * 0.6;
    case "damPluginGoogleVision":
    case "damPluginKaltura":
      return demand.damRps * 0.05;
    case "peopleService":
      return demand.portalRps * 0.05;
    case "rwxStorage":
    case "objectStorage":
    case "redis":
    case "secretsKms":
    case "observability":
    case "backupDr":
    case "containerRegistry":
    case "egressNat":
    case "loggingSidecar":
    case "runtimeController":
    case "prereqsChecker":
    case "licenseManager":
      return 0;
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

export interface SizeNodeOptions {
  /** Logging sidecar: one per Core/webEngine replica */
  sidecarOfReplicas?: number;
  /** Manual replica count from the Simulator (up or down); scalable nodes only */
  forcedReplicas?: number;
  /** Profile confidence, used for the p90 utilization range */
  confidence?: CapacityProfile["confidence"];
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : hi));

/** Estimated page p95 at peak for the portal runtime (M/M/c approximation). */
export function portalP95Ms(
  baselineP95Ms: number,
  replicas: number,
  offeredRps: number,
  rpsPerReplica: number,
): number {
  const erlangs = offeredRps / Math.max(1e-9, rpsPerReplica);
  return baselineP95Ms * latencyInflation(replicas, erlangs);
}

export function sizeNode(
  id: ComponentId,
  label: string,
  plane: ComponentPlane,
  demand: Demand,
  profile: ComponentProfile | undefined,
  costs: UnitCosts,
  inputs: UsageInputs,
  opts: SizeNodeOptions = {},
): SizedNode {
  const offered = offeredFor(id, demand);
  if (!profile) {
    return {
      id,
      label,
      plane,
      offeredRps: offered,
      capacityRps: 0,
      util: 0,
      utilP90: 0,
      utilBand: "n/a",
      replicas: 0,
      recommendedReplicas: 0,
      minSafeReplicas: 0,
      scalable: false,
      cpuCores: 0,
      memGi: 0,
      storageGi: 0,
      infraCostMonth: 0,
      licenseCostMonth: 0,
      notes: ["No capacity profile for this node"],
    };
  }

  const notes: string[] = [];
  const isPortal = id === "core" || id === "webEngine";
  const canScale = profile.scalable && !profile.fixed;
  const avail = availabilityPolicy(inputs.targetAvailability);
  const targetCpu = clamp(inputs.targetCpuUtil, 0.1, 1);
  const targetMem = clamp(inputs.targetMemUtil, 0.1, 1);
  const targetDisk = clamp(inputs.targetDiskUtil, 0.1, 1);

  // ---- 1. Recommended replicas -------------------------------------------
  let recommended: number;
  let minSafe: number;
  if (profile.fixed) {
    recommended =
      id === "prereqsChecker"
        ? 0
        : id === "loggingSidecar"
          ? Math.max(1, opts.sidecarOfReplicas ?? 1)
          : Math.max(profile.minReplicas, 1);
    minSafe = recommended;
    if (id === "prereqsChecker") notes.push("Job-only; ignored in steady-state cost");
    if (id === "dxDbSecondary") {
      notes.push("Failover / sync standby — sized ≈ primary storage, partial CPU");
    }
  } else if (!profile.scalable) {
    recommended = Math.max(profile.minReplicas, 1);
    minSafe = recommended;
  } else {
    // Size so peak util ≤ target (rpsPerReplica is capacity at 100% util).
    const loadRep =
      offered > 0
        ? Math.ceil(offered / Math.max(1e-9, profile.rpsPerReplica * targetCpu))
        : 0;
    const withSpare = loadRep > 0 ? loadRep + avail.spare : 0;
    minSafe = avail.production
      ? Math.max(profile.haMinReplicas, inputs.azCount, avail.minReplicas, profile.minReplicas)
      : Math.max(avail.minReplicas, profile.minReplicas);
    recommended = Math.max(withSpare, minSafe);
    if (withSpare < minSafe) {
      notes.push(`Availability floor applied (${inputs.targetAvailability}: ≥${minSafe})`);
    } else if (avail.spare > 0) {
      notes.push(`N+${avail.spare} spare for ${inputs.targetAvailability}`);
    }
    if (!avail.production) {
      notes.push("Non-production availability target: single replica allowed");
    }
  }

  // Portal runtime: fixed HCL pod; scale out for CPU budget, session heap, latency.
  const pod = HCL_CORE_POD;
  const sessionMemGi =
    (demand.concurrentSessions * demand.sessionBytesKbEff * SESSION_MEM_SAFETY) /
    1024 /
    1024;
  if (isPortal) {
    const cpuBudget = Math.max(0.1, pod.cpu * targetCpu - profile.cpuBase);
    const cpuRep = Math.ceil((profile.cpuPerRps * offered) / cpuBudget);
    const heapBudgetGi = pod.heapGi * SESSION_HEAP_FRACTION;
    const heapRep = Math.ceil(sessionMemGi / heapBudgetGi);
    let rec = Math.max(recommended, cpuRep, heapRep);
    if (rec > recommended) {
      notes.push(
        rec === heapRep
          ? `Scaled to ${rec}: session heap ${sessionMemGi.toFixed(1)}Gi > ${heapBudgetGi}Gi/pod budget`
          : `Scaled to ${rec}: CPU above ${Math.round(targetCpu * 100)}% of ${pod.cpu} CPU/pod`,
      );
    }
    if (inputs.baselineP95Ms > 0 && inputs.targetP95Ms > 0) {
      if (inputs.baselineP95Ms >= inputs.targetP95Ms) {
        notes.push(
          `Baseline p95 ${inputs.baselineP95Ms}ms already ≥ target ${inputs.targetP95Ms}ms — replicas cannot fix this`,
        );
      } else {
        let r = Math.max(1, rec);
        while (
          r < MAX_LATENCY_REPLICAS &&
          portalP95Ms(inputs.baselineP95Ms, r, offered, profile.rpsPerReplica) >
            inputs.targetP95Ms
        ) {
          r++;
        }
        if (r > rec) notes.push(`Scaled to ${r}: keeps est. p95 ≤ ${inputs.targetP95Ms}ms`);
        rec = Math.max(rec, r);
      }
    }
    recommended = rec;
  }

  // ---- 2. Apply manual override (Simulator add / remove) -----------------
  const forced =
    canScale && opts.forcedReplicas != null
      ? Math.max(1, Math.round(opts.forcedReplicas))
      : undefined;
  const replicas = forced ?? recommended;
  if (forced != null && forced !== recommended) {
    notes.push(`Manual override → ${forced} (recommended ${recommended})`);
  }
  if (canScale && replicas < minSafe) {
    notes.push(`Below the ${inputs.targetAvailability} availability floor of ${minSafe}`);
  }

  // ---- 3. Resources -------------------------------------------------------
  const perRepRps = offered / Math.max(1, replicas);
  let cpuCores = replicas * (profile.cpuBase + profile.cpuPerRps * perRepRps);
  let memGi =
    (replicas * (profile.memBaseGi + (profile.memPerRpsMi * perRepRps) / 1024) +
      (profile.memPerSessionMi * demand.concurrentSessions) / 1024) /
    targetMem;

  let p95Ms: number | undefined;
  if (isPortal) {
    cpuCores = replicas * pod.cpu;
    memGi = replicas * pod.podMemoryGi;
    const cpuUsed = replicas * profile.cpuBase + profile.cpuPerRps * offered;
    notes.push(pod.note);
    notes.push(
      `Est. CPU used ${(cpuUsed / replicas).toFixed(2)} of ${pod.cpu}/pod; session heap ${(sessionMemGi / replicas).toFixed(2)}Gi of ${pod.heapGi}Gi heap/pod (≤${Math.round(SESSION_HEAP_FRACTION * 100)}% budget, incl ${Math.round((SESSION_MEM_SAFETY - 1) * 100)}% safety)`,
    );
    if (inputs.baselineP95Ms > 0) {
      p95Ms = portalP95Ms(inputs.baselineP95Ms, replicas, offered, profile.rpsPerReplica);
      notes.push(
        Number.isFinite(p95Ms)
          ? `Est. p95 at peak ${Math.round(p95Ms)}ms (baseline ${inputs.baselineP95Ms}ms, M/M/c)`
          : "Est. p95 unbounded — offered load exceeds capacity",
      );
    }
    notes.push(`Ref: ${HCL_SIZING_DOC}`);
  }

  if (id === "dxDbSecondary") {
    cpuCores = Math.max(cpuCores, 2);
    memGi = Math.max(memGi, 8);
  }

  // Storage: fixed base + demand-driven growth provisioned to the disk target.
  const baseStorageGi = replicas * profile.storageBaseGi;
  let demandStorageGi = 0;
  if (id === "dam" || id === "objectStorage") demandStorageGi += demand.damStorageGiMonth;
  if (id === "openSearch" || id === "remoteSearch") demandStorageGi += demand.searchIndexGi;
  if (id === "externalDb" || id === "dxDbSecondary") {
    demandStorageGi += Math.max(50, demand.searchIndexGi * 0.5);
  }
  if (id === "backupDr") {
    demandStorageGi += demand.rwxStorageGi * 0.5 + demand.damStorageGiMonth;
  }
  let storageGi = baseStorageGi + demandStorageGi / targetDisk;
  if (id === "rwxStorage") {
    storageGi = Math.max(baseStorageGi, demand.rwxStorageGi / targetDisk);
    notes.push(
      "DXCN Core requires RWX; Compose webEngine does not — DAM adds RWX when enabled",
    );
  }

  // ---- 4. Utilization, cost ----------------------------------------------
  const capacityRps = replicas * profile.rpsPerReplica;
  const util =
    profile.fixed || capacityRps <= 0 || offered === 0 ? 0 : offered / capacityRps;
  const p90 = utilP90(util, opts.confidence ?? "default");

  const infraCostMonth =
    cpuCores * HOURS_PER_MONTH * costs.vcpuPerHour +
    memGi * HOURS_PER_MONTH * costs.memGiBPerHour +
    storageGi * costs.storageGiBPerMonth;

  const licenseCostMonth =
    profile.licenseNode && replicas > 0 ? replicas * costs.dxLicensePerNodeMonth : 0;

  if (util >= 0.9) notes.push("Saturated at peak — add replicas or reduce RPS");
  else if (util >= 0.7) notes.push("High utilization — limited headroom");
  else if (p90 >= 0.9 && !profile.fixed) {
    notes.push(`p90 util ${(p90 * 100).toFixed(0)}% — could saturate if capacity is below estimate`);
  }

  return {
    id,
    label,
    plane,
    offeredRps: offered,
    capacityRps,
    util,
    utilP90: profile.fixed || offered === 0 ? 0 : p90,
    utilBand: utilBand(util, profile.fixed || offered === 0),
    replicas,
    recommendedReplicas: recommended,
    minSafeReplicas: minSafe,
    scalable: canScale,
    p95Ms,
    cpuCores,
    memGi,
    storageGi,
    infraCostMonth,
    licenseCostMonth,
    notes,
  };
}

/**
 * Absolute RPS on an edge. Uses demand values directly (not parent × ratio) so
 * edge labels always agree with the target node's offered RPS.
 * `fixed` edges carry the target node's offered load when it has one, else the
 * source's (e.g. storage edges), else front-door RPS (edges from users/CDN).
 */
export function edgeRps(
  edge: TopologyEdge,
  demand: Demand,
  offeredById: Map<ComponentId, number>,
): number {
  switch (edge.ratioKey) {
    case "cdn_miss":
      return demand.originRps + demand.iqRps;
    case "portal":
      return demand.portalRps;
    case "db":
      return demand.dbRps;
    case "search":
      return demand.searchRps;
    case "dam":
      return demand.damRps;
    case "image":
      return demand.imageRps;
    case "persist":
      return demand.persistRps;
    case "auth":
      return demand.authRps;
    case "iq":
      return demand.iqRps;
    case "author":
      return demand.authorRps;
    case "ring":
      return demand.ringRps;
    case "fixed": {
      if (edge.source === "users") return demand.frontDoorRps;
      const target = offeredById.get(edge.target);
      if (target != null && target > 0) return target;
      return offeredById.get(edge.source) ?? demand.frontDoorRps;
    }
    default: {
      const _exhaustive: never = edge.ratioKey;
      return _exhaustive;
    }
  }
}

export function getProfile(
  capacity: CapacityProfile,
  id: ComponentId,
): ComponentProfile | undefined {
  return capacity.components[id];
}
