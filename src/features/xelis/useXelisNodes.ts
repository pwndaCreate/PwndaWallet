import { useCallback, useEffect, useRef, useState } from "react";
import type { FeatureFocus } from "../../state/featureFocus";
import { errorText } from "../../lib/errorText";
import {
  TRUSTED_XELIS_NODES,
  testNode,
  testAllTrustedNodes,
  getSelectedNode,
  setSelectedNode,
  onHealthUpdate,
  getHealthSnapshot,
  type XelisNode,
  type NodeTestResult,
} from "../../wallets/xelis-nodes";
import { getActiveXelisDaemon, switchXelisDaemon } from "../../wallets/xelis-wallet";

/**
 * Xelis node picker. Counterpart of `useZanoNodes`: the same two tiers (a user
 * pin, then the baked-in list), the same probe-through-Rust, and nodes are
 * contacted only while the node view is open or a session starts.
 *
 * The action callbacks are named `pinNode` / `pinCustomNode` rather than Zano's
 * `useNode` / `useCustomNode`: they are not hooks.
 */
export function useXelisNodes(args: {
  focus: FeatureFocus;
  onError: (msg: string) => void;
  onSuccess: (msg: string) => void;
}) {
  const { focus, onError, onSuccess } = args;

  const [nodeResults, setNodeResults] = useState<NodeTestResult[]>([]);
  const [nodeTesting, setNodeTesting] = useState(false);
  const nodeTestingRef = useRef(false);
  const [pinnedNode, setPinnedNode] = useState<string | null>(null);
  const [customNodeInput, setCustomNodeInput] = useState("");
  const [nodeBusy, setNodeBusy] = useState<string | null>(null);
  const [activePool] = useState<XelisNode[]>(() => [...TRUSTED_XELIS_NODES]);

  const testAll = useCallback(async () => {
    nodeTestingRef.current = true;
    setNodeTesting(true);
    try {
      setNodeResults(await testAllTrustedNodes());
    } catch (e) {
      onError("Node test failed: " + errorText(e));
    } finally {
      nodeTestingRef.current = false;
      setNodeTesting(false);
    }
  }, [onError]);

  const openView = useCallback(async () => {
    try {
      const pinned = await getSelectedNode();
      setPinnedNode(pinned);
      setCustomNodeInput(pinned ?? "");
    } catch {
      setPinnedNode(null);
    }
    await testAll();
  }, [testAll]);

  const pinNode = useCallback(
    async (url: string) => {
      setNodeBusy(url);
      try {
        try {
          await setSelectedNode(url);
          setPinnedNode(url);
        } catch (e) {
          onError("Failed to pin the node: " + errorText(e));
          return;
        }
        if (getActiveXelisDaemon()) {
          try {
            await switchXelisDaemon(url);
          } catch (e) {
            onError(
              `Pinned ${url}, but the open wallet could not switch to it: ${errorText(e)}. ` +
                "The next wallet start uses it."
            );
            return;
          }
        }
        onSuccess(`Pinned Xelis node: ${url}`);
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
      onSuccess("Cleared the node pin. The next wallet start picks a node automatically.");
    } catch (e) {
      onError("Failed to clear the node pin: " + errorText(e));
    }
  }, [onError, onSuccess]);

  const pinCustomNode = useCallback(async () => {
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
        onError(`The node did not answer the probe: ${result.error ?? "unknown error"}`);
        return;
      }
      await pinNode(url);
    } finally {
      setNodeBusy(null);
    }
  }, [customNodeInput, onError, pinNode]);

  useEffect(() => {
    if (focus !== "xelis-nodes") return;

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
      if (nodeTestingRef.current) return;
      try {
        setNodeResults(await testAllTrustedNodes());
      } catch {
        /* the next tick retries */
      }
    }, 30_000);

    return () => {
      off();
      clearInterval(timer);
    };
  }, [focus]);

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
    pinNode,
    clearPin,
    pinCustomNode,
    getActiveDaemon: getActiveXelisDaemon,
  };
}

export type XelisNodesApi = ReturnType<typeof useXelisNodes>;
