import type { ChangeEvent, ReactNode } from "react";
import type { CloudProvider } from "../engine/cloudProviders";
import { cloudProviders } from "../engine/cloudProviders";
import type { ComponentToggles, Product, UnitCosts, UsageInputs } from "../engine/types";
import { getCatalog } from "../catalogs";
import { scenarioPresets, applyScenario } from "../scenarios";

interface Props {
  product: Product;
  inputs: UsageInputs;
  toggles: ComponentToggles;
  costs: UnitCosts;
  cloudProvider: CloudProvider;
  onInputs: (v: UsageInputs) => void;
  onToggles: (v: ComponentToggles) => void;
  onCosts: (v: UnitCosts) => void;
}

function num(
  inputs: UsageInputs,
  key: keyof UsageInputs,
  onInputs: (v: UsageInputs) => void,
) {
  return (e: ChangeEvent<HTMLInputElement>) => {
    onInputs({ ...inputs, [key]: Number(e.target.value) });
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <label>{label}</label>
        <span className="field-hint">{hint}</span>
      </div>
      {children}
    </div>
  );
}

const TOGGLE_HINTS: Partial<Record<string, string>> = {
  openLdap: "Lab LDAP; Core/webEngine binds directly (not via HAProxy)",
  externalIdp: "OIDC/SAML: browser→IdP redirect + Core/webEngine→IdP APIs",
  remoteSearch: "Classic DXCN search path (not Compose)",
  contentComposer: "Authoring UI; forces Ring API",
  ringApi: "API gateway for DAM / CC",
  dam: "Binary/API assets; forces Ring + image + persistence",
  imageProcessor: "Renditions (~20% of DAM GETs)",
  persistencePool: "DAM DB connection pool",
  persistenceNode: "DAM Postgres node",
  persistenceMetrics: "DAM metrics sidecar/exporter",
  damPluginGoogleVision: "Extra DAM CPU for Vision",
  damPluginKaltura: "Extra DAM CPU for Kaltura",
  searchMiddleware: "Search V2 entry; enables OS + FP",
  openSearch: "Search V2 index / query tier",
  fileProcessor: "Search V2 indexing jobs",
  licenseManager: "Fixed small control-plane pod",
  peopleService: "People directory traffic class",
  iqIntegrator: "AI chat path; token OpEx; forces MCP",
  mcpService: "Tool calls for IQ agents",
  dnsGslb: "DNS / global load balancing",
  waf: "Origin WAF (after CDN miss)",
  cloudLb: "Cloud L7/L4 load balancer into K8s",
  dxDbSecondary: "DX DB failover / sync standby",
  rwxStorage:
    "RWX shared FS — required for DXCN Core; Compose webEngine never; DAM needs it",
  objectStorage: "S3/Blob/GCS for DAM binaries",
  redis: "Optional session/cache",
  secretsKms: "Secrets manager + KMS",
  observability: "Metrics / logs / traces stack",
  backupDr: "Backup + DR snapshots",
  containerRegistry: "Private image registry",
  egressNat: "Private-cluster egress",
};

export function InputForm({
  product,
  inputs,
  toggles,
  costs,
  cloudProvider,
  onInputs,
  onToggles,
  onCosts,
}: Props) {
  const catalog = getCatalog(product);
  const cloud = cloudProviders[cloudProvider];
  const hclOptionals = catalog.nodes.filter(
    (n) => n.optionalKey && n.plane === "hcl",
  );
  const platformOptionals = catalog.nodes.filter(
    (n) => n.optionalKey && n.plane === "platform",
  );

  return (
    <>
      <div className="section">
        <h2>Cloud & production</h2>
        <p className="field-hint" style={{ marginBottom: 8 }}>
          Provider: <strong>{cloud.label}</strong> — SKUs label platform nodes
        </p>
        <label className="toggle" style={{ marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={!!inputs.productionPlatform}
            onChange={(e) =>
              onInputs({ ...inputs, productionPlatform: e.target.checked })
            }
          />
          <span>
            Production platform plane
            <span className="toggle-hint">
              Forces origin WAF + Cloud LB + DB secondary + secrets/obs/backup
              (CDN → WAF → LB → HAProxy)
            </span>
          </span>
        </label>
      </div>

      <div className="section">
        <h2>Scenarios</h2>
        <div className="preset-row">
          {scenarioPresets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="btn"
              title={p.description}
              onClick={() => {
                const next = applyScenario(product, inputs, toggles, p);
                onInputs(next.inputs);
                onToggles(next.toggles);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="section">
        <h2>Must-have metrics</h2>
        <Field
          label="Peak concurrent users"
          hint="Simultaneous sessions at peak — drives Core heap & replica floor"
        >
          <input
            type="number"
            value={inputs.peakConcurrentUsers}
            onChange={num(inputs, "peakConcurrentUsers", onInputs)}
          />
        </Field>
        <Field
          label="DAU"
          hint="Daily active users — unique visitors per day; feeds sessions/day & tokens"
        >
          <input type="number" value={inputs.dau} onChange={num(inputs, "dau", onInputs)} />
        </Field>
        <Field
          label="MAU"
          hint="Monthly active users — unique visitors per month; growth / reach context"
        >
          <input type="number" value={inputs.mau} onChange={num(inputs, "mau", onInputs)} />
        </Field>
        <Field
          label="Peak RPS override (0=derive)"
          hint="If >0, replaces derived front-door RPS from users × req / session"
        >
          <input
            type="number"
            value={inputs.peakRpsOverride}
            onChange={num(inputs, "peakRpsOverride", onInputs)}
          />
        </Field>
        <Field
          label="Req / session"
          hint="Avg HTTP requests per user session (page views + APIs)"
        >
          <input
            type="number"
            value={inputs.reqPerSession}
            onChange={num(inputs, "reqPerSession", onInputs)}
          />
        </Field>
        <Field
          label="Session duration (min)"
          hint="Avg logged-in/browse length; converts users → RPS"
        >
          <input
            type="number"
            value={inputs.sessionDurationMin}
            onChange={num(inputs, "sessionDurationMin", onInputs)}
          />
        </Field>
        <Field
          label="% anonymous"
          hint="Share of traffic with no login — lower auth tax"
        >
          <input
            type="number"
            value={inputs.pctAnonymous}
            onChange={num(inputs, "pctAnonymous", onInputs)}
          />
        </Field>
        <Field
          label="% authenticated"
          hint="Share that logs in — LDAP binds / IdP redirects + back-channel from Core"
        >
          <input
            type="number"
            value={inputs.pctAuthenticated}
            onChange={num(inputs, "pctAuthenticated", onInputs)}
          />
        </Field>
        <Field
          label="% browse / author / form"
          hint="Traffic mix: read WCM · Content Composer · POST/forms"
        >
          <span style={{ display: "flex", gap: 4 }}>
            <input
              style={{ width: 48 }}
              type="number"
              value={inputs.pctBrowse}
              onChange={num(inputs, "pctBrowse", onInputs)}
            />
            <input
              style={{ width: 48 }}
              type="number"
              value={inputs.pctAuthor}
              onChange={num(inputs, "pctAuthor", onInputs)}
            />
            <input
              style={{ width: 48 }}
              type="number"
              value={inputs.pctFormPost}
              onChange={num(inputs, "pctFormPost", onInputs)}
            />
          </span>
        </Field>
        <Field
          label="Search attach rate"
          hint="Fraction of portal requests that fan out to search (0–1)"
        >
          <input
            type="number"
            step="0.05"
            value={inputs.searchAttachRate}
            onChange={num(inputs, "searchAttachRate", onInputs)}
          />
        </Field>
        <Field
          label="DAM attach rate"
          hint="Fraction of portal requests that hit DAM APIs (0–1)"
        >
          <input
            type="number"
            step="0.05"
            value={inputs.damAttachRate}
            onChange={num(inputs, "damAttachRate", onInputs)}
          />
        </Field>
        <Field
          label="Assets / page"
          hint="Avg DAM assets requested when a page hits DAM"
        >
          <input
            type="number"
            value={inputs.assetsPerPage}
            onChange={num(inputs, "assetsPerPage", onInputs)}
          />
        </Field>
        <Field
          label="AZ count"
          hint="Availability zones — HA replica floor ≥ this"
        >
          <input type="number" value={inputs.azCount} onChange={num(inputs, "azCount", onInputs)} />
        </Field>
        <Field
          label="Target p95 (ms)"
          hint="Portal latency SLO — context for headroom (not hard-coded yet)"
        >
          <input
            type="number"
            value={inputs.targetP95Ms}
            onChange={num(inputs, "targetP95Ms", onInputs)}
          />
        </Field>
        <Field
          label="Cache hit ratio"
          hint="CDN/portal cache hits (0–1); largest lever on Core RPS"
        >
          <input
            type="number"
            step="0.05"
            min={0}
            max={1}
            value={inputs.cacheHitRatio}
            onChange={num(inputs, "cacheHitRatio", onInputs)}
          />
        </Field>
      </div>

      <details className="advanced">
        <summary>Advanced metrics</summary>
        <Field
          label="Think time (sec)"
          hint="Idle between clicks — realism for concurrent→RPS (informational)"
        >
          <input
            type="number"
            value={inputs.thinkTimeSec}
            onChange={num(inputs, "thinkTimeSec", onInputs)}
          />
        </Field>
        <Field
          label="Searches / hit"
          hint="Queries issued when a session attaches to search"
        >
          <input
            type="number"
            step="0.1"
            value={inputs.searchesPerHit}
            onChange={num(inputs, "searchesPerHit", onInputs)}
          />
        </Field>
        <Field
          label="Peak authoring users"
          hint="Concurrent Content Composer users at peak"
        >
          <input
            type="number"
            value={inputs.peakAuthoringUsers}
            onChange={num(inputs, "peakAuthoringUsers", onInputs)}
          />
        </Field>
        <Field
          label="Uploads / day"
          hint="DAM binary ingest rate — drives storage GB/mo"
        >
          <input
            type="number"
            value={inputs.uploadsPerDay}
            onChange={num(inputs, "uploadsPerDay", onInputs)}
          />
        </Field>
        <Field
          label="Avg upload MB"
          hint="Mean upload size for DAM storage estimate"
        >
          <input
            type="number"
            value={inputs.avgUploadMb}
            onChange={num(inputs, "avgUploadMb", onInputs)}
          />
        </Field>
        <Field
          label="Content items"
          hint="WCM/library size — seeds search index GB"
        >
          <input
            type="number"
            value={inputs.contentItems}
            onChange={num(inputs, "contentItems", onInputs)}
          />
        </Field>
        <Field
          label="IQ attach rate"
          hint="Share of sessions using IQ chat (0–1); own traffic class"
        >
          <input
            type="number"
            step="0.05"
            value={inputs.iqAttachRate}
            onChange={num(inputs, "iqAttachRate", onInputs)}
          />
        </Field>
        <Field
          label="IQ msgs / session"
          hint="Chat turns per IQ session — drives IQ RPS & tokens"
        >
          <input
            type="number"
            value={inputs.iqMsgsPerSession}
            onChange={num(inputs, "iqMsgsPerSession", onInputs)}
          />
        </Field>
        <Field
          label="IQ tokens in/out"
          hint="Avg prompt / completion tokens per IQ turn"
        >
          <span style={{ display: "flex", gap: 4 }}>
            <input
              style={{ width: 64 }}
              type="number"
              value={inputs.iqTokensIn}
              onChange={num(inputs, "iqTokensIn", onInputs)}
            />
            <input
              style={{ width: 64 }}
              type="number"
              value={inputs.iqTokensOut}
              onChange={num(inputs, "iqTokensOut", onInputs)}
            />
          </span>
        </Field>
        <Field
          label="Growth CAGR"
          hint="Capacity buffer (e.g. 0.15 = +15% demand)"
        >
          <input
            type="number"
            step="0.01"
            value={inputs.growthCagr}
            onChange={num(inputs, "growthCagr", onInputs)}
          />
        </Field>
        <Field
          label="Session footprint (KB)"
          hint="HTTP session size in Core/webEngine memory math"
        >
          <input
            type="number"
            value={inputs.sessionBytesKb}
            onChange={num(inputs, "sessionBytesKb", onInputs)}
          />
        </Field>
      </details>

      <div className="section" style={{ marginTop: 14 }}>
        <h2>HCL DX components</h2>
        <div className="toggle-grid">
          {hclOptionals.map((n) => {
            const key = n.optionalKey!;
            const disabled = product === "compose" && key === "remoteSearch";
            return (
              <label key={n.id} className="toggle plane-hcl">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={!!toggles[key]}
                  onChange={(e) =>
                    onToggles({ ...toggles, [key]: e.target.checked })
                  }
                />
                <span>
                  {n.label}
                  {TOGGLE_HINTS[key] && (
                    <span className="toggle-hint">{TOGGLE_HINTS[key]}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="section" style={{ marginTop: 14 }}>
        <h2>Platform / cloud components</h2>
        <p className="field-hint" style={{ marginBottom: 6 }}>
          RWX: on for DXCN Core always; Compose webEngine never; DAM forces RWX
          on both.
        </p>
        <div className="toggle-grid">
          {platformOptionals.map((n) => {
            const key = n.optionalKey!;
            const forcedRwx =
              (product === "dxcn" && key === "rwxStorage") ||
              (!!toggles.dam && key === "rwxStorage");
            const blockedRwx =
              product === "compose" && !toggles.dam && key === "rwxStorage";
            return (
              <label key={n.id} className="toggle plane-platform">
                <input
                  type="checkbox"
                  disabled={forcedRwx || blockedRwx}
                  checked={
                    blockedRwx ? false : forcedRwx ? true : !!toggles[key]
                  }
                  onChange={(e) =>
                    onToggles({ ...toggles, [key]: e.target.checked })
                  }
                />
                <span>
                  {n.label}
                  {cloud.skus[n.id] ? (
                    <span className="toggle-hint">{cloud.skus[n.id]}</span>
                  ) : (
                    TOGGLE_HINTS[key] && (
                      <span className="toggle-hint">{TOGGLE_HINTS[key]}</span>
                    )
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <details className="advanced">
        <summary>Unit costs</summary>
        <Field
          label="$ / vCPU-hour"
          hint="Cloud/on-prem vCPU rate for infra $/mo"
        >
          <input
            type="number"
            step="0.001"
            value={costs.vcpuPerHour}
            onChange={(e) =>
              onCosts({ ...costs, vcpuPerHour: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="$ / GiB-hour"
          hint="Memory GiB-hour unit price"
        >
          <input
            type="number"
            step="0.001"
            value={costs.memGiBPerHour}
            onChange={(e) =>
              onCosts({ ...costs, memGiBPerHour: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="$ / GiB storage-mo"
          hint="Block/object storage per GiB-month"
        >
          <input
            type="number"
            step="0.01"
            value={costs.storageGiBPerMonth}
            onChange={(e) =>
              onCosts({ ...costs, storageGiBPerMonth: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="$ / 1K tokens"
          hint="LLM API price for IQ token OpEx"
        >
          <input
            type="number"
            step="0.0001"
            value={costs.tokensPer1k}
            onChange={(e) =>
              onCosts({ ...costs, tokensPer1k: Number(e.target.value) })
            }
          />
        </Field>
        <Field
          label="DX license $/node-mo"
          hint="Placeholder DX seat/node cost (kept separate from infra)"
        >
          <input
            type="number"
            value={costs.dxLicensePerNodeMonth}
            onChange={(e) =>
              onCosts({
                ...costs,
                dxLicensePerNodeMonth: Number(e.target.value),
              })
            }
          />
        </Field>
        <Field
          label="Self-host LLM RAM GiB"
          hint="Ollama-class RAM reserved when IQ is on"
        >
          <input
            type="number"
            value={costs.selfHostLlmRamGiB}
            onChange={(e) =>
              onCosts({
                ...costs,
                selfHostLlmRamGiB: Number(e.target.value),
              })
            }
          />
        </Field>
      </details>
    </>
  );
}
