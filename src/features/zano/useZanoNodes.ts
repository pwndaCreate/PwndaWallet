import { useCallback, useEffect, useState } from "react";
import type { FeatureFocus } from "../../state/featureFocus";
import {
  TRUSTED_ZANO_NODES,
  testNode as testZanoNode,
  testAllTrustedNodes as testAllZanoNodes,
  getSelectedNode as getSelectedZanoNode,
  setSelectedNode as setSelectedZanoNode,
  onHealthUpdate as onZanoHealthUpdate,
  getHealthSnapshot as getZanoHealthSnapshot,
  type ZanoNode,
  type NodeTestResult,
} from "../../wallets/zano-nodes";
import { getActiveZanoDaemon, switchZanoDaemon } from "../../wallets/zano-wallet";

/**
 * Zano node-picker hook. Mirror of `useZphNodes` — same 2-tier shape (no
 * runtime community-fallback pool). One honest difference in copy, not
 * logic: the pool here is a SINGLE node (Zano publishes exactly one, see
 * `zano-nodes-default.ts`), so the panel should lead with "add your own
 * node" rather than implying a healthy multi-node default exists.
 */
export function useZanoNodes(args: {
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
  const [activePool, setActivePool] = useState<ZanoNode[]>([
    ...TRUSTED_ZANO_NODES,
  ]);

  const openView = useCallback(async () => {
    try {
      const pinned = await getSelectedZanoNode();
      setPinnedNode(pinned);
      setCustomNodeInput(pinned ?? "");
    } catch {
      setPinnedNode(null);
    }

    setActivePool([...TRUSTED_ZANO_NODES]);

    setNodeTesting(true);
    try {
      const results = await testAllZanoNodes();
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
      const results = await testAllZanoNodes();
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
        await setSelectedZanoNode(url);
        setPinnedNode(url);
        if (getActiveZanoDaemon()) {
          await switchZanoDaemon(url);
        }
        onSuccess(`Pinned Zano node: ${url}`);
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
      await setSelectedZanoNode(null);
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
      const result = await testZanoNode(url);
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
    if (focus !== "zano-nodes") return;

    const off = onZanoHealthUpdate(() => {
      const fresh = getZanoHealthSnapshot();
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
        const results = await testAllZanoNodes();
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
    getActiveDaemon: getActiveZanoDaemon,
  };
}
