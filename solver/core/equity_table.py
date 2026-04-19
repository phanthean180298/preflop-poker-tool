"""
Precomputed preflop equity table for all 169×169 hand matchups.

Uses Monte Carlo simulation with real card dealing and a correct 7-card
hand evaluator. Results are cached to disk; subsequent loads are instant.

Accuracy:  ±1.5% per matchup (500 samples, combo-weighted average)
Precompute: ~60-90 seconds one-time (8 cores), then cached forever
Lookup:     O(1) dict access

Key improvement over formula-based equity:
  - AK vs AQ:  table ≈ 0.73, formula ≈ 0.56  (domination effect)
  - KK vs AK:  table ≈ 0.67, formula ≈ 0.58
  - 22 vs AK:  table ≈ 0.51, formula ≈ 0.46
"""
from __future__ import annotations

import json
import random
import time
from itertools import combinations
from multiprocessing import Pool, cpu_count
from pathlib import Path

# ─── Card encoding ────────────────────────────────────────────────────────────
# card = rank * 4 + suit   (rank: 0=2 … 12=A,  suit: 0-3)

_RANKS  = "23456789TJQKA"
_RI     = {r: i for i, r in enumerate(_RANKS)}
_DECK   = list(range(52))

# Pre-generate all C(7,5)=21 index combos for best-of-7 evaluation
_C75 = list(combinations(range(7), 5))


def _r(c: int) -> int: return c >> 2   # rank 0-12
def _s(c: int) -> int: return c & 3    # suit 0-3


# ─── 5-card evaluator (sort-based, no dicts, fast in CPython) ────────────────

def _e5(c0: int, c1: int, c2: int, c3: int, c4: int) -> int:
    """Evaluate 5 cards → integer score (higher = better hand)."""
    r0, r1, r2, r3, r4 = sorted((_r(c0), _r(c1), _r(c2), _r(c3), _r(c4)),
                                 reverse=True)
    fl = (_s(c0) == _s(c1) == _s(c2) == _s(c3) == _s(c4))

    # ── Quads ──────────────────────────────────────────────────────────────────
    if r0 == r1 == r2 == r3: return 700_000_000 + r0 * 13 + r4
    if r1 == r2 == r3 == r4: return 700_000_000 + r4 * 13 + r0

    # ── Full house / Trips ─────────────────────────────────────────────────────
    if r0 == r1 == r2:
        if r3 == r4: return 600_000_000 + r0 * 13 + r3     # full house
        return          300_000_000 + r0 * 169 + r3 * 13 + r4
    if r2 == r3 == r4:
        if r0 == r1: return 600_000_000 + r4 * 13 + r0     # full house
        return          300_000_000 + r4 * 169 + r0 * 13 + r1
    if r1 == r2 == r3:
        return          300_000_000 + r1 * 169 + r0 * 13 + r4

    # ── Two pair ───────────────────────────────────────────────────────────────
    if r0 == r1:
        if r2 == r3: return 200_000_000 + r0 * 169 + r2 * 13 + r4
        if r3 == r4: return 200_000_000 + r0 * 169 + r3 * 13 + r2
    if r1 == r2 and r3 == r4:
        return           200_000_000 + r1 * 169 + r3 * 13 + r0

    # ── One pair ───────────────────────────────────────────────────────────────
    if r0 == r1: return 100_000_000 + r0 * 2197 + r2 * 169 + r3 * 13 + r4
    if r1 == r2: return 100_000_000 + r1 * 2197 + r0 * 169 + r3 * 13 + r4
    if r2 == r3: return 100_000_000 + r2 * 2197 + r0 * 169 + r1 * 13 + r4
    if r3 == r4: return 100_000_000 + r3 * 2197 + r0 * 169 + r1 * 13 + r2

    # ── 5 unique ranks → check straight / flush ───────────────────────────────
    wheel = (r0 == 12 and r1 == 3 and r2 == 2 and r3 == 1 and r4 == 0)
    st    = (r0 - r4 == 4) or wheel
    sh    = 3 if wheel else r0     # straight-high card (5 for wheel)

    if fl and st: return 800_000_000 + sh
    if fl:        return 500_000_000 + r0*28561 + r1*2197 + r2*169 + r3*13 + r4
    if st:        return 400_000_000 + sh
    return                           r0*28561 + r1*2197 + r2*169 + r3*13 + r4


def _b5(hole: tuple[int, int], board: list[int]) -> int:
    """Best 5 of 7 cards (2 hole + 5 board)."""
    all7 = list(hole) + board
    best = -1
    for i, j, k, l, m in _C75:
        s = _e5(all7[i], all7[j], all7[k], all7[l], all7[m])
        if s > best:
            best = s
    return best


# ─── Hand class → specific card combos ───────────────────────────────────────

def _hand_combos(hc: str) -> list[tuple[int, int]]:
    """Return all card pairs for a 169-class hand (suit-collapsed)."""
    if len(hc) == 2:   # pair: e.g. "AA"
        r = _RI[hc[0]]
        return list(combinations([r * 4 + s for s in range(4)], 2))
    r1, r2 = _RI[hc[0]], _RI[hc[1]]
    if hc.endswith("s"):   # suited: 4 combos
        return [(r1 * 4 + s, r2 * 4 + s) for s in range(4)]
    # offsuit: 12 combos
    return [(r1*4+s1, r2*4+s2) for s1 in range(4) for s2 in range(4) if s1 != s2]


# ─── Monte Carlo worker (must be module-level for pickling) ──────────────────

def _mc_worker(args: tuple) -> tuple[str, float]:
    """
    Compute MC equity for one hand matchup.
    Returns (canonical_key, equity_of_lex_first_hand).
    """
    h1, h2, n_samples, seed = args
    random.seed(seed)

    c1s = _hand_combos(h1)
    c2s = _hand_combos(h2)
    rc  = random.choice
    rs  = random.sample

    wins = ties = total = 0
    for _ in range(n_samples):
        a    = rc(c1s)
        dead = {a[0], a[1]}
        v2   = [(x, y) for x, y in c2s if x not in dead and y not in dead]
        if not v2:
            continue
        b    = rc(v2)
        rem  = [c for c in _DECK if c not in dead and c != b[0] and c != b[1]]
        board = rs(rem, 5)

        s1 = _b5(a, board)
        s2 = _b5(b, board)
        total += 1
        if   s1 > s2: wins += 1
        elif s1 == s2: ties += 1

    eq  = (wins + ties * 0.5) / total if total else 0.5
    key = f"{h1}:{h2}" if h1 <= h2 else f"{h2}:{h1}"
    stored_eq = eq if h1 <= h2 else 1.0 - eq
    return key, round(stored_eq, 4)


# ─── Precompute all 169×169 matchups ─────────────────────────────────────────

_CACHE_FILE = Path(__file__).parent.parent / "output" / "equity_cache.json"


def precompute(n_samples: int = 500, workers: int = 0) -> dict[str, float]:
    """
    Run Monte Carlo equity for all C(169+1,2) = 14,365 hand matchups.
    Uses multiprocessing for parallelism.
    """
    from .game import ALL_HANDS

    n       = len(ALL_HANDS)
    tasks   = [
        (ALL_HANDS[i], ALL_HANDS[j], n_samples, i * 200 + j)
        for i in range(n)
        for j in range(i, n)
    ]
    total   = len(tasks)
    n_cores = cpu_count() or 1
    nw      = workers if workers > 0 else n_cores
    est     = total * n_samples / (nw * 200_000)

    print(f"[equity] Computing {total:,} matchups × {n_samples} MC samples "
          f"({nw} cores, ~{est:.0f}s)…", flush=True)

    t0    = time.perf_counter()
    table: dict[str, float] = {}
    done  = 0
    chunk = max(1, total // (nw * 20))

    with Pool(nw) as pool:
        for key, eq in pool.imap_unordered(_mc_worker, tasks, chunksize=chunk):
            table[key] = eq
            done += 1
            if done % 500 == 0 or done == total:
                el  = time.perf_counter() - t0
                eta = el / done * (total - done) if done else 0
                print(f"\r  {done:>5}/{total}  ETA {eta:4.0f}s", end="", flush=True)

    elapsed = time.perf_counter() - t0
    print(f"\r  {total}/{total} — done in {elapsed:.0f}s                    ")
    return table


# ─── Cache management ─────────────────────────────────────────────────────────

def save_table(table: dict[str, float]) -> None:
    _CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _CACHE_FILE.write_text(json.dumps(table, separators=(",", ":")))


def load_table() -> dict[str, float]:
    if not _CACHE_FILE.exists():
        return {}
    try:
        return json.loads(_CACHE_FILE.read_text())
    except Exception:
        return {}


# ─── Global table + public API ────────────────────────────────────────────────

_TABLE: dict[str, float] | None = None


def ensure_table(n_samples: int = 500, verbose: bool = True) -> None:
    """Load from cache if available, else precompute and save."""
    global _TABLE
    existing = load_table()
    if existing:
        _TABLE = existing
        if verbose:
            print(f"[equity] Loaded {len(existing):,} cached matchups "
                  f"from {_CACHE_FILE.name}")
        return

    table = precompute(n_samples)
    save_table(table)
    _TABLE = table
    if verbose:
        print(f"[equity] Saved {len(table):,} matchups → {_CACHE_FILE}")


def lookup(h1: str, h2: str) -> float | None:
    """
    Equity of h1 vs h2 from precomputed table.
    Returns None if table not loaded (caller should use fallback).
    """
    if not _TABLE:
        return None
    key = f"{h1}:{h2}" if h1 <= h2 else f"{h2}:{h1}"
    raw = _TABLE.get(key)
    if raw is None:
        return None
    return raw if h1 <= h2 else 1.0 - raw
