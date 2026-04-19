from __future__ import annotations
"""
Training script with benchmarks.

Usage:
    # Quick test (dev)
    python -m pipeline.train --iterations 200000

    # Production (all 28 position pairs, 28k iters each)
    python -m pipeline.train --iterations 1000000

    # Custom output version
    python -m pipeline.train --iterations 1000000 --version v2
"""

import argparse
import random
import sys
import time
import os
from pathlib import Path

# Allow running as: python -m pipeline.train (from solver/)
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.game import ALL_HANDS, HAND_WEIGHTS, ALL_PAIRS
from core.cfr  import CFRSolver, cfr_game
from pipeline.export import export_strategies


def train(iterations: int, seed: int = 42) -> tuple[CFRSolver, dict]:
    """
    Train CFR+ over all 28 position pairs via random sampling.

    Strategy:
    - Each iteration: sample a random (opener, facing) pair uniformly
    - Sample one hand per player (weighted by combo count)
    - Run full 4-decision game tree CFR
    - Linear weighting ensures later iterations dominate

    With 1M iterations and 28 pairs → ~35,700 effective iters per pair,
    which is sufficient for reasonable Nash approximation.
    """
    solver = CFRSolver()
    random.seed(seed)

    n_pairs = len(ALL_PAIRS)
    t0 = time.perf_counter()
    t_last = t0

    # Benchmarks collected during training
    bench: dict = {
        "iterations":    iterations,
        "pairs":         n_pairs,
        "seed":          seed,
    }

    print(f"Training Linear CFR+  [{iterations:,} iters | {n_pairs} position pairs | seed={seed}]")
    print(f"  Effective iters per pair: ~{iterations // n_pairs:,}")

    checkpoint = max(1, iterations // 10)

    for t in range(1, iterations + 1):
        # Uniform pair sampling — each pair gets ~equal attention
        pair_idx  = (t - 1) % n_pairs
        opener, facing = ALL_PAIRS[pair_idx]

        opener_hand = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]
        facing_hand = random.choices(ALL_HANDS, weights=HAND_WEIGHTS, k=1)[0]

        cfr_game(solver, opener, facing, opener_hand, facing_hand, t)

        if t % checkpoint == 0:
            now   = time.perf_counter()
            rate  = checkpoint / (now - t_last)
            eta   = (iterations - t) / rate
            print(f"  [{t:>10,}/{iterations:,}]  "
                  f"{rate:>8,.0f} iter/s  "
                  f"ETA {eta:5.1f}s  "
                  f"pruning_active={'yes' if t > 2000 else 'no'}", flush=True)
            t_last = now

    elapsed = time.perf_counter() - t0
    bench["train_time_s"] = round(elapsed, 2)
    bench["iter_per_sec"] = round(iterations / elapsed)

    print(f"\nDone in {elapsed:.1f}s  ({iterations/elapsed:,.0f} iter/s)")
    return solver, bench


def main() -> None:
    parser = argparse.ArgumentParser(description="Train 8-max preflop CFR+ solver")
    parser.add_argument("--iterations", type=int, default=1_000_000,
                        help="CFR iterations (default: 1,000,000)")
    parser.add_argument("--seed",       type=int, default=42)
    parser.add_argument("--version",    type=str, default=None,
                        help="Output version tag (auto-incremented if omitted)")
    args = parser.parse_args()

    solver, bench = train(args.iterations, args.seed)
    export_strategies(solver, bench, version=args.version)


if __name__ == "__main__":
    main()
