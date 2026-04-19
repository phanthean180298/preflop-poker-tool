"""
Benchmark script: measures train time, load time, memory, and API latency.

Usage (from solver/):
    python -m pipeline.benchmark [--url http://localhost:3001]
"""

from __future__ import annotations
import argparse
import json
import os
import random
import sys
import time
import tracemalloc
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.game  import ALL_HANDS, HAND_WEIGHTS, ALL_PAIRS, POSITIONS
from core.cfr   import CFRSolver, cfr_game
from pipeline.export import OUTPUT_ROOT, VERSION_FILE


def _current_strategy_file():
    if not VERSION_FILE.exists():
        return None
    with open(VERSION_FILE) as f:
        meta = json.load(f)
    v = meta.get("current")
    if not v:
        return None
    p = OUTPUT_ROOT / v / "preflop_strategies.json"
    return p if p.exists() else None


def bench_train(iterations: int = 50_000, seed: int = 42) -> dict:
    """Quick training benchmark (not a full train — just timing)."""
    solver = CFRSolver()
    random.seed(seed)
    n_pairs = len(ALL_PAIRS)

    t0 = time.perf_counter()
    for t in range(1, iterations + 1):
        pair_idx = (t - 1) % n_pairs
        opener, facing = ALL_PAIRS[pair_idx]
        oh = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
        fh = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
        cfr_game(solver, opener, facing, oh, fh, t)
    elapsed = time.perf_counter() - t0

    return {
        "iterations": iterations,
        "time_s":     round(elapsed, 3),
        "iter_per_s": round(iterations / elapsed),
    }


def bench_load() -> dict:
    """Measure JSON load time and memory for the current strategy file."""
    path = _current_strategy_file()
    if not path:
        return {"error": "No strategy file found. Run train first."}

    size_kb = path.stat().st_size / 1024

    # Load timing (3 runs, take median)
    times = []
    for _ in range(3):
        t0 = time.perf_counter()
        with open(path) as f:
            data = json.load(f)
        times.append(time.perf_counter() - t0)
    times.sort()
    load_ms = times[1] * 1000  # median

    # Memory usage
    tracemalloc.start()
    with open(path) as f:
        data2 = json.load(f)
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    # Build flat lookup map (as cfr_loader does)
    t0 = time.perf_counter()
    lookup: dict[str, dict] = {}
    schema = data2.get("schema", {})
    raw    = data2.get("data", {})
    for spot, actions in schema.items():
        for hand, probs in raw.get(spot, {}).items():
            lookup[f"{spot}:{hand}"] = dict(zip(actions, probs))
    map_ms = (time.perf_counter() - t0) * 1000

    return {
        "file":          str(path),
        "file_size_kb":  round(size_kb, 1),
        "load_ms":       round(load_ms, 2),
        "map_build_ms":  round(map_ms, 2),
        "memory_peak_kb": round(peak / 1024, 1),
        "entries":       len(lookup),
    }


def bench_lookup(n: int = 100_000) -> dict:
    """Benchmark in-process flat-map lookup speed."""
    path = _current_strategy_file()
    if not path:
        return {"error": "No strategy file found."}

    with open(path) as f:
        data = json.load(f)
    schema = data.get("schema", {})
    raw    = data.get("data", {})
    lookup: dict[str, dict] = {}
    for spot, actions in schema.items():
        for hand, probs in raw.get(spot, {}).items():
            lookup[f"{spot}:{hand}"] = dict(zip(actions, probs))

    all_keys = list(lookup.keys())
    random.seed(0)
    sample = [random.choice(all_keys) for _ in range(n)]

    t0 = time.perf_counter()
    hits = 0
    for key in sample:
        if lookup.get(key) is not None:
            hits += 1
    elapsed = time.perf_counter() - t0

    return {
        "lookups":     n,
        "time_ms":     round(elapsed * 1000, 2),
        "per_lookup_ns": round(elapsed * 1e9 / n, 1),
        "hit_rate":    hits / n,
    }


def bench_api(base_url: str, n: int = 200) -> dict:
    """Measure HTTP API latency for POST /api/preflop/action."""
    endpoint = base_url.rstrip("/") + "/api/preflop/action"

    test_cases = [
        {"position": "BTN", "vs": "BB", "hand": "AKs"},
        {"position": "BB",  "vs": "BTN", "facing": "vs_rfi", "hand": "QQ"},
        {"position": "UTG", "vs": "BB", "hand": "AA"},
        {"position": "CO",  "vs": "BB", "facing": "vs_rfi", "hand": "KQs"},
    ]

    latencies: list[float] = []
    errors = 0

    for i in range(n):
        body = json.dumps(test_cases[i % len(test_cases)]).encode()
        req = urllib.request.Request(
            endpoint,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                resp.read()
        except Exception:
            errors += 1
            continue
        latencies.append((time.perf_counter() - t0) * 1000)

    if not latencies:
        return {"error": f"All {n} requests failed. Is the server running?"}

    latencies.sort()
    p50 = latencies[len(latencies) // 2]
    p95 = latencies[int(len(latencies) * 0.95)]
    p99 = latencies[int(len(latencies) * 0.99)]

    return {
        "requests":  n,
        "errors":    errors,
        "p50_ms":    round(p50,  2),
        "p95_ms":    round(p95,  2),
        "p99_ms":    round(p99,  2),
        "mean_ms":   round(sum(latencies) / len(latencies), 2),
        "max_ms":    round(max(latencies), 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark solver + API")
    parser.add_argument("--url", default="http://localhost:3001", help="Server base URL")
    parser.add_argument("--skip-api",   action="store_true")
    parser.add_argument("--skip-train", action="store_true")
    args = parser.parse_args()

    sep = "─" * 60

    if not args.skip_train:
        print(f"\n{sep}")
        print("TRAIN BENCHMARK (50k iters)")
        r = bench_train(50_000)
        for k, v in r.items():
            print(f"  {k:20s}: {v}")

    print(f"\n{sep}")
    print("LOAD BENCHMARK")
    r = bench_load()
    for k, v in r.items():
        print(f"  {k:20s}: {v}")

    print(f"\n{sep}")
    print("LOOKUP BENCHMARK (100k lookups)")
    r = bench_lookup(100_000)
    for k, v in r.items():
        print(f"  {k:20s}: {v}")

    if not args.skip_api:
        print(f"\n{sep}")
        print(f"API LATENCY BENCHMARK  ({args.url})")
        r = bench_api(args.url, n=200)
        for k, v in r.items():
            print(f"  {k:20s}: {v}")

    print(f"\n{sep}\n")


if __name__ == "__main__":
    main()
