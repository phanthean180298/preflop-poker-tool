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
    Approximate preflop equity of h1 vs h2 in [0.14, 0.86].
    Optional pos1/pos2 add a small IP/OOP adjustment (~3%).
    """
    s1 = hand_strength(h1)
    s2 = hand_strength(h2)
    total = s1 + s2
    base  = s1 / total if total > 0 else 0.5
    eq    = 0.20 + base * 0.60          # compress to [0.20, 0.80]
    if pos1 and pos2:
        adj = 0.03 if is_ip(pos1, pos2) else -0.03
        eq  = max(0.14, min(0.86, eq + adj))
    return eq
