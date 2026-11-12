import { useMemo, useState } from "react";
import {
  compareEstimateVsLive,
  defaultNameMap,
  parseKubectlTop,
} from "../engine/liveCompare";
import type { LiveUtilRow, SizingResult } from "../engine/types";

interface Props {
  result: SizingResult;
}

const SAMPLE = `NAME                                CPU(cores)   MEMORY(bytes)
dx-deployment-core-0                1800m        5120Mi
dx-deployment-core-1                1600m        4800Mi
haproxy-0                           250m         300Mi
haproxy-1                           220m         280Mi`;

export function LiveComparePanel({ result }: Props) {
  const [text, setText] = useState(SAMPLE);
  const [live, setLive] = useState<LiveUtilRow[]>([]);

  const rows = useMemo(
    () => compareEstimateVsLive(result.nodes, live),
    [result.nodes, live],
  );

  return (
    <div>
      <div className="section">
        <h2>Import kubectl top / AIOps summary</h2>
        <p className="muted">
          Paste <code>kubectl top pods</code> output. Names are matched via
          substring map (core, haproxy, dam, …). Compares observed CPU/mem vs
          estimate.
        </p>
        <textarea
          className="mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="btn-row">
          <button
            type="button"
            className="btn primary"
            onClick={() => setLive(parseKubectlTop(text, defaultNameMap))}
          >
            Compare vs estimate
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setText(SAMPLE);
              setLive([]);
            }}
          >
            Reset sample
          </button>
        </div>
      </div>

      {live.length > 0 && (
        <div className="section">
          <h2>Estimate vs live</h2>
          <table className="bom">
            <thead>
              <tr>
                <th>Component</th>
                <th>Est CPU</th>
                <th>Obs CPU</th>
                <th>Δ CPU%</th>
                <th>Est Mem</th>
                <th>Obs Mem</th>
                <th>Δ Mem%</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.componentId}>
                  <td>{r.label}</td>
                  <td>{r.estimatedCpu.toFixed(2)}</td>
                  <td>{r.observedCpu.toFixed(2)}</td>
                  <td>{r.status === "missing" ? "—" : r.cpuDeltaPct.toFixed(0)}</td>
                  <td>{r.estimatedMemGi.toFixed(1)}</td>
                  <td>{r.observedMemGi.toFixed(1)}</td>
                  <td>{r.status === "missing" ? "—" : r.memDeltaPct.toFixed(0)}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
