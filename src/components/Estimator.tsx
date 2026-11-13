import type { SizingResult } from "../engine/types";
import { downloadText, helmHintsYaml, resultToCsv, resultToJson } from "../engine/export";

interface Props {
  result: SizingResult;
}

function money(n: number): string {
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function Estimator({ result }: Props) {
  return (
    <div>
      <div className="cards">
        <div className="card">
          <div className="k">Front-door RPS</div>
          <div className="v">{result.demand.frontDoorRps.toFixed(1)}</div>
        </div>
        <div className="card">
          <div className="k">Portal RPS</div>
          <div className="v">{result.demand.portalRps.toFixed(1)}</div>
        </div>
        <div className="card">
          <div className="k">Concurrent sessions</div>
          <div className="v">
            {Math.round(result.sessions.concurrentSessions).toLocaleString()}
          </div>
        </div>
        <div className="card">
          <div className="k">HCL runtime $/mo</div>
          <div className="v">{money(result.costs.hclRuntimeMonth)}</div>
        </div>
        <div className="card">
          <div className="k">Platform $/mo</div>
          <div className="v">{money(result.costs.platformMonth)}</div>
        </div>
        <div className="card">
          <div className="k">License $/mo</div>
          <div className="v">{money(result.costs.licenseMonth)}</div>
        </div>
        <div className="card">
          <div className="k">AI tokens $/mo</div>
          <div className="v">{money(result.costs.tokenMonth + result.costs.llmInfraMonth)}</div>
        </div>
        <div className="card">
          <div className="k">Total $/mo</div>
          <div className="v">{money(result.costs.totalMonth)}</div>
        </div>
        <div className="card">
          <div className="k">Confidence</div>
          <div className="v" style={{ fontSize: "1rem" }}>
            {result.confidence}
          </div>
        </div>
      </div>

      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="section">
        <h2>Session / HCL pod floors</h2>
        <p className="muted">
          Concurrent {Math.round(result.sessions.concurrentSessions).toLocaleString()} ·{" "}
          {Math.round(result.sessions.sessionsPerDay).toLocaleString()}/day · footprint{" "}
          {result.sessions.sessionFootprintMi.toFixed(0)} Mi · timeout{" "}
          {result.sessions.recommendedTimeoutMin} min · sticky sessions for HAProxy
          {result.sessions.podCpu != null && (
            <>
              {" "}
              · HCL Core/WE floor {result.sessions.podCpu} CPU /{" "}
              {result.sessions.podMemoryGi}Gi (heap {result.sessions.jvmHeapGi}
              Gi, Xms=Xmx)
            </>
          )}
        </p>
        <p className="muted">
          Ref:{" "}
          <a href={result.hclDocUrl} target="_blank" rel="noreferrer">
            HCL DX Compose K8s sizing guide
          </a>
        </p>
      </div>

      <div className="legend-row">
        <span className="plane-tag hcl">HCL DX</span>
        <span className="plane-tag platform">Platform / cloud</span>
        <span className="plane-tag client">Client / edge</span>
      </div>

      <div className="btn-row">
        <button
          type="button"
          className="btn primary"
          onClick={() =>
            downloadText(
              `dx-sizing-${result.product}.json`,
              resultToJson(result),
              "application/json",
            )
          }
        >
          Export JSON
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            downloadText(
              `dx-sizing-${result.product}.csv`,
              resultToCsv(result),
              "text/csv",
            )
          }
        >
          Export CSV
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            downloadText(
              `dx-helm-hints-${result.product}.yaml`,
              helmHintsYaml(result.helmHints),
              "text/yaml",
            )
          }
        >
          Helm resource hints
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard.writeText(helmHintsYaml(result.helmHints));
          }}
        >
          Copy Helm hints
        </button>
      </div>

      <div className="section" style={{ marginTop: 16 }}>
        <h2>BOM — {result.profileId}</h2>
        <table className="bom">
          <thead>
            <tr>
              <th>Plane</th>
              <th>Component</th>
              <th>Rep</th>
              <th>Offered</th>
              <th>Cap</th>
              <th>Util</th>
              <th>CPU</th>
              <th>Mem Gi</th>
              <th>Stor Gi</th>
              <th>Infra $</th>
              <th>Lic $</th>
            </tr>
          </thead>
          <tbody>
            {result.nodes.map((n) => (
              <tr key={n.id} className={`row-plane-${n.plane}`}>
                <td>
                  <span className={`plane-tag ${n.plane}`}>
                    {n.plane === "hcl"
                      ? "HCL"
                      : n.plane === "platform"
                        ? "Plat"
                        : "Edge"}
                  </span>
                </td>
                <td>
                  <span
                    className={`band ${n.utilBand === "n/a" ? "na" : n.utilBand}`}
                  />
                  {n.label}
                </td>
                <td>{n.replicas}</td>
                <td>{n.offeredRps.toFixed(1)}</td>
                <td>{n.capacityRps > 1e5 ? "—" : n.capacityRps.toFixed(0)}</td>
                <td>
                  {n.utilBand === "n/a" ? "—" : `${(n.util * 100).toFixed(0)}%`}
                </td>
                <td>{n.cpuCores.toFixed(2)}</td>
                <td>{n.memGi.toFixed(1)}</td>
                <td>{n.storageGi.toFixed(1)}</td>
                <td>{n.infraCostMonth.toFixed(0)}</td>
                <td>{n.licenseCostMonth.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="disclaimer">
        Estimation aid only — not an HCL official SCU or sizing guarantee. Profile{" "}
        {result.profileId}. Calibrate with Locust on your lab before production claims.
      </p>
    </div>
  );
}
