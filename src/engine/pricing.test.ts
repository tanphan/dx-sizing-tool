import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script without type declarations
import { fitRates } from "../../scripts/fetch-pricing.mjs";
import { defaultToggles } from "../catalogs";
import { defaultUnitCosts, defaultUsageInputs } from "./defaults";
import {
  discountFactor,
  egressCostMonth,
  PRICE_BOOK,
  resolveUnitCosts,
  type PriceBook,
} from "./pricing";
import { runSizing } from "./runSizing";

/** Fixture book: fixed numbers so tests don't move when the weekly snapshot changes. */
const BOOK: PriceBook = {
  currency: "USD",
  providers: {
    aws: {
      source: "fixture",
      fetchedAt: "2026-01-01",
      priceType: "public on-demand list price",
      regions: {
        "us-east-1": {
          label: "US East (N. Virginia)",
          instance: { vcpuPerHour: 0.037, memGiBPerHour: 0.00275, family: "EC2 fixture" },
          serverless: { vcpuPerHour: 0.04048, memGiBPerHour: 0.004445, family: "Fargate fixture" },
          storageGiBPerMonth: 0.08,
          storageProduct: "EBS gp3",
          egressGb: 0.09,
          egressTiers: [
            { upToGb: 100, price: 0 },
            { upToGb: 10240, price: 0.09 },
            { upToGb: null, price: 0.085 },
          ],
        },
        "eu-west-1": {
          label: "EU (Ireland)",
          instance: { vcpuPerHour: 0.041, memGiBPerHour: 0.003, family: "EC2 fixture" },
          storageGiBPerMonth: 0.088,
          storageProduct: "EBS gp3",
          egressGb: 0.09,
          egressTiers: [{ upToGb: null, price: 0.09 }],
        },
      },
    },
  },
};

describe("pricing: tiered egress and discounts", () => {
  const tiers = BOOK.providers.aws!.regions["us-east-1"].egressTiers;

  it("bills each GB at its tier rate", () => {
    // 500 GB: first 100 free, 400 × 0.09 = 36
    expect(egressCostMonth(500, 0.09, tiers)).toBeCloseTo(36, 6);
    // 20,000 GB: (10240 − 100) × 0.09 + (20000 − 10240) × 0.085 = 912.6 + 829.6 = 1742.2
    expect(egressCostMonth(20000, 0.09, tiers)).toBeCloseTo(1742.2, 6);
    // Flat when no tiers: 500 × 0.09 = 45
    expect(egressCostMonth(500, 0.09)).toBeCloseTo(45, 6);
    expect(egressCostMonth(0, 0.09, tiers)).toBe(0);
  });

  it("compounds cloud and enterprise discounts and clamps to 0–99%", () => {
    // (1 − 0.20) × (1 − 0.10) = 0.72
    expect(discountFactor({ cloudDiscountPct: 20, enterpriseDiscountPct: 10 })).toBeCloseTo(0.72, 9);
    // 150% clamps to 99% → 0.01; negative clamps to 0
    expect(discountFactor({ cloudDiscountPct: 150, enterpriseDiscountPct: -5 })).toBeCloseTo(0.01, 9);
  });
});

describe("pricing: resolveUnitCosts", () => {
  it("uses the selected region and node-pool basis by default", () => {
    const { costs, source } = resolveUnitCosts(defaultUnitCosts, "aws", { region: "eu-west-1" }, BOOK);
    expect(costs.vcpuPerHour).toBe(0.041);
    expect(costs.storageGiBPerMonth).toBe(0.088);
    expect(source.kind).toBe("list");
    expect(source.region).toBe("eu-west-1");
    expect(source.basis).toBe("instance");
    // Non-cloud fields pass through untouched
    expect(costs.tokensPer1k).toBe(defaultUnitCosts.tokensPer1k);
  });

  it("uses serverless rates when asked, falling back to node-pool where missing", () => {
    const sv = resolveUnitCosts(defaultUnitCosts, "aws", { region: "us-east-1", basis: "serverless" }, BOOK);
    expect(sv.costs.vcpuPerHour).toBe(0.04048);
    expect(sv.source.basis).toBe("serverless");
    const fb = resolveUnitCosts(defaultUnitCosts, "aws", { region: "eu-west-1", basis: "serverless" }, BOOK);
    expect(fb.costs.vcpuPerHour).toBe(0.041);
    expect(fb.source.basis).toBe("instance");
  });

  it("falls back to the provider default region for an unknown region", () => {
    const { source } = resolveUnitCosts(defaultUnitCosts, "aws", { region: "eastus" }, BOOK);
    expect(source.region).toBe("us-east-1");
  });

  it("maps OpenShift to AWS rates and notes the missing subscription fee", () => {
    const { costs, source } = resolveUnitCosts(defaultUnitCosts, "rhos", {}, BOOK);
    expect(costs.vcpuPerHour).toBe(0.037);
    expect(source.notes.join(" ")).toMatch(/subscription/);
  });

  it("flags placeholder prices when a provider has no snapshot data", () => {
    const { costs, source } = resolveUnitCosts(defaultUnitCosts, "gke", {}, BOOK);
    expect(source.kind).toBe("placeholder");
    expect(costs.vcpuPerHour).toBe(defaultUnitCosts.vcpuPerHour);
    expect(source.notes.join(" ")).toMatch(/GCP_PRICING_API_KEY/);
  });

  it("keeps custom unit costs as entered and drops tiers", () => {
    const base = { ...defaultUnitCosts, vcpuPerHour: 0.02, egressTiers: [{ upToGb: null, price: 1 }] };
    const { costs, source } = resolveUnitCosts(base, "aws", { custom: true }, BOOK);
    expect(costs.vcpuPerHour).toBe(0.02);
    expect(costs.egressTiers).toBeUndefined();
    expect(source.kind).toBe("custom");
  });
});

describe("pricing: runSizing integration", () => {
  const base = {
    product: "dxcn" as const,
    inputs: { ...defaultUsageInputs, growthCagr: 0, dau: 20000, avgPageKb: 100 },
    toggles: defaultToggles("dxcn"),
  };

  it("discounts cloud spend only and reports list vs net", () => {
    const costs = { ...defaultUnitCosts, dxLicensePerNodeMonth: 100 };
    const list = runSizing({ ...base, costs, pricing: { custom: true }, cloudProvider: "aws" });
    const net = runSizing({
      ...base,
      costs: { ...costs, cloudDiscountPct: 20, enterpriseDiscountPct: 10 },
      pricing: { custom: true },
      cloudProvider: "aws",
    });
    // Infra and egress scale by 0.72; license is untouched
    expect(net.costs.infraMonth).toBeCloseTo(list.costs.infraMonth * 0.72, 6);
    expect(net.costs.egressMonth).toBeCloseTo(list.costs.egressMonth * 0.72, 6);
    expect(net.costs.licenseMonth).toBeCloseTo(list.costs.licenseMonth, 6);
    expect(net.costs.cloudListMonth).toBeCloseTo(list.costs.infraMonth + list.costs.egressMonth, 6);
    expect(net.costs.cloudDiscountMonth).toBeCloseTo(
      (list.costs.infraMonth + list.costs.egressMonth) * 0.28,
      6,
    );
    expect(list.costs.cloudDiscountMonth).toBeCloseTo(0, 9);
  });

  it("merges defaults over saved unit costs that predate discounts", () => {
    const legacy = { ...defaultUnitCosts } as Partial<typeof defaultUnitCosts>;
    delete legacy.cloudDiscountPct;
    delete legacy.enterpriseDiscountPct;
    const r = runSizing({ ...base, costs: legacy as typeof defaultUnitCosts, pricing: { custom: true } });
    expect(r.costs.discountFactor).toBe(1);
    expect(Number.isFinite(r.costs.totalMonth)).toBe(true);
  });

  it("uses snapshot list prices when a provider is selected", () => {
    const r = runSizing({ ...base, costs: defaultUnitCosts, cloudProvider: "azure" });
    expect(r.priceSource.kind).toBe(PRICE_BOOK.providers.azure ? "list" : "placeholder");
  });
});

describe("pricing: node-pool rate fit (fetch script)", () => {
  it("splits instance prices into per-vCPU and per-GiB rates", () => {
    // 4a + 8b = 0.17 and 4a + 16b = 0.192 → b = 0.022 / 8 = 0.00275, a = (0.17 − 0.022) / 4 = 0.037
    const fit = fitRates([
      { vcpu: 4, gib: 8, price: 0.17 },
      { vcpu: 4, gib: 16, price: 0.192 },
    ]);
    expect(fit.vcpuPerHour).toBeCloseTo(0.037, 6);
    expect(fit.memGiBPerHour).toBeCloseTo(0.00275, 6);
    expect(fit.relRmsError).toBeCloseTo(0, 6);
  });
});
