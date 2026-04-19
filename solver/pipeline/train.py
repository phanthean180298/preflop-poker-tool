from __future__ import annotations
"""
Training script with parallel CFR+ and auto hot-reload.

Usage:
    # Quick test
    python -m pipeline.train --iterations 200000

    # Production — parallel across all CPU cores
    python -m pipeline.train --iterations 2000000 --workers 0

    # Custom version + auto reload server after training
    python -m pipeline.train --iterations 2000000 --version v3 --reload

    # Continuous auto-train: re-run every N minutes
    python -m pipeline.train --iterations 2000000 --watch 60
"""

import argparse
import random
import sys
import time
import os
import signal
import subprocess
import json
from pathlib import Path
from multiprocessing import Pool, cpu_count
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.game import ALL_HANDS, HAND_WEIGHTS, ALL_PAIRS
from core.cfr  import CFRSolver, cfr_game, _float_dict
from pipeline.export import export_strategies


# ─── Warm-start: load strategy_sum from previous version ─────────────────────

SOLVER_OUTPUT = Path(__file__).parent.parent / "output"
VERSION_FILE  = SOLVER_OUTPUT / "version.json"


def _load_warm_start(solver: CFRSolver) -> int:
    """
    Load the current strategy_sum from the last exported version into the solver.
    This lets each training run build on top of the previous one.

    Returns the previous iteration count (used to offset t for DCFR weighting).
    """
    if not VERSION_FILE.exists():
        return 0
    try:
        meta = json.loads(VERSION_FILE.read_text())
        current = meta.get("current")
        if not current:
            return 0
        strat_file = SOLVER_OUTPUT / current / "preflop_strategies.json"
        if not strat_file.exists():
            return 0

        raw = json.loads(strat_file.read_bytes())
        schema = raw.get("schema", {})
        data   = raw.get("data",   {})
        prev_iters = raw.get("iterations", 0) or 0

        # Reconstruct strategy_sum from average strategy probabilities.
        # We use prev_iters as a weight so warm data has proportional influence.
        weight = float(prev_iters)
        for spot, actions in schema.items():
            hands = data.get(spot, {})
            for hand, probs in hands.items():
                key = f"{spot}:{hand}"
                s = solver.strategy_sum[key]
                for action, prob in zip(actions, probs):
                    s[action] += weight * prob

        print(f"  Warm-start: loaded {current} ({prev_iters:,} iter equivalent)")
        return prev_iters
    except Exception as e:
        print(f"  Warm-start failed ({e}), starting fresh")
        return 0




def _worker(args: tuple) -> CFRSolver:
    """Train a shard of iterations in a subprocess. Returns solver state."""
    shard_iters, seed, offset = args
    # Load equity table in this worker (reads from cache file, ~10ms)
    from core.equity_table import ensure_table
    ensure_table(verbose=False)

    solver = CFRSolver()
    random.seed(seed)
    n_pairs = len(ALL_PAIRS)
    for local_t in range(1, shard_iters + 1):
        t = offset + local_t
        pair_idx       = (t - 1) % n_pairs
        opener, facing = ALL_PAIRS[pair_idx]
        opener_hand    = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
        facing_hand    = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
        cfr_game(solver, opener, facing, opener_hand, facing_hand, t)
    solver.iterations = shard_iters
    return solver


# ─── Main train function ──────────────────────────────────────────────────────

def train(iterations: int, seed: int = 42,
          workers: int = 0,
          warm_start: bool = True) -> tuple[CFRSolver, dict]:
    """
    Train CFR+ over all position pairs.

    warm_start: if True, load previous version's strategy_sum as starting point
                → each run accumulates on top of the last → monotonically improves
    Workers:
      0  → auto (use all CPU cores)
      1  → single-process (easier to debug)
      N  → use N processes
    """
    n_cores = cpu_count() or 1
    n_workers = workers if workers > 0 else n_cores
    n_workers = min(n_workers, iterations)

    solver = CFRSolver()
    t_offset = 0
    if warm_start:
        t_offset = _load_warm_start(solver)

    n_pairs = len(ALL_PAIRS)
    t0 = time.perf_counter()

    total_iters = t_offset + iterations   # cumulative for display
    bench: dict = {
        "iterations":       total_iters,   # cumulative
        "new_iterations":   iterations,
        "pairs":            n_pairs,
        "seed":             seed,
        "workers":          n_workers,
        "warm_start_iters": t_offset,
    }

    print(f"Training DCFR+  [{iterations:,} new iters | {total_iters:,} cumulative | "
          f"{n_pairs} pairs | {n_workers} worker(s) | seed={seed}]")
    print(f"  Effective new iters/pair: ~{iterations // n_pairs:,}")

    if n_workers == 1:
        checkpoint = max(1, iterations // 10)
        t_last = t0
        for local_t in range(1, iterations + 1):
            t = t_offset + local_t
            pair_idx = (t - 1) % n_pairs
            opener, facing = ALL_PAIRS[pair_idx]
            opener_hand = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
            facing_hand = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
            cfr_game(solver, opener, facing, opener_hand, facing_hand, t)
            if local_t % checkpoint == 0:
                now  = time.perf_counter()
                rate = checkpoint / (now - t_last)
                eta  = (iterations - local_t) / rate
                print(f"  [{local_t:>10,}/{iterations:,}]  {rate:>8,.0f} iter/s  ETA {eta:4.0f}s",
                      flush=True)
                t_last = now
    else:
        shard = iterations // n_workers
        remainder = iterations - shard * n_workers
        tasks = []
        offset = t_offset
        for i in range(n_workers):
            n = shard + (1 if i < remainder else 0)
            tasks.append((n, seed + i, offset))
            offset += n

        print(f"  Spawning {n_workers} workers (~{shard:,} iters each)…", flush=True)
        with Pool(n_workers) as pool:
            results = pool.map(_worker, tasks)

        print(f"  Merging {n_workers} solvers…", flush=True)
        # Merge new regrets/strategies into warm-started solver
        for partial in results:
            solver.merge(partial)

    elapsed = time.perf_counter() - t0
    bench["train_time_s"] = round(elapsed, 2)
    bench["iter_per_sec"] = round(iterations / elapsed)

    print(f"\nDone in {elapsed:.1f}s  ({iterations/elapsed:,.0f} iter/s)  "
          f"[{n_workers} worker(s)]  [cumulative: {total_iters:,} iters]")
    return solver, bench


# ─── Hot-reload server ────────────────────────────────────────────────────────

def reload_server() -> None:
    """Send SIGUSR1 to running server or restart it."""
    server_dir = Path(__file__).parent.parent.parent / "server"
    # Try graceful reload via SIGUSR1
    result = subprocess.run(
        ["pgrep", "-f", "node src/index.js"], capture_output=True, text=True
    )
    pids = result.stdout.strip().split()
    if pids:
        for pid in pids:
            try:
                os.kill(int(pid), signal.SIGUSR1)
            except (ProcessLookupError, ValueError):
                pass
        print(f"  Sent SIGUSR1 to server pid(s): {', '.join(pids)}")
    else:
        # Server not running — start it
        subprocess.Popen(
            ["node", "src/index.js"],
            cwd=str(server_dir),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("  Started server (was not running)")


# ─── Watch mode ───────────────────────────────────────────────────────────────

def watch_loop(iterations: int, seed: int, workers: int,
               interval_minutes: int) -> None:
    """Continuously re-train and export every N minutes, accumulating on previous runs."""
    run = 0
    while True:
        run += 1
        print(f"\n{'='*60}")
        print(f"Watch run #{run}  ({time.strftime('%H:%M:%S')})")
        print(f"{'='*60}")
        solver, bench = train(iterations, seed + run, workers, warm_start=True)
        export_strategies(solver, bench)
        reload_server()
        print(f"  Next run in {interval_minutes}m  (Ctrl+C to stop)", flush=True)
        time.sleep(interval_minutes * 60)


# ─── CLI ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Train preflop DCFR+ solver")
    parser.add_argument("--iterations", type=int, default=2_000_000)
    parser.add_argument("--seed",    type=int, default=42)
    parser.add_argument("--version", type=str, default=None)
    parser.add_argument("--workers", type=int, default=0,
                        help="Parallel workers (0=auto/all cores, 1=single)")
    parser.add_argument("--no-warm-start", action="store_true",
                        help="Train from scratch, ignore previous version")
    parser.add_argument("--reload",  action="store_true",
                        help="Hot-reload server after training completes")
    parser.add_argument("--watch",   type=int, default=0, metavar="MINUTES",
                        help="Continuous mode: re-train every N minutes")
    parser.add_argument("--precompute-equity", action="store_true",
                        help="Only precompute equity table, then exit")
    parser.add_argument("--equity-samples", type=int, default=500,
                        help="MC samples per matchup for equity table (default: 500)")
    args = parser.parse_args()

    # ── Equity table (precompute once, cached forever) ────────────────────────
    from core.equity_table import ensure_table
    ensure_table(n_samples=args.equity_samples)

    if args.precompute_equity:
        return   # done

    if args.watch > 0:
        watch_loop(args.iterations, args.seed, args.workers, args.watch)
        return

    solver, bench = train(args.iterations, args.seed, args.workers,
                          warm_start=not args.no_warm_start)
    export_strategies(solver, bench, version=args.version)

    if args.reload:
        reload_server()


if __name__ == "__main__":
    main()

