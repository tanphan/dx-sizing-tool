# HCL DX Sizing / Estimation Tool

Local Vite + React app: **Estimator** (BOM / cost / sessions) + **Simulator** (topology, edge RPS, util colors, load slider). Product switch: **DXCN** | **DX Compose**. Shared TypeScript sizing engine.

> Estimation aid — not an HCL official SCU.

## Live (GitHub Pages)

https://tanphan.github.io/dx-sizing-tool/

Hosted via GitHub Actions Pages from this public repo.

## Run locally

```bash
cd dx-sizing-tool
npm install
npm run dev -- --host 0.0.0.0
```

```bash
npm test
npm run build
# Pages-base preview:
# VITE_BASE=/dx-sizing-tool/ npm run build && npx vite preview --base /dx-sizing-tool/
```

## Docs

- [docs/SPEC.md](docs/SPEC.md): sizing model, formulas, assumption sources, backlog
- [CLAUDE.md](CLAUDE.md): contributor / Claude Code guide (commands, rules for engine changes)
- [docs/HCL-DX-Sizing-Tool-User-Guide.pdf](docs/HCL-DX-Sizing-Tool-User-Guide.pdf): user guide

## Layout

- `src/engine/` — pure sizing kernel (`normalizeInputs`, `runSizing`, Helm hints, Locust calibrate, live compare)
- `src/catalogs/` — DXCN / Compose topology + toggle forcing
- `src/profiles/` — CF-tagged capacity JSON (`dxcn-cf238`, `compose-cf237`)
- `src/components/` — Estimator, Simulator, Calibrate, Live panels

## Cloud pricing

Unit prices come from a committed snapshot of **public on-demand list prices** ([src/pricing/snapshot.json](src/pricing/snapshot.json)) per provider and region: AWS (Price List bulk files) and Azure (Retail Prices API) need no login; GKE needs a Cloud Billing Catalog API key. Pick the region and compute basis (node-pool VMs or serverless pods) in the sidebar, and enter cloud / enterprise discount %. Editing a rate switches to custom prices.

```bash
npm run pricing:fetch                          # AWS + Azure (≈ 3–10 min)
GCP_PRICING_API_KEY=<API_KEY> npm run pricing:fetch -- --provider gke
```

List prices exclude negotiated rates, the control-plane fee, managed services, support and taxes. Treat totals as estimates, not quotes. See SPEC §6.5.

## Auth topology note

External IdP (OIDC/SAML) is **not** behind HAProxy: browser → IdP redirect, then Core/webEngine → IdP back-channel (token/JWKS). OpenLDAP binds are Core/webEngine → LDAP. Login callback/ACS returns as portal traffic via HAProxy.

## RWX / production platform

- **DXCN Core** always requires **RWX** shared storage.
- **Compose webEngine** does **not** use RWX.
- **DAM** (either product) forces RWX when enabled.
- Production plane: CDN miss → **origin WAF** → Cloud LB → HAProxy (AWS / Azure / GKE / RHOS SKUs).
- Core/webEngine CPU/mem floors follow the [HCL DX Compose K8s sizing guide (CF239)](https://help.hcl-software.com/digital-experience/dx-compose/CF239/guide_me/performance_tuning/kubernetes/) (5.6 CPU, 8Gi pod, heap 4Gi Xms=Xmx).

Simulator: **blue** = HCL DX · **gold dashed** = platform/cloud · **pill** = client/edge.

## Calibration

1. Run Locust scenarios on lab; capture RPS + CPU per component.
2. Paste JSON in **Calibrate** tab (see `scripts/sample-locust-measurements.json`).
3. Profile registers as `*-lab` with `confidence: lab-calibrated`.

Helm-ish `scaling` / `resources` hints export from the BOM (Estimator or Calibrate).

## Live compare

Paste `kubectl top pods` into **Live vs est**; names matched via substring map.
