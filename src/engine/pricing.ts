/**
 * Cloud list-price resolution. Pure: reads the committed snapshot written by
 * scripts/fetch-pricing.mjs (see docs/SPEC.md §6.5). No network calls at runtime.
 */
import snapshotJson from "../pricing/snapshot.json";
import { cloudProviders, type CloudProvider, type PricingProvider } from "./cloudProviders";
import type { EgressTier, UnitCosts } from "./types";

export type PricingProviderId = PricingProvider;
export type ComputeBasis = "instance" | "serverless";

export interface ComputeRates {
  vcpuPerHour: number;
  memGiBPerHour: number;
  family: string;
  /** Node-pool fit only: RMS error of price = a·vCPU + b·GiB, relative to mean price */
  relRmsError?: number;
  shapes?: string[];
}

export interface RegionPrices {
  label: string;
  instance: ComputeRates;
  serverless?: ComputeRates;
  storageGiBPerMonth: number;
  storageProduct: string;
  egressGb: number;
  egressTiers: EgressTier[];
}

export interface ProviderPrices {
  source: string;
  fetchedAt: string;
  priceType: string;
  regions: Record<string, RegionPrices>;
}

export interface PriceBook {
  generatedAt?: string;
  currency: string;
  providers: Partial<Record<PricingProviderId, ProviderPrices>>;
}

export interface PricingSelection {
  /** Provider region id (e.g. us-east-1, eastus, us-central1). Defaults per provider. */
  region?: string;
  /** "instance" = node-pool VMs (default), "serverless" = Fargate / ACI / Autopilot */
  basis?: ComputeBasis;
  /** true = use the unit costs as entered (user edited them) */
  custom?: boolean;
}

export interface PriceSource {
  kind: "list" | "custom" | "placeholder";
  provider?: PricingProviderId;
  region?: string;
  regionLabel?: string;
  basis?: ComputeBasis;
  fetchedAt?: string;
  computeFamily?: string;
  storageProduct?: string;
  /** One line for the UI / export */
  summary: string;
  notes: string[];
}

export const PRICE_BOOK = snapshotJson as PriceBook;

export const DEFAULT_REGION: Record<PricingProviderId, string> = {
  aws: "us-east-1",
  azure: "eastus",
  gke: "us-central1",
};

export const BASIS_LABELS: Record<ComputeBasis, string> = {
  instance: "Node-pool VMs",
  serverless: "Serverless pods",
};

/** Discount inputs are percentages; clamp to [0, 99] so list totals can always be recovered. */
const clampPct = (p: number | undefined) => Math.min(99, Math.max(0, Number(p) || 0));

/** Combined multiplier on cloud spend: (1 − cloud%) × (1 − enterprise%). */
export function discountFactor(costs: Pick<UnitCosts, "cloudDiscountPct" | "enterpriseDiscountPct">): number {
  return (1 - clampPct(costs.cloudDiscountPct) / 100) * (1 - clampPct(costs.enterpriseDiscountPct) / 100);
}

/**
 * Monthly egress at list price. With tiers, each GB is billed at the rate of the
 * tier it falls in (tiers are "up to N GB", last one unbounded); otherwise flat.
 */
export function egressCostMonth(gb: number, flatPerGb: number, tiers?: EgressTier[]): number {
  if (!(gb > 0)) return 0;
  if (!tiers?.length) return gb * flatPerGb;
  let cost = 0;
  let from = 0;
  for (const t of tiers) {
    const to = t.upToGb ?? Infinity;
    if (gb <= from) break;
    cost += (Math.min(gb, to) - from) * t.price;
    from = to;
  }
  return cost;
}

export function pricingProviderFor(cloud: CloudProvider): PricingProviderId {
  return cloudProviders[cloud].pricingProvider;
}

/** Regions available in the snapshot for a cloud provider, for the region selector. */
export function regionsFor(
  cloud: CloudProvider,
  book: PriceBook = PRICE_BOOK,
): Array<{ id: string; label: string }> {
  const regions = book.providers[pricingProviderFor(cloud)]?.regions ?? {};
  return Object.entries(regions).map(([id, r]) => ({ id, label: r.label }));
}

const BASE_NOTES = [
  "Public on-demand list prices. Excludes the K8s control-plane fee, node system overhead and bin-packing waste, managed services (DB, Redis, LB, NAT), support and taxes.",
];

/**
 * Pick unit costs for a provider / region / basis from the price book.
 * Non-cloud fields (tokens, license, LLM, discounts) always come from `base`.
 */
export function resolveUnitCosts(
  base: UnitCosts,
  cloud: CloudProvider | undefined,
  sel: PricingSelection = {},
  book: PriceBook = PRICE_BOOK,
): { costs: UnitCosts; source: PriceSource } {
  if (!cloud || sel.custom) {
    return {
      costs: { ...base, egressTiers: sel.custom ? undefined : base.egressTiers },
      source: { kind: "custom", summary: "Custom unit costs (as entered)", notes: [] },
    };
  }
  const provider = pricingProviderFor(cloud);
  const info = cloudProviders[cloud];
  const pp = book.providers[provider];
  const regionId = sel.region && pp?.regions[sel.region] ? sel.region : DEFAULT_REGION[provider];
  const region = pp?.regions[regionId] ?? (pp ? Object.values(pp.regions)[0] : undefined);
  const extraNotes = info.pricingNote ? [info.pricingNote] : [];

  if (!pp || !region) {
    return {
      costs: { ...base, egressTiers: undefined },
      source: {
        kind: "placeholder",
        provider,
        summary: `No ${info.short} list prices in the snapshot: placeholder unit costs`,
        notes: [
          provider === "gke"
            ? "GKE prices need the GCP_PRICING_API_KEY secret for the refresh job. Enter your own rates under Unit costs."
            : "Enter your own rates under Unit costs.",
          ...extraNotes,
        ],
      },
    };
  }

  const wantServerless = sel.basis === "serverless";
  const compute = wantServerless && region.serverless ? region.serverless : region.instance;
  const basis: ComputeBasis = wantServerless && region.serverless ? "serverless" : "instance";
  const notes = [...BASE_NOTES, ...extraNotes];
  if (wantServerless && !region.serverless) notes.push("No serverless rates for this region; using node-pool rates.");
  if (basis === "instance") {
    notes.push(`Node-pool rates are a per-vCPU / per-GiB fit over ${compute.family}.`);
  }

  return {
    costs: {
      ...base,
      vcpuPerHour: compute.vcpuPerHour,
      memGiBPerHour: compute.memGiBPerHour,
      storageGiBPerMonth: region.storageGiBPerMonth,
      egressGb: region.egressGb,
      egressTiers: region.egressTiers,
    },
    source: {
      kind: "list",
      provider,
      region: regionId,
      regionLabel: region.label,
      basis,
      fetchedAt: pp.fetchedAt,
      computeFamily: compute.family,
      storageProduct: region.storageProduct,
      summary: `${info.short} ${regionId} list prices, ${BASIS_LABELS[basis]}, fetched ${pp.fetchedAt}.`,
      notes,
    },
  };
}
