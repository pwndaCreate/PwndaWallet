import { useCallback, useEffect, useState } from "react";
import type { FeatureFocus } from "../../state/featureFocus";
import {
  TRUSTED_ZPH_NODES,
  testNode as testZphNode,
  testAllTrustedNodes as testAllZphNodes,
  getSelectedNode as getSelectedZphNode,
  setSelectedNode as setSelectedZphNode,
  onHealthUpdate as onZphHealthUpdate,
  getHealthSnapshot as getZphHealthSnapshot,
  type ZphNode,
} from "../../wallets/zph-nodes";
import type { NodeTestResult } from "../../wallets/xmr-nodes";
import {
  getActiveZphDaemon,
  switchZphDaemon,
} from "../../wallets/zph-wallet";

/**
 * Zephyr node-picker hook. Mirror of `useXmrNodes` without a
 * Feather-equivalent runtime pool fetch (Zephyr has no directory API).
 */
export function useZphNodes(args: {
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
  const [activePool, setActivePool] = useState<ZphNode[]>([
    ...TRUSTED_ZPH_NODES,
  ]);

  const openView = useCallback(async () => {
    try {
      const pinned = await getSelectedZphNode();
      setPinnedNode(pinned);
      setCustomNodeInput(pinned ?? "");
    } catch {
      setPinnedNode(null);
    }

    setActivePool([...TRUSTED_ZPH_NODES]);

    setNodeTesting(true);
    try {
      const results = await testAllZphNodes();
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
      const results = await testAllZphNodes();
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
        await setSelectedZphNode(url);
        setPinnedNode(url);
        if (getActiveZphDaemon()) {
          await switchZphDaemon(url);
        }
        onSuccess(`Pinned Zephyr node: ${url}`);
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
      await setSelectedZphNode(null);
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
      const result = await testZphNode(url);
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
    if (focus !== "zephyr-nodes") return;

    const off = onZphHealthUpdate(() => {
      const fresh = getZphHealthSnapshot();
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
        const results = await testAllZphNodes();
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
    getActiveDaemon: getActiveZphDaemon,
  };
}
