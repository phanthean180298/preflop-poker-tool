"""
Preflop game tree definition for BTN vs BB, 100bb.

Spots supported:
  BTN_RFI       : BTN opens, BB responds
  SB_RFI        : SB opens, BB responds  
  BTN_vs_3bet   : BTN opens → BB 3bets → BTN responds
  BB_vs_BTN     : BB faces BTN open

Actions per spot:
  BTN_RFI   : raise(2.5bb) | fold
  BB_vs_BTN : fold | call | 3bet(7.5bb)
  BTN_vs_3bet: fold | call | 4bet(22bb)
  BB_vs_4bet : fold | call
"""

# 169 canonical hands: pairs, suited, offsuit
RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A']
RANK_VAL = {r: i for i, r in enumerate(RANKS)}

def build_169_hands():
    hands = []
    for i, r1 in enumerate(RANKS):
        for j, r2 in enumerate(RANKS):
            if i > j:
                hands.append(f"{r1}{r2}o")  # offsuit
            elif i == j:
                hands.append(f"{r1}{r2}")   # pair
            else:
                hands.append(f"{r2}{r1}s")  # suited (higher rank first)
    return list(dict.fromkeys(hands))  # deduplicate, preserve order

ALL_HANDS = build_169_hands()

# Number of actual combos per hand class (for reach probability weighting)
def combo_count(hand: str) -> int:
    if len(hand) == 2:  # pair like 'AA'
        return 6
    if hand.endswith('s'):
        return 4
    return 12  # offsuit

TOTAL_COMBOS = sum(combo_count(h) for h in ALL_HANDS)

def hand_combo_weight(hand: str) -> float:
    """Normalized combo weight for a hand class."""
    return combo_count(hand) / TOTAL_COMBOS

# ─── Hand strength score (for initializing CFR reach priors) ──────────────────

def hand_strength(hand: str) -> float:
    """
    Returns a score 0-1 representing raw preflop equity-like strength.
    Used only for initializing; CFR will learn actual frequencies.
    """
    if len(hand) == 2:  # pair
        rv = RANK_VAL[hand[0]]
        return (rv + 1) / 13.0
    suited = hand.endswith('s')
    body = hand.rstrip('so')
    r1 = RANK_VAL.get(body[0], 0)
    r2 = RANK_VAL.get(body[1], 0)
    hi, lo = max(r1, r2), min(r1, r2)
    gap = hi - lo
    score = (hi * 2.5 + lo * 1.5 - gap * 1.5) / 52.0
    if suited:
        score += 0.04
    return min(1.0, max(0.0, score))

# ─── Game tree nodes ──────────────────────────────────────────────────────────

# Each "spot" is an (infoset_prefix, actions, payoff_fn)
# Payoff is from the perspective of the acting player (in BB units)

SPOTS = {
    # BTN opens or folds (first to act, 4 players fold before in 6-max → simplified to BTN vs BB)
    "BTN_RFI": {
        "actions": ["raise", "fold"],
        "raise_size": 2.5,  # BB units
        "dead_money": 1.5,  # SB + BB
    },
    # BB faces BTN 2.5bb open
    "BB_vs_BTN": {
        "actions": ["fold", "call", "3bet"],
        "three_bet_size": 7.5,
        "rfi_size": 2.5,
        "dead_money": 1.5,
    },
    # BTN faces BB 3bet (BB raised to 7.5)
    "BTN_vs_3bet": {
        "actions": ["fold", "call", "4bet"],
        "four_bet_size": 22.0,
        "three_bet_size": 7.5,
        "dead_money": 1.5,
    },
    # BB faces BTN 4bet (BTN raised to 22)
    "BB_vs_4bet": {
        "actions": ["fold", "call"],
        "four_bet_size": 22.0,
        "stack": 100.0,
    },
}
