import { ST } from "../../components/Primitives";
import { Card } from "../../components/PrimitivesV2";
import type { useZanoNodes } from "./useZanoNodes";

type NodesApi = ReturnType<typeof useZanoNodes>;

export function ZanoNodesView({
  nodes,
  onBack,
}: {
  nodes: NodesApi;
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
    useNode,
    clearPin,
    useCustomNode,
    getActiveDaemon,
  } = nodes;

  return (
    <div className="settings-view">
      <div className="mining-header">
        <button className="btn-icon" onClick={onBack} title="Back">
          ► Back
        </button>
        <h2><ST delay={0} speed={22}>ZANO NODES</ST></h2>
      </div>

      <Card>
        {/* Honest inventory, not invented decentralization: Zano publishes
            exactly ONE node (docs.zano.org/docs/build/public-nodes), flagged
            upstream as dev-grade / "not for production". A survey for a
            second option (2026-08-27) found none — see
            zano-integration-plan.md §3. */}
        <p className="hint">
          Zano publishes exactly one official remote node, and it's explicitly
          marked as a development tool rather than production-grade. If you
          run your own Zano node, add it below and pin it — that's the more
          reliable path than relying on the default.
        </p>
        <div className="button-row" style={{ marginTop: "12px" }}>
          <button
            className="btn-primary"
            onClick={testAll}
            disabled={nodeTesting}
          >
            {nodeTesting ? "Testing…" : "► Test All Nodes"}
          </button>
          {pinnedNode && (
            <button className="btn-secondary" onClick={clearPin}>
              Clear Pin (auto-pick)
            </button>
          )}
        </div>
        {pinnedNode && (
          <p className="hint" style={{ marginTop: "8px" }}>
            Currently pinned: <code>{pinnedNode}</code>
          </p>
        )}
        {getActiveDaemon() && (
          <p className="hint">
            Live session daemon: <code>{getActiveDaemon()}</code>
          </p>
        )}
      </Card>

      <Card title="TRUSTED NODES">
        <table className="node-table" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px" }}>Operator</th>
              <th style={{ textAlign: "left", padding: "6px" }}>URL</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Latency</th>
              <th style={{ textAlign: "right", padding: "6px" }}>Height</th>
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
                  statusColor = "#888";
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
                      background: isPinned ? "rgba(14,14,16,0.12)" : undefined,
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
                          onClick={() => useNode(node.url)}
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
          Have your own Zano node, or want to use one not in the trusted list?
          Paste its full URL (e.g. <code>http://my-node.example:10500</code>).
          It will be probed before being pinned.
        </p>
        <div className="form-group">
          <input
            type="text"
            placeholder="http://host:port"
            value={customNodeInput}
            onChange={(e) => setCustomNodeInput(e.target.value)}
          />
        </div>
        <button
          className="btn-primary"
          onClick={useCustomNode}
          disabled={nodeBusy != null || !customNodeInput.trim()}
        >
          {nodeBusy ? "Probing…" : "► Probe & Pin Custom Node"}
        </button>
      </Card>
    </div>
  );
}
