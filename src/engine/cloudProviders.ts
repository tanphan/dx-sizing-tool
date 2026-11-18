export type CloudProvider = "aws" | "azure" | "gke" | "rhos";

/** Price book key (src/pricing/snapshot.json). OpenShift uses AWS rates (ROSA). */
export type PricingProvider = "aws" | "azure" | "gke";

export interface CloudProviderInfo {
  id: CloudProvider;
  label: string;
  short: string;
  /** Display names for platform nodes */
  skus: Record<string, string>;
  /** Which price book entry supplies list prices (see engine/pricing.ts) */
  pricingProvider: PricingProvider;
  /** Extra caveat shown with the price source */
  pricingNote?: string;
}

export const cloudProviders: Record<CloudProvider, CloudProviderInfo> = {
  aws: {
    id: "aws",
    label: "Amazon Web Services (EKS)",
    short: "AWS",
    skus: {
      dnsGslb: "Route 53 / GSLB",
      waf: "AWS WAF (origin)",
      cloudLb: "ALB / NLB",
      dxDbSecondary: "RDS Multi-AZ standby",
      rwxStorage: "EFS (RWX)",
      objectStorage: "S3",
      redis: "ElastiCache Redis",
      secretsKms: "Secrets Manager + KMS",
      observability: "CloudWatch / AMP+AMG",
      backupDr: "AWS Backup / Velero",
      containerRegistry: "ECR",
      egressNat: "NAT Gateway",
    },
    pricingProvider: "aws",
  },
  azure: {
    id: "azure",
    label: "Microsoft Azure (AKS)",
    short: "Azure",
    skus: {
      dnsGslb: "Azure DNS / Traffic Manager",
      waf: "Azure WAF (origin)",
      cloudLb: "App Gateway / Azure LB",
      dxDbSecondary: "Flexible Server HA / SQL HA",
      rwxStorage: "Azure Files (RWX)",
      objectStorage: "Blob Storage",
      redis: "Azure Cache for Redis",
      secretsKms: "Key Vault",
      observability: "Azure Monitor / Grafana",
      backupDr: "Azure Backup / Velero",
      containerRegistry: "ACR",
      egressNat: "NAT Gateway",
    },
    pricingProvider: "azure",
  },
  gke: {
    id: "gke",
    label: "Google Cloud (GKE)",
    short: "GKE",
    skus: {
      dnsGslb: "Cloud DNS / Cloud CDN GSLB",
      waf: "Cloud Armor (origin)",
      cloudLb: "Global/Regional HTTPS LB",
      dxDbSecondary: "Cloud SQL HA standby",
      rwxStorage: "Filestore (RWX)",
      objectStorage: "GCS",
      redis: "Memorystore Redis",
      secretsKms: "Secret Manager + Cloud KMS",
      observability: "Cloud Monitoring / Managed Prometheus",
      backupDr: "Backup for GKE / Velero",
      containerRegistry: "Artifact Registry",
      egressNat: "Cloud NAT",
    },
    pricingProvider: "gke",
  },
  rhos: {
    id: "rhos",
    label: "Red Hat OpenShift (ROSA / self-managed)",
    short: "RHOS",
    skus: {
      dnsGslb: "External DNS / Global LB",
      waf: "WAF (ACS / partner, origin)",
      cloudLb: "OpenShift Router / cloud LB",
      dxDbSecondary: "External DB HA standby",
      rwxStorage: "OCS/ODF CephFS (RWX)",
      objectStorage: "NooBaa / RGW / cloud bucket",
      redis: "Redis (operator)",
      secretsKms: "Vault / cloud KMS",
      observability: "OpenShift Monitoring + logging",
      backupDr: "OADP / Velero",
      containerRegistry: "OpenShift internal registry / Quay",
      egressNat: "Egress IP / cloud NAT",
    },
    pricingProvider: "aws",
    pricingNote:
      "OpenShift uses AWS (ROSA) infrastructure list prices. The Red Hat subscription / ROSA service fee is not included; add it under DX license $/node-mo or as custom unit costs.",
  },
};

export const cloudProviderList = Object.values(cloudProviders);
