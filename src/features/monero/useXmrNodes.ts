import { useCallback, useEffect, useState } from "react";
import type { FeatureFocus } from "../../state/featureFocus";
import {
  TRUSTED_XMR_NODES,
  testNode,
  testAllTrustedNodes,
  getSelectedNode,
  setSelectedNode,
  fetchFeatherNodesRuntime,
  onHealthUpdate,
  getHealthSnapshot,
  type NodeTestResult,
  type XmrNode,
} from "../../wallets/xmr-nodes";
import {
  getActiveXmrDaemon,
  switchXmrDaemon,
} from "../../wallets/xmr-wallet";

/**
 * Monero remote-node picker state + actions. Consumes the layout-agnostic
 * `focus` so the live-refresh loop only fires while Settings → Monero
 * Nodes is open (in either layout).
 */
export function useXmrNodes(args: {
  focus: FeatureFocus;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}) {
  const { focus, onError, onSuccess } = args;

  const [nodeResults, setNodeResults] = useState<NodeTestResult[]>([]);
  const [nodeTesting, setNodeTesting] = useState(false);
  const [pinnedNode, setPinnedNode] = useState<string | null>(null);
  const [customNodeInput, setCustomNodeInput] = useState("");
  const [nodeBusy, setNodeBusy] = useState<string | null>(null);
  const [activePool, setActivePool] = useState<XmrNode[]>([
    ...TRUSTED_XMR_NODES,
  ]);

  const openView = useCallback(async () => {
    try {
      const pinned = await getSelectedNode();
      setPinnedNode(pinned);
      setCustomNodeInput(pinned ?? "");
    } catch {
      setPinnedNode(null);
    }

    void fetchFeatherNodesRuntime()
      .then((runtime) => {
        const seen = new Set<string>();
        const merged: XmrNode[] = [];
        for (const n of [...TRUSTED_XMR_NODES, ...runtime]) {
          if (seen.has(n.url)) continue;
          seen.add(n.url);
          merged.push(n);
        }
        setActivePool(merged);
      })
      .catch(() => {
        /* best-effort */
      });

    setNodeTesting(true);
    try {
      const results = await testAllTrustedNodes();
      setNodeResults(results);
    } catch (e: any) {
      onError("Node test failed: " + (e?.message || String(e)));
    } finally {
      setNodeTesting(false);
    }
  }, [onError]);

  const testAll = useCallback(async () => {
    setNodeTesting(true);
    try {
      const results = await testAllTrustedNodes();
      setNodeResults(results);
    } catch (e: any) {
      onError("Node test failed: " + (e?.message || String(e)));
    } finally {
      setNodeTesting(false);
    }
  }, [onError]);

  const useNode = useCallback(
    async (url: string) => {
      setNodeBusy(url);
      try {
        await setSelectedNode(url);
        setPinnedNode(url);
        if (getActiveXmrDaemon()) {
          await switchXmrDaemon(url);
        }
        onSuccess(`Pinned Monero node: ${url}`);
      } catch (e: any) {
        onError("Failed to switch node: " + (e?.message || String(e)));
      } finally {
        setNodeBusy(null);
      }
    },
    [onError, onSuccess]
  );

  const clearPin = useCallback(async () => {
    try {
      await setSelectedNode(null);
      setPinnedNode(null);
      onSuccess("Cleared node pin — auto-pick mode restored on next session start.");
    } catch (e: any) {
      onError("Failed to clear node pin: " + (e?.message || String(e)));
    }
  }, [onError, onSuccess]);

  const useCustomNode = useCallback(async () => {
    const url = customNodeInput.trim();
    if (!url) {
      onError("Enter a node URL first.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      onError("Node URL must start with http:// or https://");
      return;
    }
    setNodeBusy(url);
    try {
      const result = await testNode(url);
      if (!result.ok) {
        onError(`Custom node failed probe: ${result.error ?? "unknown error"}`);
        return;
      }
      await useNode(url);
    } finally {
      setNodeBusy(null);
    }
  }, [customNodeInput, onError, useNode]);

  useEffect(() => {
    if (focus !== "monero-nodes") return;

    const off = onHealthUpdate(() => {
      const fresh = getHealthSnapshot();
      if (fresh.length === 0) return;
      setNodeResults(
        fresh.map((h) => ({
          url: h.url,
          ok: h.ok,
          latencyMs: h.latencyMs === Number.POSITIVE_INFINITY ? undefined : h.latencyMs,
          height: h.height || undefined,
          error: h.error,
        }))
      );
    });

    const timer = setInterval(async () => {
      if (nodeTesting) return;
      try {
        const results = await testAllTrustedNodes();
        setNodeResults(results);
      } catch {
        /* next tick retries */
      }
    }, 30_000);

    return () => {
      off();
      clearInterval(timer);
    };
  }, [focus, nodeTesting]);

  return {
    nodeResults,
    nodeTesting,
    pinnedNode,
    customNodeInput,
    setCustomNodeInput,
    nodeBusy,
    activePool,
    openView,
    testAll,
    useNode,
    clearPin,
    useCustomNode,
    getActiveDaemon: getActiveXmrDaemon,
  };
}
