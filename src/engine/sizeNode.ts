import { HOURS_PER_MONTH } from "./defaults";
import { HCL_CORE_POD, HCL_SIZING_DOC } from "./hclGuidance";
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
      return demand.portalRps + demand.iqRps;
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
    const sessionMem =
      (demand.concurrentSessions * inputs.sessionBytesKb) / 1024 / 1024;
    memGi = Math.max(memGi, replicas * profile.memBaseGi + sessionMem * 1.3);
    // HCL K8s guidance floors (CF239)
    cpuCores = Math.max(cpuCores, replicas * HCL_CORE_POD.cpu);
    memGi = Math.max(memGi, replicas * HCL_CORE_POD.podMemoryGi);
    notes.push(HCL_CORE_POD.note);
    notes.push(
      `Session memory ~${(sessionMem * 1.3).toFixed(1)} Gi (incl 30% safety)`,
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

export function edgeRatio(
  key: TopologyEdge["ratioKey"],
  demand: Demand,
  cacheHitRatio: number,
): number {
  const miss = Math.max(0, Math.min(1, 1 - cacheHitRatio));
  switch (key) {
    case "fixed":
      return 1;
    case "cdn_miss":
      return miss;
    case "portal":
      return demand.frontDoorRps > 0
        ? demand.portalRps /
            (demand.portalRps + demand.iqRps + demand.authRps || 1)
        : 1;
    case "db":
      return demand.portalRps > 0 ? demand.dbRps / demand.portalRps : 0;
    case "search":
      return demand.portalRps > 0 ? demand.searchRps / demand.portalRps : 0;
    case "dam":
      return demand.portalRps > 0 ? demand.damRps / demand.portalRps : 0;
    case "image":
      return demand.damRps > 0 ? demand.imageRps / demand.damRps : 0;
    case "persist":
      return 1;
    case "auth":
      return demand.portalRps > 0 ? demand.authRps / demand.portalRps : 0;
    case "iq":
      return demand.frontDoorRps > 0
        ? demand.iqRps / Math.max(demand.portalRps + demand.iqRps, 1)
        : 0;
    case "author":
      return demand.portalRps > 0 ? demand.authorRps / demand.portalRps : 0;
    case "ring":
      return demand.portalRps > 0 ? demand.ringRps / demand.portalRps : 0;
    default: {
      const _exhaustive: never = key;
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
