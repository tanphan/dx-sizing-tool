import { describe, expect, it } from "vitest";
import { defaultToggles, resolveToggles } from "../catalogs";
import { calibrateFromLocust } from "./calibrate";
import { defaultUnitCosts, defaultUsageInputs } from "./defaults";
import { normalizeInputs } from "./demand";
import { HCL_CORE_POD, HCL_TIERS, hclAuthPercents } from "./hclGuidance";
import { buildHelmHints, helmHintsYaml } from "./helm";
import { compareEstimateVsLive, parseKubectlTop } from "./liveCompare";
import { loadProfile } from "./profiles";
import { runSizing } from "./runSizing";
import { selectTopology } from "./topology";

describe("normalizeInputs", () => {
  it("derives portal RPS from peak users and session math", () => {
    const inputs = {
      ...defaultUsageInputs,
      peakConcurrentUsers: 5000,
      reqPerSession: 25,
      sessionDurationMin: 20,
      cacheHitRatio: 0.4,
      loadMultiplier: 1,
      growthCagr: 0,
      peakRpsOverride: 0,
    };
    const demand = normalizeInputs(inputs, defaultToggles("dxcn"), "dxcn");
    expect(demand.frontDoorRps).toBeCloseTo(104.166, 1);
    expect(demand.portalRps).toBeCloseTo(62.5, 1);
    expect(demand.originRps).toBeCloseTo(62.5, 1);
    expect(demand.concurrentSessions).toBe(5000);
  });

  it("splits front door into pages vs DAM from attach rates", () => {
    // DAM asset requests are part of the front-door total (not added on top):
    // share = a·n / (1 + a·n) = 0.3 / 1.3
    const demand = normalizeInputs(
      {
        ...defaultUsageInputs,
        growthCagr: 0,
        cacheHitRatio: 0,
        damCacheHitRatio: 0,
        searchAttachRate: 0.4,
        searchesPerHit: 1.5,
        damAttachRate: 0.1,
        assetsPerPage: 3,
        peakRpsOverride: 130,
      },
      { ...defaultToggles("dxcn"), dam: true, remoteSearch: true },
      "dxcn",
    );
    expect(demand.portalRps).toBeCloseTo(100, 5);
    expect(demand.damRps).toBeCloseTo(30, 5);
    expect(demand.originRps).toBeCloseTo(130, 5);
    expect(demand.searchRps).toBeCloseTo(60, 5);
    expect(demand.imageRps).toBeCloseTo(6, 5);
  });

  it("applies growth × load multiplier once (not squared)", () => {
    const base = {
      ...defaultUsageInputs,
      growthCagr: 0,
      loadMultiplier: 1,
      peakRpsOverride: 0,
      thinkTimeSec: 0,
    };
    const d1 = normalizeInputs(base, defaultToggles("dxcn"), "dxcn");
    const d2 = normalizeInputs({ ...base, loadMultiplier: 2 }, defaultToggles("dxcn"), "dxcn");
    const dg = normalizeInputs({ ...base, growthCagr: 0.15 }, defaultToggles("dxcn"), "dxcn");
    const dov = normalizeInputs(
      { ...base, peakRpsOverride: 100, loadMultiplier: 2 },
      defaultToggles("dxcn"),
      "dxcn",
    );
    expect(d2.frontDoorRps / d1.frontDoorRps).toBeCloseTo(2, 6);
    expect(dg.frontDoorRps / d1.frontDoorRps).toBeCloseTo(1.15, 6);
    expect(dov.frontDoorRps).toBeCloseTo(200, 6);
  });

  it("think time > 0 paces RPS as users ÷ think time", () => {
    const d = normalizeInputs(
      { ...defaultUsageInputs, growthCagr: 0, peakConcurrentUsers: 1000, thinkTimeSec: 2 },
      defaultToggles("compose"),
      "compose",
    );
    expect(d.frontDoorRps).toBeCloseTo(500, 6);
    expect(d.pacingSource).toBe("thinkTime");
    const s = normalizeInputs(
      { ...defaultUsageInputs, growthCagr: 0, thinkTimeSec: 0 },
      defaultToggles("compose"),
      "compose",
    );
    expect(s.pacingSource).toBe("session");
  });

  it("DAM request share + separate DAM cache ratio", () => {
    const d = normalizeInputs(
      {
        ...defaultUsageInputs,
        growthCagr: 0,
        peakRpsOverride: 1000,
        damRequestShare: 0.3,
        cacheHitRatio: 0.5,
        damCacheHitRatio: 0.9,
      },
      { ...defaultToggles("compose"), dam: true },
      "compose",
    );
    expect(d.damFrontDoorRps).toBeCloseTo(300, 6);
    expect(d.portalRps).toBeCloseTo(350, 6); // 700 × 0.5
    expect(d.damRps).toBeCloseTo(30, 6); // 300 × 0.1
  });

  it("computes IQ tokens when enabled", () => {
    const demand = normalizeInputs(
      {
        ...defaultUsageInputs,
        growthCagr: 0,
        dau: 1000,
        iqAttachRate: 0.2,
        iqMsgsPerSession: 4,
        iqTokensIn: 100,
        iqTokensOut: 50,
      },
      { ...defaultToggles("compose"), iqIntegrator: true },
      "compose",
    );
    expect(demand.iqEnabled).toBe(true);
    expect(demand.tokensPerMonth).toBe(1000 * 30 * 0.2 * 4 * 150);
  });
});

describe("RWX rules", () => {
  it("DXCN always forces RWX for Core", () => {
    const t = resolveToggles("dxcn", { ...defaultToggles("dxcn"), dam: false });
    expect(t.rwxStorage).toBe(true);
    const { nodes } = selectTopology("dxcn", t);
    expect(nodes.some((n) => n.id === "rwxStorage")).toBe(true);
    expect(nodes.some((n) => n.id === "core")).toBe(true);
  });

  it("Compose webEngine has no RWX without DAM", () => {
    const t = resolveToggles("compose", {
      ...defaultToggles("compose"),
      dam: false,
      rwxStorage: true,
    });
    expect(t.rwxStorage).toBe(false);
    const { nodes, edges } = selectTopology("compose", t);
    expect(nodes.some((n) => n.id === "rwxStorage")).toBe(false);
    expect(edges.some((e) => e.target === "rwxStorage")).toBe(false);
  });

  it("Compose enables RWX when DAM is on", () => {
    const t = resolveToggles("compose", {
      ...defaultToggles("compose"),
      dam: true,
    });
    expect(t.rwxStorage).toBe(true);
    const { edges } = selectTopology("compose", t);
    expect(edges.some((e) => e.id === "dam-rwx")).toBe(true);
    expect(edges.some((e) => e.id === "core-rwx")).toBe(false);
  });
});

describe("runSizing", () => {
  it("applies HA floor and HCL Core pod floors", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: {
        ...defaultUsageInputs,
        peakConcurrentUsers: 10,
        peakRpsOverride: 1,
        growthCagr: 0,
        azCount: 2,
      },
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const core = result.nodes.find((n) => n.id === "core");
    expect(core?.replicas).toBeGreaterThanOrEqual(2);
    expect(core?.cpuCores).toBeGreaterThanOrEqual(2 * HCL_CORE_POD.cpu);
    expect(core?.memGi).toBeGreaterThanOrEqual(2 * HCL_CORE_POD.podMemoryGi);
    expect(core?.plane).toBe("hcl");
  });

  it("production platform uses origin WAF path", () => {
    const result = runSizing({
      product: "compose",
      inputs: { ...defaultUsageInputs, productionPlatform: true, growthCagr: 0 },
      toggles: defaultToggles("compose"),
      costs: defaultUnitCosts,
      cloudProvider: "aws",
    });
    expect(result.nodes.some((n) => n.id === "waf")).toBe(true);
    expect(result.nodes.some((n) => n.id === "cloudLb")).toBe(true);
    expect(result.nodes.some((n) => n.id === "dxDbSecondary")).toBe(true);
    expect(result.edges.some((e) => e.id === "cdn-waf")).toBe(true);
    expect(result.edges.some((e) => e.id === "cdn-hap")).toBe(false);
    expect(result.nodes.find((n) => n.id === "waf")?.plane).toBe("platform");
  });

  it("HCL small tier auth mix is ~65% anonymous", () => {
    const { pctAnonymous } = hclAuthPercents();
    expect(pctAnonymous).toBe(65);
    expect(HCL_TIERS.small.concurrentUsers).toBe(1000);
    expect(HCL_TIERS.large.concurrentUsers).toBe(30000);
  });

  it("Compose has webEngine not core; no remoteSearch node", () => {
    const result = runSizing({
      product: "compose",
      inputs: defaultUsageInputs,
      toggles: { ...defaultToggles("compose"), remoteSearch: true },
      costs: defaultUnitCosts,
    });
    expect(result.nodes.some((n) => n.id === "webEngine")).toBe(true);
    expect(result.nodes.some((n) => n.id === "core")).toBe(false);
    expect(result.nodes.some((n) => n.id === "remoteSearch")).toBe(false);
  });

  it("Core/webEngine pods never exceed the HCL pod shape — scale out instead", () => {
    for (const product of ["dxcn", "compose"] as const) {
      const result = runSizing({
        product,
        inputs: { ...defaultUsageInputs, peakConcurrentUsers: 30000, thinkTimeSec: 2 },
        toggles: defaultToggles(product),
        costs: defaultUnitCosts,
      });
      const id = product === "dxcn" ? "core" : "webEngine";
      const n = result.nodes.find((x) => x.id === id)!;
      expect(n.cpuCores / n.replicas).toBeCloseTo(HCL_CORE_POD.cpu, 6);
      expect(n.memGi / n.replicas).toBeCloseTo(HCL_CORE_POD.podMemoryGi, 6);
    }
  });

  it("session heap drives Core replicas when sessions are large", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: {
        ...defaultUsageInputs,
        growthCagr: 0,
        peakConcurrentUsers: 20000,
        peakRpsOverride: 10, // negligible CPU, so heap must be the driver
        sessionBytesKb: 500,
      },
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const core = result.nodes.find((n) => n.id === "core")!;
    // 20000 × 500KB × 1.3 ≈ 12.4Gi ÷ (4Gi heap × 0.5) → 7 pods
    expect(core.replicas).toBe(7);
    expect(core.notes.some((s) => s.includes("session heap"))).toBe(true);
  });

  it("DAM is routed HAProxy → DAM and HAProxy carries DAM load", () => {
    const result = runSizing({
      product: "compose",
      inputs: { ...defaultUsageInputs, damRequestShare: 0.3 },
      toggles: { ...defaultToggles("compose"), dam: true },
      costs: defaultUnitCosts,
    });
    const dam = result.nodes.find((n) => n.id === "dam")!;
    const hap = result.nodes.find((n) => n.id === "haproxy")!;
    const we = result.nodes.find((n) => n.id === "webEngine")!;
    expect(result.edges.some((e) => e.id === "hap-dam")).toBe(true);
    expect(result.edges.some((e) => e.source === "webEngine" && e.target === "dam")).toBe(false);
    expect(hap.offeredRps).toBeCloseTo(we.offeredRps + dam.offeredRps, 6);
  });

  it("edge RPS matches target node offered RPS", () => {
    const result = runSizing({
      product: "compose",
      inputs: defaultUsageInputs,
      toggles: {
        ...defaultToggles("compose"),
        dam: true,
        searchMiddleware: true,
        openLdap: true,
      },
      costs: defaultUnitCosts,
    });
    const offered = new Map(result.nodes.map((n) => [n.id, n.offeredRps]));
    for (const id of ["hap-we", "hap-dam", "smw-fp", "smw-os", "dam-pool", "pool-node"]) {
      const e = result.edges.find((x) => x.id === id)!;
      expect(e, id).toBeDefined();
      expect(e.rps, id).toBeCloseTo(offered.get(e.target)!, 6);
    }
  });

  it("auth edges are Core/users→IdP and Core→LDAP, not HAProxy→IdP", () => {
    const { edges } = selectTopology("dxcn", {
      ...defaultToggles("dxcn"),
      externalIdp: true,
      openLdap: true,
    });
    expect(
      edges.some((e) => e.source === "haproxy" && e.target === "externalIdp"),
    ).toBe(false);
    expect(edges.some((e) => e.source === "users" && e.target === "externalIdp")).toBe(
      true,
    );
    expect(edges.some((e) => e.source === "core" && e.target === "externalIdp")).toBe(
      true,
    );
  });
});

describe("calibrate + helm + live", () => {
  it("calibrates rpsPerReplica and a non-zero cpuPerRps from Locust", () => {
    const base = loadProfile("dxcn-cf238");
    const { profile, notes } = calibrateFromLocust(base, [
      { componentId: "core", rps: 140, cpuCores: 6, replicas: 2, util: 0.7 },
    ]);
    expect(profile.confidence).toBe("lab-calibrated");
    expect(profile.components.core.rpsPerReplica).toBe(100);
    // (6/2 − cpuBase 2) / 70 rps — was 0 when the 5.6 pod floor was folded into cpuBase
    expect(profile.components.core.cpuPerRps).toBeCloseTo(1 / 70, 5);
    expect(notes.length).toBe(1);
  });

  it("builds helm hints with chart key paths and req == limit", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: defaultUsageInputs,
      toggles: { ...defaultToggles("dxcn"), dam: true },
      costs: defaultUnitCosts,
    });
    const hints = buildHelmHints(result.nodes);
    expect(hints.scaling.core).toBeGreaterThanOrEqual(2);
    expect(hints.resources.core.limits).toEqual({ cpu: "5.6", memory: "8Gi" });
    expect(hints.resources.core.requests).toEqual(hints.resources.core.limits);
    expect(hints.resources.digitalAssetManagement).toBeDefined();
    expect(hints.scaling.persistenceConnectionPool).toBeGreaterThanOrEqual(1);
    // openLdap / remoteSearch have resources but no scaling.replicas key in the chart
    expect(hints.scaling.remoteSearch).toBeUndefined();
    const yaml = helmHintsYaml(hints);
    expect(yaml).toMatch(/^scaling:\n {2}replicas:\n {4}/m);
    expect(yaml).not.toMatch(/applications\./);
    expect(yaml).toMatch(/-Xmx4g/);
  });

  it("parses kubectl top and compares", () => {
    const result = runSizing({
      product: "dxcn",
      inputs: defaultUsageInputs,
      toggles: defaultToggles("dxcn"),
      costs: defaultUnitCosts,
    });
    const live = parseKubectlTop(
      `NAME              CPU(cores)   MEMORY(bytes)
dx-core-0         1500m        4096Mi
haproxy-0         200m         256Mi`,
      { "dx-core": "core", haproxy: "haproxy" },
    );
    expect(live.find((r) => r.componentId === "core")?.cpuCoresObserved).toBe(
      1.5,
    );
    const cmp = compareEstimateVsLive(result.nodes, live);
    expect(cmp.find((r) => r.componentId === "core")?.status).not.toBe(
      "missing",
    );
  });
});
