export type CloudProvider = "aws" | "azure" | "gke" | "rhos";

export interface CloudProviderInfo {
  id: CloudProvider;
  label: string;
  short: string;
  /** Display names for platform nodes */
  skus: Record<string, string>;
  /** Soft cost multipliers vs baseline unit costs */
  costMult: { vcpu: number; mem: number; storage: number; egress: number };
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
    costMult: { vcpu: 1, mem: 1, storage: 1, egress: 1.1 },
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
    costMult: { vcpu: 1.02, mem: 1, storage: 0.95, egress: 1 },
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
    costMult: { vcpu: 0.98, mem: 1, storage: 1, egress: 1.05 },
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
    costMult: { vcpu: 1.15, mem: 1.1, storage: 1.05, egress: 1 },
  },
};

export const cloudProviderList = Object.values(cloudProviders);
