"""
Train CFR solver and export strategies to JSON.

Usage:
    python train.py --iterations 50000 --output output/preflop_strategies.json

With more iterations you get closer to Nash equilibrium.
~50k iterations takes ~30s on a modern Mac, sufficient for reasonable GTO approximation.
"""

import argparse
import json
import random
import sys
import time
from collections import defaultdict

from game import ALL_HANDS, SPOTS, combo_count
from cfr import CFRSolver, cfr_btn_rfi, sample_opponent_hand


def train(solver: CFRSolver, iterations: int, seed: int = 42):
    random.seed(seed)
    weights = [combo_count(h) for h in ALL_HANDS]

    print(f"Training CFR+ for {iterations:,} iterations...")
    t0 = time.time()

    for i in range(iterations):
        # Sample a random BTN hand and BB hand
        btn_hand = random.choices(ALL_HANDS, weights=weights, k=1)[0]
        bb_hand  = random.choices(ALL_HANDS, weights=weights, k=1)[0]

        cfr_btn_rfi(solver, btn_hand, bb_hand, p_btn=1.0, p_bb=1.0)

        if (i + 1) % 10000 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed
            remaining = (iterations - i - 1) / rate
            print(f"  [{i+1:>8,}/{iterations:,}]  {rate:,.0f} iter/s  "
                  f"ETA {remaining:.1f}s", flush=True)

    elapsed = time.time() - t0
    print(f"Done in {elapsed:.1f}s ({iterations/elapsed:,.0f} iter/s)")


def export(solver: CFRSolver, output_path: str):
    """Export average strategies for all spots and hands."""
    result = {}

    spot_map = {
        "BTN_RFI":    ("BTN_RFI",    SPOTS["BTN_RFI"]["actions"]),
        "BB_vs_BTN":  ("BB_vs_BTN",  SPOTS["BB_vs_BTN"]["actions"]),
        "BTN_vs_3bet":("BTN_vs_3bet",SPOTS["BTN_vs_3bet"]["actions"]),
        "BB_vs_4bet": ("BB_vs_4bet", SPOTS["BB_vs_4bet"]["actions"]),
    }

    for spot_name, (prefix, actions) in spot_map.items():
        result[spot_name] = {}
        for hand in ALL_HANDS:
            infoset = f"{prefix}:{hand}"
            avg = solver.get_average_strategy(infoset, actions)
            # Round to 4 decimal places, ensure sums to 1
            total = sum(avg.values())
            result[spot_name][hand] = {
                a: round(avg[a] / total, 4) if total > 0 else round(1.0 / len(actions), 4)
                for a in actions
            }

    with open(output_path, "w") as f:
        json.dump(result, f, indent=2)

    size_kb = len(json.dumps(result).encode()) / 1024
    print(f"Exported {len(result)} spots × {len(ALL_HANDS)} hands → {output_path}")
    print(f"File size: {size_kb:.1f} KB")

    # Sanity check: print a few key hands
    print("\nSample strategies:")
    for spot in ["BTN_RFI", "BB_vs_BTN"]:
        for hand in ["AA", "AKs", "AKo", "KQs", "72o"]:
            s = result[spot].get(hand, {})
            print(f"  {spot:15s}  {hand:5s}  {s}")


def main():
    parser = argparse.ArgumentParser(description="Train preflop CFR+ solver")
    parser.add_argument("--iterations", type=int, default=50000,
                        help="Number of CFR iterations (default: 50000)")
    parser.add_argument("--output", type=str,
                        default="output/preflop_strategies.json",
                        help="Output JSON path")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    solver = CFRSolver()
    train(solver, args.iterations, args.seed)
    export(solver, args.output)


if __name__ == "__main__":
    main()
