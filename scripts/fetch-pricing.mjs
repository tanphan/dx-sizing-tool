#!/usr/bin/env node
/**
 * Fetch public cloud list prices and write src/pricing/snapshot.json.
 *
 * Sources (no login needed unless noted):
 *   AWS    Price List bulk offer files  https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/
 *          - AmazonECS  (Fargate vCPU / GB-hour)
 *          - AmazonEC2  (CSV, streamed: c6i/m6i/r6i Linux on-demand, EBS gp3)
 *          - AWSDataTransfer (internet egress tiers)
 *   Azure  Retail Prices API            https://prices.azure.com/api/retail/prices
 *          - Dlsv5 / Dsv5 / Esv5 Linux VMs, Container Instances, Premium SSD v2, Bandwidth (MGN routing)
 *   GCP    Cloud Billing Catalog API    https://cloudbilling.googleapis.com/v1/  (needs GCP_PRICING_API_KEY)
 *          - N2 core / RAM, GKE Autopilot pod requests, Balanced PD, premium internet egress
 *
 * Node-pool basis: price = a·vCPU + b·GiB fitted by least squares over three instance families
 * with different memory ratios (1:2, 1:4, 1:8), so a and b are per-vCPU and per-GiB list rates.
 *
 * Usage:  node scripts/fetch-pricing.mjs [--provider aws|azure|gke] [--dry-run]
 * A provider that fails keeps its previous snapshot data; the script exits 1 so CI shows it.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const OUT = new URL("../src/pricing/snapshot.json", import.meta.url);
const HOURS_PER_MONTH = 730;
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY = args.includes("--provider") ? args[args.indexOf("--provider") + 1] : null;

export const REGIONS = {
  aws: ["us-east-1", "us-east-2", "us-west-2", "ca-central-1", "sa-east-1", "eu-west-1", "eu-west-2",
    "eu-central-1", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "ap-northeast-1"],
  azure: ["eastus", "eastus2", "westus2", "canadacentral", "brazilsouth", "northeurope", "westeurope",
    "uksouth", "germanywestcentral", "centralindia", "southeastasia", "australiaeast", "japaneast"],
  gke: ["us-east1", "us-east4", "us-central1", "us-west1", "northamerica-northeast1", "southamerica-east1",
    "europe-west1", "europe-west2", "europe-west3", "asia-south1", "asia-southeast1",
    "australia-southeast1", "asia-northeast1"],
};

const GCP_LABELS = {
  "us-east1": "South Carolina", "us-east4": "N. Virginia", "us-central1": "Iowa", "us-west1": "Oregon",
  "northamerica-northeast1": "Montréal", "southamerica-east1": "São Paulo", "europe-west1": "Belgium",
  "europe-west2": "London", "europe-west3": "Frankfurt", "asia-south1": "Mumbai",
  "asia-southeast1": "Singapore", "australia-southeast1": "Sydney", "asia-northeast1": "Tokyo",
};

/** Plausible list-price bounds; anything outside is treated as a parse error, not data. */
const BOUNDS = {
  vcpuPerHour: [0.005, 0.5],
  memGiBPerHour: [0.0003, 0.05],
  storageGiBPerMonth: [0.01, 1],
  egressGb: [0.005, 0.5],
};

// ---------- helpers ----------

const log = (...m) => console.error("[pricing]", ...m);

async function fetchRetry(url, init = {}, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url.split("?")[0]}`);
        err.fatal = true;
        throw err;
      }
      return res;
    } catch (e) {
      if (e.fatal || i >= tries) throw e;
      const wait = 1000 * 2 ** i;
      log(`retry ${i} in ${wait}ms: ${e.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const getJson = async (url, init) => (await fetchRetry(url, init)).json();

const round = (x, dp = 6) => Number(x.toFixed(dp));

function checkBounds(region, rates) {
  for (const [k, [lo, hi]] of Object.entries(BOUNDS)) {
    const v = rates[k];
    if (v == null) continue;
    if (!(v >= lo && v <= hi)) throw new Error(`${region}: ${k}=${v} outside [${lo}, ${hi}]`);
  }
}

/** Least squares fit price = a·vcpu + b·gib (no intercept). */
export function fitRates(points) {
  let svv = 0, sgg = 0, svg = 0, svp = 0, sgp = 0;
  for (const { vcpu: v, gib: g, price: p } of points) {
    svv += v * v; sgg += g * g; svg += v * g; svp += v * p; sgp += g * p;
  }
  const det = svv * sgg - svg * svg;
  if (points.length < 2 || Math.abs(det) < 1e-9) throw new Error("fit needs 2+ shapes with different ratios");
  const a = (svp * sgg - sgp * svg) / det;
  const b = (sgp * svv - svp * svg) / det;
  const rms = Math.sqrt(points.reduce((s, x) => s + (a * x.vcpu + b * x.gib - x.price) ** 2, 0) / points.length);
  const meanP = points.reduce((s, x) => s + x.price, 0) / points.length;
  if (a <= 0 || b <= 0) throw new Error(`fit produced non-positive rate a=${a} b=${b}`);
  return { vcpuPerHour: round(a), memGiBPerHour: round(b), relRmsError: round(rms / meanP, 4) };
}

/** Minimal RFC 4180 line splitter (AWS CSV rows have no embedded newlines). */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Convert flat "from GB" tier rows into [{upToGb, price}] (upToGb null = unbounded). */
function toTiers(rows) {
  const sorted = [...rows].sort((a, b) => a.fromGb - b.fromGb);
  return sorted.map((r, i) => ({
    upToGb: i + 1 < sorted.length ? sorted[i + 1].fromGb : null,
    price: round(r.price, 5),
  }));
}

const firstPaid = (tiers) => tiers.find((t) => t.price > 0)?.price;

// ---------- AWS ----------

const AWS_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";
const AWS_SHAPES = ["c6i", "m6i", "r6i"].flatMap((f) => ["xlarge", "2xlarge", "4xlarge"].map((s) => `${f}.${s}`));

function awsOnDemand(offer, sku) {
  const terms = offer.terms?.OnDemand?.[sku];
  if (!terms) return [];
  return Object.values(terms).flatMap((t) => Object.values(t.priceDimensions));
}

async function awsRegion(region) {
  // Fargate (Linux x86)
  const ecs = await getJson(`${AWS_BASE}/AmazonECS/current/${region}/index.json`);
  let fargateCpu, fargateMem, label;
  for (const [sku, p] of Object.entries(ecs.products)) {
    const ut = p.attributes.usagetype ?? "";
    if (/Fargate-vCPU-Hours:perCPU$/.test(ut) && !/ARM|Windows/.test(ut)) {
      fargateCpu = Number(awsOnDemand(ecs, sku)[0]?.pricePerUnit.USD);
      label = p.attributes.location;
    }
    if (/Fargate-GB-Hours$/.test(ut) && !/ARM|Windows/.test(ut)) {
      fargateMem = Number(awsOnDemand(ecs, sku)[0]?.pricePerUnit.USD);
    }
  }

  // EC2 CSV (streamed; ~0.5 GB): instance shapes + gp3
  const res = await fetchRetry(`${AWS_BASE}/AmazonEC2/current/${region}/index.csv`);
  const rl = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let col = null, gp3, publication;
  const points = [];
  const shapeRe = new RegExp(`(^|-)BoxUsage:(${AWS_SHAPES.map((s) => s.replace(".", "\\.")).join("|")})$`);
  for await (const line of rl) {
    if (!col) {
      if (line.startsWith('"Publication Date"')) publication = splitCsv(line)[1];
      if (line.startsWith('"SKU"')) {
        const h = splitCsv(line);
        col = Object.fromEntries(h.map((k, i) => [k, i]));
      }
      continue;
    }
    // Cheap prefilter before a full parse
    if (!line.includes('"OnDemand"') || !(line.includes("BoxUsage:") || line.includes("VolumeUsage.gp3"))) continue;
    const r = splitCsv(line);
    // "OnDemand" also appears in other columns of Reserved rows, so check the term itself.
    if (r[col.TermType] !== "OnDemand") continue;
    const ut = r[col.usageType];
    if (/(^|-)EBS:VolumeUsage\.gp3$/.test(ut) && r[col.Unit] === "GB-Mo") {
      gp3 = Number(r[col.PricePerUnit]);
      continue;
    }
    if (!shapeRe.test(ut)) continue;
    if (r[col.Tenancy] !== "Shared" || r[col["Operating System"]] !== "Linux") continue;
    if (r[col["Pre Installed S/W"]] !== "NA" || r[col.CapacityStatus] !== "Used") continue;
    if (r[col["License Model"]] !== "No License required" || r[col.Unit] !== "Hrs") continue;
    if (points.some((p) => p.shape === r[col["Instance Type"]])) continue;
    points.push({
      shape: r[col["Instance Type"]],
      vcpu: Number(r[col.vCPU]),
      gib: Number(String(r[col.Memory]).replace(/[^0-9.]/g, "")),
      price: Number(r[col.PricePerUnit]),
    });
  }
  if (points.length < 3) throw new Error(`${region}: only ${points.length} EC2 shapes found`);
  const fit = fitRates(points);

  // Internet egress tiers
  const dt = await getJson(`${AWS_BASE}/AWSDataTransfer/current/${region}/index.json`);
  const rows = [];
  let freeGb = 0;
  for (const [sku, p] of Object.entries(dt.products)) {
    const a = p.attributes;
    if (a.transferType !== "AWS Outbound" || a.toLocation !== "External") continue;
    for (const pd of awsOnDemand(dt, sku)) {
      const from = Number(pd.beginRange), price = Number(pd.pricePerUnit.USD);
      if (a.fromRegionCode === region) rows.push({ fromGb: from, price });
      else if (!a.fromRegionCode && price === 0) freeGb = Math.max(freeGb, Number(pd.endRange) || 0);
    }
  }
  if (!rows.length) throw new Error(`${region}: no egress tiers`);
  // AWS's 100 GB/month free allowance is account-wide; model it as a free first tier.
  if (freeGb > 0) {
    const first = rows.find((r) => r.fromGb === 0);
    if (first) first.fromGb = freeGb;
    rows.push({ fromGb: 0, price: 0 });
  }
  const egressTiers = toTiers(rows);

  const out = {
    label: label ?? region,
    instance: { ...fit, shapes: points.map((p) => p.shape).sort(), family: "EC2 c6i / m6i / r6i (Linux, on-demand)" },
    serverless: { vcpuPerHour: round(fargateCpu), memGiBPerHour: round(fargateMem), family: "Fargate (Linux x86)" },
    storageGiBPerMonth: round(gp3, 4),
    storageProduct: "EBS gp3",
    egressGb: firstPaid(egressTiers),
    egressTiers,
    publication,
  };
  checkBounds(region, { ...out.instance, storageGiBPerMonth: out.storageGiBPerMonth, egressGb: out.egressGb });
  checkBounds(region, out.serverless);
  return out;
}

// ---------- Azure ----------

const AZ_API = "https://prices.azure.com/api/retail/prices";
const AZ_SHAPES = [
  ["Standard_D4ls_v5", 4, 8], ["Standard_D8ls_v5", 8, 16], ["Standard_D16ls_v5", 16, 32],
  ["Standard_D4s_v5", 4, 16], ["Standard_D8s_v5", 8, 32], ["Standard_D16s_v5", 16, 64],
  ["Standard_E4s_v5", 4, 32], ["Standard_E8s_v5", 8, 64], ["Standard_E16s_v5", 16, 128],
];

async function azQuery(filter) {
  let url = `${AZ_API}?$filter=${encodeURIComponent(filter)}`;
  const items = [];
  for (let page = 0; url && page < 50; page++) {
    const d = await getJson(url);
    items.push(...d.Items);
    url = d.NextPageLink;
  }
  return items;
}

async function azureRegion(region) {
  const skuList = AZ_SHAPES.map(([s]) => `armSkuName eq '${s}'`).join(" or ");
  const vms = await azQuery(
    `serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType eq 'Consumption' and (${skuList})`,
  );
  const points = [];
  let label = region;
  for (const [sku, vcpu, gib] of AZ_SHAPES) {
    const it = vms.find((i) => i.armSkuName === sku && !/Windows/.test(i.productName) &&
      !/Spot|Low Priority/.test(i.skuName) && i.unitOfMeasure === "1 Hour");
    if (it) {
      points.push({ shape: sku, vcpu, gib, price: it.retailPrice });
      label = it.location ?? label;
    }
  }
  if (points.length < 3) throw new Error(`${region}: only ${points.length} VM shapes found`);
  const fit = fitRates(points);

  const aci = await azQuery(
    `serviceName eq 'Container Instances' and armRegionName eq '${region}' and priceType eq 'Consumption' and skuName eq 'Standard'`,
  );
  const aciCpu = aci.find((i) => i.meterName === "Standard vCPU Duration" && i.unitOfMeasure === "1 Hour")?.retailPrice;
  const aciMem = aci.find((i) => i.meterName === "Standard Memory Duration" && i.unitOfMeasure === "1 GB Hour")?.retailPrice;

  const disk = await azQuery(
    `serviceName eq 'Storage' and armRegionName eq '${region}' and priceType eq 'Consumption' and productName eq 'Azure Premium SSD v2' and meterName eq 'Premium LRS Provisioned Capacity'`,
  );
  const diskHour = disk.find((i) => i.unitOfMeasure === "1 GiB/Hour")?.retailPrice;

  const bw = await azQuery(
    `serviceName eq 'Bandwidth' and armRegionName eq '${region}' and priceType eq 'Consumption' and meterName eq 'Standard Data Transfer Out'`,
  );
  const mgn = bw.filter((i) => /Rtn Preference: MGN/.test(i.productName) && i.unitOfMeasure === "1 GB");
  if (!mgn.length) throw new Error(`${region}: no bandwidth tiers`);
  const egressTiers = toTiers(mgn.map((i) => ({ fromGb: i.tierMinimumUnits, price: i.retailPrice })));

  const out = {
    label,
    instance: { ...fit, shapes: points.map((p) => p.shape).sort(), family: "Dlsv5 / Dsv5 / Esv5 (Linux, pay-as-you-go)" },
    serverless: { vcpuPerHour: round(aciCpu), memGiBPerHour: round(aciMem), family: "Container Instances (Standard)" },
    storageGiBPerMonth: round(diskHour * HOURS_PER_MONTH, 4),
    storageProduct: "Premium SSD v2 capacity",
    egressGb: firstPaid(egressTiers),
    egressTiers,
  };
  checkBounds(region, { ...out.instance, storageGiBPerMonth: out.storageGiBPerMonth, egressGb: out.egressGb });
  checkBounds(region, out.serverless);
  return out;
}

// ---------- GCP (needs API key) ----------

const GCP_API = "https://cloudbilling.googleapis.com/v1";

async function gcpSkus(serviceDisplayName, key) {
  const services = [];
  let token = "";
  do {
    const d = await getJson(`${GCP_API}/services?pageSize=5000&pageToken=${token}`, { headers: { "X-Goog-Api-Key": key } });
    services.push(...(d.services ?? []));
    token = d.nextPageToken ?? "";
  } while (token);
  const svc = services.find((s) => s.displayName === serviceDisplayName);
  if (!svc) throw new Error(`GCP service "${serviceDisplayName}" not found`);
  const skus = [];
  token = "";
  do {
    const d = await getJson(`${GCP_API}/${svc.name}/skus?currencyCode=USD&pageSize=5000&pageToken=${token}`, {
      headers: { "X-Goog-Api-Key": key },
    });
    skus.push(...(d.skus ?? []));
    token = d.nextPageToken ?? "";
  } while (token);
  return skus;
}

const gcpMoney = (m) => Number(m.units ?? 0) + (m.nanos ?? 0) / 1e9;

function gcpTiers(sku) {
  const pe = sku.pricingInfo?.[0]?.pricingExpression;
  return {
    unit: pe?.usageUnit,
    tiers: (pe?.tieredRates ?? []).map((t) => ({ fromGb: t.startUsageAmount ?? 0, price: gcpMoney(t.unitPrice) })),
  };
}

const gcpRate = (sku) => firstPaid(toTiers(gcpTiers(sku).tiers)) ?? 0;

function gcpPick(skus, region, re, { unit, onDemand = true } = {}) {
  return skus.filter((s) =>
    re.test(s.description) &&
    (s.serviceRegions ?? []).includes(region) &&
    (!onDemand || s.category?.usageType === "OnDemand") &&
    (!unit || gcpTiers(s).unit === unit));
}

async function gkeAll(key) {
  const compute = await gcpSkus("Compute Engine", key);
  const gke = await gcpSkus("Kubernetes Engine", key);
  const out = {};
  for (const region of REGIONS.gke) {
    try {
      const core = gcpPick(compute, region, /^N2 Instance Core running in/, { unit: "h" })[0];
      const ram = gcpPick(compute, region, /^N2 Instance Ram running in/, { unit: "GiBy.h" })[0];
      // Autopilot general-purpose pod requests (excludes Spot, Balanced, Scale-Out, Performance, GPU)
      const notSpecial = (s) => !/Spot|Balanced|Scale-Out|Performance|GPU|Accelerator|Preemptible/i.test(s.description);
      const apCpu = gcpPick(gke, region, /Autopilot.*(vCPU|CPU) Requests/i).filter(notSpecial)[0];
      const apMem = gcpPick(gke, region, /Autopilot.*Memory Requests/i).filter(notSpecial)[0];
      const pd = gcpPick(compute, region, /^Balanced PD Capacity/, { unit: "GiBy.mo" })[0];
      const egressSkus = compute.filter((s) => s.category?.resourceGroup === "PremiumInternetEgress" &&
        (s.serviceRegions ?? []).includes(region));
      if (!core || !ram || !pd || !egressSkus.length) throw new Error(`${region}: missing N2/PD/egress SKUs`);
      // Several destination SKUs exist; use the one with the highest first paid tier (conservative).
      const egressSku = egressSkus.reduce((best, s) => (gcpRate(s) > gcpRate(best) ? s : best));
      const egressTiers = toTiers(gcpTiers(egressSku).tiers);
      // Autopilot CPU may be priced per mCPU; normalise to per vCPU.
      let apCpuRate = apCpu ? gcpRate(apCpu) : undefined;
      if (apCpu && /mCPU/i.test(apCpu.description)) apCpuRate *= 1000;
      const entry = {
        label: GCP_LABELS[region] ?? region,
        instance: {
          vcpuPerHour: round(gcpRate(core)),
          memGiBPerHour: round(gcpRate(ram)),
          relRmsError: 0,
          family: "Compute Engine N2 core + RAM (on-demand)",
        },
        serverless: apCpu && apMem
          ? { vcpuPerHour: round(apCpuRate), memGiBPerHour: round(gcpRate(apMem)), family: "GKE Autopilot pod requests" }
          : undefined,
        storageGiBPerMonth: round(gcpRate(pd), 4),
        storageProduct: "Balanced PD",
        egressGb: firstPaid(egressTiers),
        egressTiers,
        egressSku: egressSku.description,
      };
      checkBounds(region, { ...entry.instance, storageGiBPerMonth: entry.storageGiBPerMonth, egressGb: entry.egressGb });
      if (entry.serverless) checkBounds(region, entry.serverless);
      out[region] = entry;
    } catch (e) {
      log(`gke ${region} skipped: ${e.message}`);
    }
  }
  if (!Object.keys(out).length) throw new Error("no GKE regions parsed");
  return out;
}

// ---------- main ----------

async function collect(provider, perRegion) {
  const regions = {};
  const errors = [];
  for (const region of REGIONS[provider]) {
    try {
      log(`${provider} ${region}`);
      regions[region] = await perRegion(region);
    } catch (e) {
      errors.push(`${region}: ${e.message}`);
      log(`${provider} ${region} FAILED: ${e.message}`);
    }
  }
  if (!Object.keys(regions).length) throw new Error(errors.join("; "));
  return { regions, errors };
}

const SOURCES = {
  aws: "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/index.json",
  azure: "https://prices.azure.com/api/retail/prices",
  gke: "https://cloudbilling.googleapis.com/v1/services",
};

async function main() {
  let prev = { currency: "USD", providers: {} };
  try {
    prev = JSON.parse(await readFile(OUT, "utf8"));
  } catch {
    log("no previous snapshot");
  }
  const today = new Date().toISOString().slice(0, 10);
  const next = structuredClone(prev);
  next.currency = "USD";
  next.providers ??= {};
  let failed = false;

  const run = async (provider, fn) => {
    if (ONLY && ONLY !== provider) return;
    try {
      const { regions, errors } = await fn();
      const prevRegions = prev.providers?.[provider]?.regions ?? {};
      const changed = JSON.stringify(prevRegions) !== JSON.stringify(regions);
      next.providers[provider] = {
        source: SOURCES[provider],
        fetchedAt: changed ? today : (prev.providers?.[provider]?.fetchedAt ?? today),
        priceType: "public on-demand list price",
        regions,
        ...(errors.length ? { regionErrors: errors } : {}),
      };
      if (errors.length) failed = true;
    } catch (e) {
      failed = true;
      log(`${provider} FAILED, keeping previous data: ${e.message}`);
      if (prev.providers?.[provider]) next.providers[provider] = { ...prev.providers[provider], lastError: e.message };
    }
  };

  await run("aws", () => collect("aws", awsRegion));
  await run("azure", () => collect("azure", azureRegion));
  const gcpKey = process.env.GCP_PRICING_API_KEY;
  if (gcpKey) {
    await run("gke", async () => ({ regions: await gkeAll(gcpKey), errors: [] }));
  } else if (!ONLY || ONLY === "gke") {
    log("GCP_PRICING_API_KEY not set: GKE skipped (previous GKE data, if any, kept)");
  }

  // Only bump the top-level date when rate data changed, so unchanged weeks produce no diff.
  const strip = (s) => JSON.stringify(s.providers);
  next.generatedAt = strip(next) === strip(prev) ? (prev.generatedAt ?? today) : today;
  const body = JSON.stringify(next, null, 2) + "\n";
  if (DRY_RUN) process.stdout.write(body);
  else await writeFile(OUT, body);
  log(`wrote ${DRY_RUN ? "stdout" : OUT.pathname} (${Object.keys(next.providers).join(", ")})`);
  if (failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
