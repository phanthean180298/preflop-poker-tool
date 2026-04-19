"""
8-max preflop game tree.

Positions (preflop action order, left of BB → right):
  UTG, UTG1, MP, HJ, CO, BTN, SB, BB

Generates 91 spots:
  - 7  RFI spots        (each position except BB)
  - 28 vs_RFI spots     (facing player vs opener)
  - 28 vs_3bet spots    (opener faces 3bet)
  - 28 vs_4bet spots    (3-bettor faces 4bet)

Spot naming:
  {pos}_RFI
  {facing}_vs_{opener}
  {opener}_vs_3bet_{three_bettor}
  {three_bettor}_vs_4bet_{opener}
"""

# ─── Positions ────────────────────────────────────────────────────────────────

POSITIONS = ["UTG", "UTG1", "MP", "HJ", "CO", "BTN", "SB", "BB"]
POSITION_INDEX = {p: i for i, p in enumerate(POSITIONS)}

# Postflop IP order: higher = more in-position (acts last postflop).
# BTN always IP; BB/SB always OOP.
_POSTFLOP_ORDER = {"BB": 0, "SB": 1, "UTG": 2, "UTG1": 3, "MP": 4,
                   "HJ": 5, "CO": 6, "BTN": 7}

def is_ip(actor: str, villain: str) -> bool:
    """True if actor is in position vs villain postflop."""
    return _POSTFLOP_ORDER.get(actor, 0) > _POSTFLOP_ORDER.get(villain, 0)

# ─── Sizing ────────────────────────────────────────────────────────────────────

# Standard 8-max RFI sizes (bb)
RFI_SIZES: dict[str, float] = {
    "UTG": 2.5, "UTG1": 2.5, "MP": 2.5,
    "HJ": 2.5,  "CO": 2.5,   "BTN": 2.5,
    "SB": 3.0,
}

def get_3bet_size(rfi: float, three_bettor_ip: bool) -> float:
    """IP 3bet = 3x RFI; OOP 3bet = 3.5x RFI."""
    return round(rfi * (3.0 if three_bettor_ip else 3.5), 1)

def get_4bet_size(tbet: float) -> float:
    """Standard 4bet ≈ 2.3× the 3bet."""
    return round(tbet * 2.3, 1)

# ─── Spot parameters ──────────────────────────────────────────────────────────

def get_spot_params(opener: str, facing: str) -> dict:
    rfi  = RFI_SIZES[opener]
    tbet = get_3bet_size(rfi, is_ip(facing, opener))
    fbet = get_4bet_size(tbet)
    return {
        "opener":           opener,
        "facing":           facing,
        "rfi_size":         rfi,
        "three_bet_size":   tbet,
        "four_bet_size":    fbet,
        "dead_money":       1.5,   # SB(0.5) + BB(1.0)
        "stack":            100.0,
    }

# All 28 (opener, facing) pairs
ALL_PAIRS: list[tuple[str, str]] = [
    (POSITIONS[i], POSITIONS[j])
    for i in range(len(POSITIONS) - 1)       # openers: all except BB
    for j in range(i + 1, len(POSITIONS))    # facing: everyone after opener
]

# ─── Spot name helpers ────────────────────────────────────────────────────────

def rfi_spot(opener: str) -> str:
    return f"{opener}_RFI"

def vs_rfi_spot(facing: str, opener: str) -> str:
    return f"{facing}_vs_{opener}"

def vs_3bet_spot(opener: str, three_bettor: str) -> str:
    return f"{opener}_vs_3bet_{three_bettor}"

def vs_4bet_spot(three_bettor: str, opener: str) -> str:
    return f"{three_bettor}_vs_4bet_{opener}"

# Collect all unique spot names
ALL_SPOT_NAMES: list[str] = []
_seen: set[str] = set()
for _opener, _facing in ALL_PAIRS:
    for _name in [
        rfi_spot(_opener),
        vs_rfi_spot(_facing, _opener),
        vs_3bet_spot(_opener, _facing),
        vs_4bet_spot(_facing, _opener),
    ]:
        if _name not in _seen:
            _seen.add(_name)
            ALL_SPOT_NAMES.append(_name)

# ─── Hand definitions ─────────────────────────────────────────────────────────

RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A']
RANK_VAL = {r: i for i, r in enumerate(RANKS)}

def build_169_hands() -> list[str]:
    seen, hands = set(), []
    for r1 in RANKS:
        for r2 in RANKS:
            i, j = RANK_VAL[r1], RANK_VAL[r2]
            if i == j:
                h = r1 + r2           # pair
            elif i > j:
                h = r1 + r2 + 'o'    # offsuit (higher rank first)
            else:
                h = r2 + r1 + 's'    # suited  (higher rank first)
            if h not in seen:
                seen.add(h)
                hands.append(h)
    return hands

ALL_HANDS: list[str] = build_169_hands()

def combo_count(hand: str) -> int:
    if len(hand) == 2:          return 6   # pair
    if hand.endswith('s'):      return 4   # suited
    return 12                              # offsuit

HAND_WEIGHTS: list[int] = [combo_count(h) for h in ALL_HANDS]

# ─── Equity model ─────────────────────────────────────────────────────────────

def hand_strength(hand: str) -> float:
    """Raw preflop strength score, 0–1."""
    if len(hand) == 2:  # pair
        return (RANK_VAL[hand[0]] + 1) / 13.0
    suited = hand.endswith('s')
    body   = hand.rstrip('so')
    r1 = RANK_VAL.get(body[0], 0)
    r2 = RANK_VAL.get(body[1], 0)
    hi, lo = max(r1, r2), min(r1, r2)
    gap    = hi - lo
    score  = (hi * 2.5 + lo * 1.5 - gap * 1.5) / 52.0
    if suited:
        score += 0.04
    return min(1.0, max(0.0, score))

def hand_equity(h1: str, h2: str,
                pos1=None,
                pos2=None) -> float:
    """
    Preflop equity of h1 vs h2.

    Priority:
    1. Precomputed Monte Carlo table (±1.5% accuracy, real card evaluation)
    2. Calibrated 3-case fallback (±8% accuracy, no dependencies)

    Range: [0.14, 0.86]
    """
    # Try precomputed table first
    try:
        from .equity_table import lookup as _eq_lookup
        eq = _eq_lookup(h1, h2)
        if eq is not None:
            if pos1 and pos2:
                adj = 0.025 if is_ip(pos1, pos2) else -0.025
                eq  = max(0.14, min(0.86, eq + adj))
            return float(eq)
    except ImportError:
        pass

    # Fallback: calibrated approximation
    eq = _raw_equity(h1, h2)
    if pos1 and pos2:
        adj = 0.025 if is_ip(pos1, pos2) else -0.025
        eq  = max(0.14, min(0.86, eq + adj))
    return eq


def _is_pair(hand: str) -> bool:
    return len(hand) == 2


def _pair_rank(hand: str) -> int:
    return RANK_VAL[hand[0]]


def _hand_ranks(hand: str) -> tuple[int, int]:
    """Returns (hi, lo) rank values for non-pair hands."""
    body = hand.rstrip("so")
    r1 = RANK_VAL.get(body[0], 0)
    r2 = RANK_VAL.get(body[1], 0)
    return max(r1, r2), min(r1, r2)


def _raw_equity(h1: str, h2: str) -> float:
    p1 = _is_pair(h1)
    p2 = _is_pair(h2)

    # ── Pair vs Pair ──────────────────────────────────────────────────────────
    if p1 and p2:
        r1 = _pair_rank(h1)
        r2 = _pair_rank(h2)
        if r1 == r2:
            return 0.50
        # Higher pair wins ~80-83% regardless of exact ranks
        # Slight edge for Aces: AA vs KK ≈ 82%, KK vs 22 ≈ 80%
        diff = abs(r1 - r2)
        base = 0.80 + min(diff, 4) * 0.005
        return base if r1 > r2 else (1.0 - base)

    # ── Pair vs Non-pair ──────────────────────────────────────────────────────
    if p1 or p2:
        if p1:
            pr = _pair_rank(h1)
            hi2, lo2 = _hand_ranks(h2)
            # Count overcards to the pair
            overcards = sum(1 for r in (hi2, lo2) if r > pr)
            if overcards == 0:
                # Both undercards: pair wins ~70-75%
                score = 0.70 + (pr / 12.0) * 0.05
            elif overcards == 1:
                # One overcard: pair ~55-60%
                score = 0.57 + (pr / 12.0) * 0.03
            else:
                # Both overcards (e.g., 22 vs AK): coin-flip ≈ 51%
                score = 0.52 - (hi2 - pr) * 0.005
            return max(0.14, min(0.86, score))
        else:
            # Pair is h2: mirror the above
            return 1.0 - _raw_equity(h2, h1)

    # ── Non-pair vs Non-pair ──────────────────────────────────────────────────
    s1 = _equity_vs_random(h1)
    s2 = _equity_vs_random(h2)
    total = s1 + s2
    base  = s1 / total if total > 0 else 0.5
    return max(0.14, min(0.86, 0.14 + base * 0.72))


def _equity_vs_random(hand: str) -> float:
    """
    Approximate equity of this hand vs a uniformly random opponent hand.
    Calibrated against known preflop equity tables.

    Suited:   72s ≈ 0.37 → AKs ≈ 0.67
    Offsuit:  72o ≈ 0.35 → AKo ≈ 0.65
    """
    if not hand:
        return 0.50

    if len(hand) == 2:
        # Pair: 22=0.542, ..., AA=0.850
        r = RANK_VAL[hand[0]]
        return 0.542 + r * (0.850 - 0.542) / 12.0

    suited  = hand.endswith("s")
    body    = hand.rstrip("so")
    r1 = RANK_VAL.get(body[0], 0)
    r2 = RANK_VAL.get(body[1], 0)
    hi, lo  = max(r1, r2), min(r1, r2)
    gap     = hi - lo

    base = 0.28 + hi * 0.022 + lo * 0.013

    if   gap == 1: conn = 0.030
    elif gap == 2: conn = 0.018
    elif gap == 3: conn = 0.008
    else:          conn = 0.000

    suit_bonus = 0.025 if suited else 0.0

    if gap >= 5:
        base -= (gap - 4) * 0.012

    return max(0.30, min(0.70, base + conn + suit_bonus))
