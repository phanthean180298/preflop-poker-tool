"""
Data pipeline: validate → compress → version → export.

Output format (compact):
{
  "version":      "v2",
  "generated_at": "2026-04-19T12:00:00Z",
  "iterations":   1000000,
  "spots":        91,
  "hands":        169,
  "schema": {
    "BTN_RFI":    ["raise", "fold"],
    "BB_vs_BTN":  ["fold", "call", "3bet"],
    ...
  },
  "data": {
    "BTN_RFI": { "AA": [0.9989, 0.0011], ... },
    ...
  }
}

Size comparison (91 spots × 169 hands):
  Verbose (named keys):  ~420 KB
  Compact (arrays):      ~290 KB   (−30%)
"""

from __future__ import annotations
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from core.game import ALL_HANDS, ALL_PAIRS, ALL_SPOT_NAMES
from core.game import rfi_spot, vs_rfi_spot, vs_3bet_spot, vs_4bet_spot
from core.cfr  import CFRSolver

# ─── Spot → action mapping (stack-aware) ─────────────────────────────────────

def build_schema(stack_bb: float = 100.0) -> dict[str, list[str]]:
    """
    Build spot→actions schema for a given effective stack.
    At push/fold depths (rfi_allin) vs_rfi loses the 3bet option.
    When 3bet is a near-shove (tbet_allin) vs_3bet loses the 4bet option.
    """
    from core.game import get_spot_params
    schema: dict[str, list[str]] = {}
    seen_allin: bool | None = None  # sanity — all pairs consistent at same stack
    for opener, facing in ALL_PAIRS:
        p = get_spot_params(opener, facing, stack_bb)
        rfi_allin  = p["rfi_allin"]
        tbet_allin = p["tbet_allin"]

        schema[rfi_spot(opener)] = ["raise", "fold"]

        if rfi_allin:
            schema[vs_rfi_spot(facing, opener)] = ["fold", "call"]
        else:
            schema[vs_rfi_spot(facing, opener)] = ["fold", "call", "3bet"]
            if tbet_allin:
                schema[vs_3bet_spot(opener, facing)] = ["fold", "call"]
            else:
                schema[vs_3bet_spot(opener, facing)] = ["fold", "call", "4bet"]
                schema[vs_4bet_spot(facing, opener)] = ["fold", "call"]
    return schema

# Legacy default schema (100BB)
SCHEMA: dict[str, list[str]] = build_schema(100.0)

# ─── Validation ───────────────────────────────────────────────────────────────

class ValidationError(Exception):
    pass

def validate(data: dict[str, dict[str, list[float]]],
             schema: dict[str, list[str]]) -> list[str]:
    """
    Validate strategy data.
    Returns list of warning strings (does not raise unless critical).
    """
    warnings: list[str] = []
    eps = 1e-3

    for spot, hands in data.items():
        actions = schema.get(spot)
        if actions is None:
            warnings.append(f"WARN  unknown spot: {spot}")
            continue
        n = len(actions)
        for hand, probs in hands.items():
            if len(probs) != n:
                raise ValidationError(
                    f"{spot}/{hand}: expected {n} probs, got {len(probs)}"
                )
            total = sum(probs)
            if abs(total - 1.0) > eps:
                raise ValidationError(
                    f"{spot}/{hand}: probs sum to {total:.6f} ≠ 1.0"
                )
            if any(p < -eps for p in probs):
                raise ValidationError(
                    f"{spot}/{hand}: negative probability {probs}"
                )

    # Check all expected spots are present
    for spot in schema:
        if spot not in data:
            warnings.append(f"WARN  missing spot in output: {spot}")

    # Check all 169 hands present per spot
    for spot, hands in data.items():
        missing = [h for h in ALL_HANDS if h not in hands]
        if missing:
            warnings.append(f"WARN  {spot}: missing {len(missing)} hands")

    return warnings

# ─── Export ───────────────────────────────────────────────────────────────────

OUTPUT_ROOT = Path(__file__).parent.parent / "output"
VERSION_FILE = OUTPUT_ROOT / "version.json"

def _next_version():
    if not VERSION_FILE.exists():
        return "v1"
    with open(VERSION_FILE) as f:
        meta = json.load(f)
    current = meta.get("current", "v0")
    n = int(current.lstrip("v"))
    return f"v{n + 1}"

def _update_version_manifest(new_version: str, bench: dict) -> None:
    if VERSION_FILE.exists():
        with open(VERSION_FILE) as f:
            meta = json.load(f)
    else:
        meta = {"current": None, "versions": [], "history": []}

    meta["current"] = new_version
    if new_version not in meta["versions"]:
        meta["versions"].append(new_version)
    meta["history"].append({
        "version":      new_version,
        "created":      datetime.now(timezone.utc).isoformat(),
        "iterations":   bench.get("iterations"),
        "train_time_s": bench.get("train_time_s"),
        "spots":        bench.get("spots"),
        "hands":        bench.get("hands"),
    })

    with open(VERSION_FILE, "w") as f:
        json.dump(meta, f, indent=2)


def export_strategies(solver: CFRSolver, bench: dict,
                      version=None,
                      stack_bb: float = 100.0):  # -> Path
    """
    Extract average strategies from solver, validate, compress, and write
    versioned output.

    Output path: output/{version}/stack_{stack_bb:.0f}/preflop_strategies.json
    Returns path to the written file.
    """
    version = version or _next_version()
    out_dir = OUTPUT_ROOT / version / f"stack_{stack_bb:.0f}"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "preflop_strategies.json"

    # ── 1. Build stack-aware schema ────────────────────────────────────────────
    schema = build_schema(stack_bb)

    # ── 2. Extract raw strategies ──────────────────────────────────────────────
    print(f"\n[export] Extracting strategies (stack={stack_bb:.0f}BB)...")
    t0 = time.perf_counter()

    raw: dict[str, dict[str, list[float]]] = {}

    for spot, actions in schema.items():
        raw[spot] = {}
        for hand in ALL_HANDS:
            infoset = f"{spot}:{hand}"
            avg = solver.avg_strategy(infoset, actions)
            total = sum(avg.values())
            # Renormalize + round to 4 dp
            probs = [round(avg[a] / total, 4) if total > 0
                     else round(1.0 / len(actions), 4)
                     for a in actions]
            # Fix floating-point drift: ensure exact sum = 1
            diff = 1.0 - sum(probs)
            probs[-1] = round(probs[-1] + diff, 4)
            raw[spot][hand] = probs

    extract_ms = (time.perf_counter() - t0) * 1000
    print(f"         Extracted {len(raw)} spots × {len(ALL_HANDS)} hands  "
          f"({extract_ms:.0f}ms)")

    # ── 2. Validate ────────────────────────────────────────────────────────────
    print("[export] Validating...")
    warnings = validate(raw, schema)
    if warnings:
        for w in warnings:
            print(f"         {w}")
    else:
        print("         OK — all spots/hands valid, probabilities sum to 1.0")

    # ── 3. Build compact payload ───────────────────────────────────────────────
    bench.update({"spots": len(raw), "hands": len(ALL_HANDS), "stack_bb": stack_bb})

    payload = {
        "version":      version,
        "stack_bb":     stack_bb,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "iterations":   bench.get("iterations"),
        "train_time_s": bench.get("train_time_s"),
        "iter_per_sec": bench.get("iter_per_sec"),
        "spots":        len(raw),
        "hands":        len(ALL_HANDS),
        "schema":       schema,
        "data":         raw,
    }

    # ── 4. Write file ─────────────────────────────────────────────────────────
    json_bytes = json.dumps(payload, separators=(",", ":")).encode()
    out_file.write_bytes(json_bytes)

    size_kb = len(json_bytes) / 1024
    print(f"[export] Written → {out_file}  ({size_kb:.1f} KB)")

    # ── 5. Update version manifest ────────────────────────────────────────────
    _update_version_manifest(version, bench)
    print(f"[export] Version manifest updated: current = {version}")

    # ── 6. Sanity-print sample strategies ─────────────────────────────────────
    print("\n[export] Sample strategies:")
    samples = [("BTN_RFI", "AA"), ("BTN_RFI", "AKs"), ("BTN_RFI", "72o"),
               ("UTG_RFI", "AA"), ("UTG_RFI", "AKs"), ("UTG_RFI", "72o"),
               ("BB_vs_BTN", "AA"), ("BB_vs_BTN", "QQ"), ("BB_vs_BTN", "72o")]
    for spot, hand in samples:
        actions = schema.get(spot, [])
        probs   = raw.get(spot, {}).get(hand, [])
        strat   = dict(zip(actions, probs))
        print(f"  {spot:22s}  {hand:5s}  {strat}")

    return out_file
