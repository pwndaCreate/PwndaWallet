import { ST } from "../../components/Primitives";
import { Card } from "../../components/PrimitivesV2";
import type { XelisNodesApi } from "./useXelisNodes";

/**
 * Settings ▸ Xelis Nodes. Counterpart of `ZanoNodesView`, mounted by portrait
 * `ViewRouter` and landscape `LandscapeRoot` (view id `"xelis-nodes"`).
 */
export function XelisNodesView({
  nodes,
  onBack,
}: {
  nodes: XelisNodesApi;
  onBack: () => void;
}) {
  const {
    nodeResults,
    nodeTesting,
    pinnedNode,
    customNodeInput,
    setCustomNodeInput,
    nodeBusy,
    activePool,
    testAll,
    pinNode,
    clearPin,
    pinCustomNode,
    getActiveDaemon,
  } = nodes;
  const liveDaemon = getActiveDaemon();

  return (
    <div className="settings-view">
      <div className="mining-header">
        <button className="btn-icon" onClick={onBack} title="Back">
          ► Back
        </button>
        <h2><ST delay={0} speed={22}>XELIS NODES</ST></h2>
      </div>

      <Card>
        <p className="hint">
          The Xelis wallet reads the chain through a remote node. That node sees
          your IP address and which account you query; balances on the Xelis
          chain are encrypted, so it cannot read amounts. The list below holds
          the XELIS project's public node. If you run your own node, add it
          below and pin it.
        </p>
        <div className="button-row" style={{ marginTop: "12px" }}>
          <button className="btn-primary" onClick={() => void testAll()} disabled={nodeTesting}>
            {nodeTesting ? "Testing…" : "► Test All Nodes"}
          </button>
          {pinnedNode && (
            <button className="btn-secondary" onClick={() => void clearPin()}>
              Clear Pin (auto-pick)
            </button>
          )}
        </div>
        {pinnedNode && (
          <p className="hint" style={{ marginTop: "8px" }}>
            Currently pinned: <code>{pinnedNode}</code>
          </p>
        )}
        {liveDaemon && (
          <p className="hint">
            Open wallet's node: <code>{liveDaemon}</code>
          </p>
        )}
      </Card>

      <Card title="NODES">
        <table className="node-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px" }}>Operator</th>
              <th style={{ textAlign: "left", padding: "6px" }}>URL</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Latency</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Topoheight</th>
              <th style={{ textAlign: "center", padding: "6px" }}>Status</th>
              <th style={{ textAlign: "right", padding: "6px" }}></th>
            </tr>
          </thead>
          <tbody>
            {[...activePool]
              .sort((a, b) => {
                const ra = nodeResults.find((r) => r.url === a.url);
                const rb = nodeResults.find((r) => r.url === b.url);
                const la = ra?.ok && ra.latencyMs != null ? ra.latencyMs : Number.POSITIVE_INFINITY;
                const lb = rb?.ok && rb.latencyMs != null ? rb.latencyMs : Number.POSITIVE_INFINITY;
                if (la !== lb) return la - lb;
                return a.operator.localeCompare(b.operator);
              })
              .map((node) => {
                const result = nodeResults.find((r) => r.url === node.url);
                const isPinned = pinnedNode === node.url;
                const isBusy = nodeBusy === node.url;
                let statusLabel = "—";
                let statusColor = "#888";
                if (nodeTesting && !result) {
                  statusLabel = "…";
                } else if (result?.ok) {
                  statusLabel = "OK";
                  statusColor = "#2ecc71";
                } else if (result && !result.ok) {
                  statusLabel = result.error ?? "fail";
                  statusColor = "#e74c3c";
                }
                return (
                  <tr
                    key={node.url}
                    style={{
                      borderTop: "1px solid #333",
                      background: isPinned ? "rgba(2,255,207,0.06)" : undefined,
                    }}
                  >
                    <td style={{ padding: "6px" }}>{node.operator}</td>
                    <td style={{ padding: "6px", fontFamily: "monospace", fontSize: "0.85em" }}>
                      {node.url}
                    </td>
                    <td style={{ padding: "6px", textAlign: "right" }}>
                      {result?.latencyMs != null ? `${result.latencyMs}ms` : "—"}
                    </td>
                    <td style={{ padding: "6px", textAlign: "right" }}>
                      {result?.height != null ? result.height.toLocaleString() : "—"}
                    </td>
                    <td style={{ padding: "6px", textAlign: "center", color: statusColor }}>
                      {statusLabel}
                    </td>
                    <td style={{ padding: "6px", textAlign: "right" }}>
                      {isPinned ? (
                        <span style={{ color: "#3ab0ff", fontWeight: "bold" }}>PINNED</span>
                      ) : (
                        <button
                          className="btn-icon"
                          onClick={() => void pinNode(node.url)}
                          disabled={isBusy || nodeTesting}
                        >
                          {isBusy ? "…" : "Use"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </Card>

      <Card title="CUSTOM NODE">
        <p className="hint">
          Paste the full URL of a Xelis node (for example{" "}
          <code>https://node.example.org</code>). It is probed before it is pinned.
        </p>
        <div className="form-group">
          <input
            type="text"
            placeholder="https://host:port"
            value={customNodeInput}
            onChange={(e) => setCustomNodeInput(e.target.value)}
          />
        </div>
        <button
          className="btn-primary"
          onClick={() => void pinCustomNode()}
          disabled={nodeBusy != null || !customNodeInput.trim()}
        >
          {nodeBusy ? "Probing…" : "► Probe & Pin Custom Node"}
        </button>
      </Card>
    </div>
  );
}
