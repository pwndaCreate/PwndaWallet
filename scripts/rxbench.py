"""Side-by-side RandomX CPU benchmark: XMRig vs SRBMiner-MULTI.

A local stratum stub on 127.0.0.1 hands both miners the SAME rx/0 job (fixed
blob + seed), accepts every share, and pays nobody. Each miner's own HTTP API
reports its hashrate. No pool, no wallet, no network for the hashing itself.

XMRig also has its own offline benchmark (`--bench=1M|10M`, mode
`xmrig-bench`); SRBMiner has none, which is why the stub exists. Results and
method: PwndaWalletVault/wiki/concepts/randomx-miner-benchmark.md.

usage: python scripts/rxbench.py <tag> <miner: xmrig|srb|xmrig-bench> [threads] [seconds]
Output (logs + JSONL samples) goes to ./rxbench-out/. Stop any mining first.
"""
import hashlib, json, os, socket, subprocess, sys, threading, time, urllib.request

MINERS = os.environ.get("PWNDA_MINERS_DIR") or os.path.join(os.environ.get("APPDATA", ""), "com.pwnda.wallet", "miners")
OUT = os.path.abspath("rxbench-out")
os.makedirs(OUT, exist_ok=True)

# Placeholder login only: the local stub never forwards anything, so nothing is
# ever mined to it. (Monero General Fund donation address, public.)
ADDR = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"

STRATUM_PORT = 47331
API_PORT = 47332

# 76-byte Monero-shaped hashing blob; nonce at offset 39 (bytes 39..42).
BLOB = ("1010" + "c0b8a4c606" + hashlib.sha256(b"pwnda-rxbench-prev").hexdigest()
        + "00000000" + hashlib.sha256(b"pwnda-rxbench-root").hexdigest() + "02")
assert len(BLOB) == 152, len(BLOB)
SEED = hashlib.sha256(b"pwnda-rxbench-seed").hexdigest()
TARGET = "c7100000"  # ~1,000,000 difficulty: few submits, little noise
JOB = {"blob": BLOB, "job_id": "bench1", "target": TARGET, "algo": "rx/0",
       "height": 3500000, "seed_hash": SEED}

submits = 0


def serve_client(conn):
    global submits
    f = conn.makefile("rwb")
    try:
        for raw in f:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            mid, method = msg.get("id"), msg.get("method")
            if method == "login":
                res = {"id": "bench-miner", "job": JOB, "status": "OK", "extensions": ["algo"]}
            elif method == "submit":
                submits += 1
                res = {"status": "OK"}
            else:  # keepalived, getjob, anything else
                res = {"status": "OK"}
            f.write((json.dumps({"id": mid, "jsonrpc": "2.0", "error": None, "result": res}) + "\n").encode())
            f.flush()
    except OSError:
        pass
    finally:
        conn.close()


def stratum():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", STRATUM_PORT))
    s.listen(8)
    while True:
        c, _ = s.accept()
        threading.Thread(target=serve_client, args=(c,), daemon=True).start()


def api_hashrate(kind):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{API_PORT}/" + ("2/summary" if kind == "xmrig" else ""), timeout=3) as r:
            j = json.load(r)
    except Exception as e:
        return None, str(e)[:60]
    if kind == "xmrig":
        t = j["hashrate"]["total"]
        return {"10s": t[0], "60s": t[1], "threads": len(j["hashrate"].get("threads", [])),
                "hugepages": j.get("hugepages"), "msr": j.get("cpu", {}).get("msr")}, None
    a = j["algorithms"][0]
    return {"1min": a["hashrate"].get("1min"), "now": a["hashrate"]["cpu"].get("total"),
            "threads": j.get("total_cpu_workers")}, None


def main():
    tag, kind = sys.argv[1], sys.argv[2]
    threads = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
    seconds = int(sys.argv[4]) if len(sys.argv) > 4 else 150
    log = os.path.join(OUT, f"{tag}.log")
    samples = os.path.join(OUT, f"{tag}.jsonl")
    for p in (log, samples):
        if os.path.exists(p):
            os.remove(p)

    if kind == "xmrig-bench":
        args = [os.path.join(MINERS, "xmrig.exe"), "--bench=10M", "-a", "rx/0", "--no-color",
                "--log-file", log]
        if threads:
            args += ["-t", str(threads)]
        # XMRig waits for Ctrl+C after a benchmark ("press Ctrl+C to exit"),
        # still holding its memory: watch the log and stop it ourselves.
        t0 = time.time()
        p = subprocess.Popen(args, cwd=MINERS, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             creationflags=0x08000000)
        done = None
        try:
            while p.poll() is None and time.time() - t0 < 3600:
                time.sleep(5)
                if os.path.exists(log):
                    text = open(log, encoding="utf-8", errors="replace").read()
                    done = next((l for l in text.splitlines() if "benchmark finished" in l), None)
                    if done:
                        break
        finally:
            if p.poll() is None:
                p.kill()
                p.wait(10)
        print(f"[{tag}] {done or 'no result'} ({time.time()-t0:.0f}s)")
        return

    threading.Thread(target=stratum, daemon=True).start()
    time.sleep(0.3)
    if kind == "xmrig":
        args = [os.path.join(MINERS, "xmrig.exe"), "-o", f"127.0.0.1:{STRATUM_PORT}", "-u", ADDR, "-p", "x",
                "-a", "rx/0", "--no-color", "--http-host", "127.0.0.1", "--http-port", str(API_PORT),
                "--log-file", log, "--print-time", "30"]
        if threads:
            args += ["-t", str(threads)]
    else:
        args = [os.path.join(MINERS, "SRBMiner-MULTI.exe"), "--algorithm", "randomx",
                "--pool", f"127.0.0.1:{STRATUM_PORT}", "--wallet", ADDR, "--password", "x",
                "--disable-gpu", "--api-enable", "--api-port", str(API_PORT), "--log-file", log,
                "--retry-time", "5"]
        if threads:
            args += ["--cpu-threads", str(threads)]
    p = subprocess.Popen(args, cwd=MINERS, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=0x08000000)  # CREATE_NO_WINDOW
    print(f"[{tag}] pid {p.pid}")
    t0 = time.time()
    try:
        while time.time() - t0 < seconds and p.poll() is None:
            time.sleep(15)
            hr, err = api_hashrate(kind)
            row = {"t": round(time.time() - t0), "submits": submits, **(hr or {"err": err})}
            with open(samples, "a") as fh:
                fh.write(json.dumps(row) + "\n")
            print(f"[{tag}] {row}")
    finally:
        if p.poll() is None:
            p.kill()
            p.wait(10)
        print(f"[{tag}] stopped, exit={p.returncode}")


if __name__ == "__main__":
    main()
