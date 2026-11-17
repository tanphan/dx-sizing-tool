import { HOURS_PER_MONTH } from "./defaults";
import {
  HCL_CORE_POD,
  HCL_SIZING_DOC,
  SESSION_HEAP_FRACTION,
  SESSION_MEM_SAFETY,
} from "./hclGuidance";
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

export function sizeNode(
  id: ComponentId,
  label: string,
  plane: ComponentPlane,
  demand: Demand,
  profile: ComponentProfile | undefined,
  costs: UnitCosts,
  inputs: UsageInputs,
  sidecarOfReplicas?: number,
): SizedNode {
  if (!profile) {
    return {
      id,
      label,
      plane,
      offeredRps: offeredFor(id, demand),
      capacityRps: 0,
      util: 0,
      utilBand: "n/a",
      replicas: 0,
      cpuCores: 0,
      memGi: 0,
      storageGi: 0,
      infraCostMonth: 0,
      licenseCostMonth: 0,
      notes: ["No capacity profile for this node"],
    };
  }

  const offered = offeredFor(id, demand);
  const notes: string[] = [];
  let replicas: number;

  if (profile.fixed) {
    replicas =
      id === "prereqsChecker"
        ? 0
        : id === "loggingSidecar"
          ? Math.max(1, sidecarOfReplicas ?? 1)
          : Math.max(profile.minReplicas, 1);
    if (id === "prereqsChecker") {
      notes.push("Job-only; ignored in steady-state cost");
    }
    if (id === "dxDbSecondary") {
      notes.push("Failover / sync standby — sized ≈ primary storage, partial CPU");
    }
  } else if (!profile.scalable) {
    replicas = Math.max(profile.minReplicas, 1);
  } else {
    const loadRep = Math.ceil(offered / Math.max(1, profile.rpsPerReplica));
    const haRep = Math.max(profile.haMinReplicas, inputs.azCount);
    replicas = Math.max(loadRep, haRep, profile.minReplicas);
    if (replicas === haRep && loadRep < haRep) {
      notes.push("HA / AZ floor applied");
    }
  }

  const perRepRps = offered / Math.max(1, replicas);
  let cpuCores =
    replicas * (profile.cpuBase + profile.cpuPerRps * perRepRps);

  let memGi =
    replicas *
    (profile.memBaseGi +
      (profile.memPerRpsMi * perRepRps) / 1024 +
      (profile.memPerSessionMi * demand.concurrentSessions) /
        1024 /
        Math.max(1, replicas));

  if (id === "core" || id === "webEngine") {
    // Fixed HCL pod shape (req = limit). Scale OUT when CPU demand or session
    // heap would exceed one pod, instead of growing the pod past the guidance.
    const pod = HCL_CORE_POD;
    const cpuHeadroom = Math.max(0.1, pod.cpu - profile.cpuBase);
    const cpuRep = Math.ceil((profile.cpuPerRps * offered) / cpuHeadroom);
    const sessionMemGi =
      (demand.concurrentSessions * inputs.sessionBytesKb * SESSION_MEM_SAFETY) /
      1024 /
      1024;
    const heapBudgetGi = pod.heapGi * SESSION_HEAP_FRACTION;
    const heapRep = Math.ceil(sessionMemGi / heapBudgetGi);
    const before = replicas;
    replicas = Math.max(replicas, cpuRep, heapRep);
    if (replicas > before) {
      notes.push(
        replicas === heapRep
          ? `Scaled to ${replicas} replicas: session heap ${sessionMemGi.toFixed(1)}Gi > ${heapBudgetGi}Gi/pod budget`
          : `Scaled to ${replicas} replicas: CPU demand exceeds ${pod.cpu} CPU/pod`,
      );
    }
    cpuCores = replicas * pod.cpu;
    memGi = replicas * pod.podMemoryGi;
    const cpuUsed =
      replicas * profile.cpuBase + profile.cpuPerRps * offered;
    notes.push(pod.note);
    notes.push(
      `Est. CPU used ${(cpuUsed / replicas).toFixed(2)} of ${pod.cpu}/pod; session heap ${(sessionMemGi / replicas).toFixed(2)}Gi of ${pod.heapGi}Gi heap/pod (≤${Math.round(SESSION_HEAP_FRACTION * 100)}% budget, incl ${Math.round((SESSION_MEM_SAFETY - 1) * 100)}% safety)`,
    );
    notes.push(`Ref: ${HCL_SIZING_DOC}`);
  }

  if (id === "dxDbSecondary") {
    cpuCores = Math.max(cpuCores, 2);
    memGi = Math.max(memGi, 8);
  }

  let storageGi = replicas * profile.storageBaseGi;
  if (id === "dam") storageGi += demand.damStorageGiMonth;
  if (id === "openSearch" || id === "remoteSearch") {
    storageGi += demand.searchIndexGi;
  }
  if (id === "externalDb" || id === "dxDbSecondary") {
    storageGi += Math.max(50, demand.searchIndexGi * 0.5);
  }
  if (id === "rwxStorage") {
    storageGi = Math.max(storageGi, demand.rwxStorageGi);
    notes.push(
      "DXCN Core requires RWX; Compose webEngine does not — DAM adds RWX when enabled",
    );
  }
  if (id === "objectStorage") {
    storageGi += demand.damStorageGiMonth;
  }
  if (id === "backupDr") {
    storageGi += demand.rwxStorageGi * 0.5 + demand.damStorageGiMonth;
  }

  const capacityRps = replicas * profile.rpsPerReplica;
  const util =
    profile.fixed || capacityRps <= 0 || offered === 0
      ? 0
      : offered / capacityRps;

  const infraCostMonth =
    cpuCores * HOURS_PER_MONTH * costs.vcpuPerHour +
    memGi * HOURS_PER_MONTH * costs.memGiBPerHour +
    storageGi * costs.storageGiBPerMonth;

  const licenseCostMonth =
    profile.licenseNode && replicas > 0
      ? replicas * costs.dxLicensePerNodeMonth
      : 0;

  if (util >= 0.9) notes.push("Saturated at peak — add replicas or reduce RPS");
  else if (util >= 0.7) notes.push("High utilization — limited headroom");

  return {
    id,
    label,
    plane,
    offeredRps: offered,
    capacityRps,
    util,
    utilBand: utilBand(util, profile.fixed || offered === 0),
    replicas,
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
