"""
CFR+ solver for preflop poker.

Uses Chance-Sampled MCCFR with CFR+ (regret clamping to 0).
Each infoset = (spot_name, hand_class).
We solve each spot independently using a simplified 2-player model.
"""

import random
from collections import defaultdict
from game import ALL_HANDS, SPOTS, hand_strength, combo_count, RANK_VAL

class CFRSolver:
    def __init__(self):
        # regret_sum[infoset][action] → cumulative regret
        self.regret_sum = defaultdict(lambda: defaultdict(float))
        # strategy_sum[infoset][action] → cumulative strategy (for avg)
        self.strategy_sum = defaultdict(lambda: defaultdict(float))

    def get_strategy(self, infoset: str, actions: list[str], reach: float) -> dict:
        """Regret-matching strategy for this infoset."""
        regrets = self.regret_sum[infoset]
        pos_regrets = {a: max(0.0, regrets[a]) for a in actions}
        total = sum(pos_regrets.values())
        if total > 0:
            strat = {a: pos_regrets[a] / total for a in actions}
        else:
            strat = {a: 1.0 / len(actions) for a in actions}
        # Accumulate weighted strategy
        for a in actions:
            self.strategy_sum[infoset][a] += reach * strat[a]
        return strat

    def get_average_strategy(self, infoset: str, actions: list[str]) -> dict:
        """Average strategy over all iterations."""
        s = self.strategy_sum[infoset]
        total = sum(s.values())
        if total > 0:
            return {a: s[a] / total for a in actions}
        return {a: 1.0 / len(actions) for a in actions}


# ─── Utility functions per spot ───────────────────────────────────────────────

def hand_vs_hand_equity(h1: str, h2: str) -> float:
    """
    Simplified preflop equity of h1 vs h2 based on hand strength.
    Not Monte Carlo — uses a fast approximation sufficient for CFR.
    """
    s1 = hand_strength(h1)
    s2 = hand_strength(h2)
    # Normalize: if both equal, equity = 0.5
    if s1 + s2 == 0:
        return 0.5
    return s1 / (s1 + s2) * 0.7 + 0.15  # clamp to ~[0.15, 0.85]


def sample_opponent_hand(my_hand: str) -> str:
    """Sample a random hand for the opponent (excluding blocked combos)."""
    # Simple: just pick any hand with probability proportional to combos
    # (in practice, some combos are blocked, but we ignore at 169-class level)
    weights = [combo_count(h) for h in ALL_HANDS]
    return random.choices(ALL_HANDS, weights=weights, k=1)[0]


# ─── Spot-specific CFR iterations ────────────────────────────────────────────

def cfr_btn_rfi(solver: CFRSolver, btn_hand: str, bb_hand: str,
                p_btn: float, p_bb: float) -> float:
    """
    CFR for BTN_RFI spot.
    Returns utility from BTN's perspective.
    """
    spot = SPOTS["BTN_RFI"]
    spot_bb_vs = SPOTS["BB_vs_BTN"]
    spot_btn_vs3 = SPOTS["BTN_vs_3bet"]
    spot_bb_vs4 = SPOTS["BB_vs_4bet"]

    raise_size = spot["raise_size"]
    dead = spot["dead_money"]
    three_bet = spot_bb_vs["three_bet_size"]
    four_bet = spot_btn_vs3["four_bet_size"]
    stack = 100.0

    # ── BTN decision ──────────────────────────────────────────────────────────
    btn_infoset = f"BTN_RFI:{btn_hand}"
    btn_actions = spot["actions"]
    btn_strat = solver.get_strategy(btn_infoset, btn_actions, p_btn)

    # ── BB decision (given BTN raised) ────────────────────────────────────────
    bb_infoset = f"BB_vs_BTN:{bb_hand}"
    bb_actions = spot_bb_vs["actions"]
    bb_strat = solver.get_strategy(bb_infoset, bb_actions, p_bb)

    # ── BTN decision (given BB 3bet) ──────────────────────────────────────────
    btn3_infoset = f"BTN_vs_3bet:{btn_hand}"
    btn3_actions = spot_btn_vs3["actions"]
    btn3_strat = solver.get_strategy(btn3_infoset, btn3_actions,
                                     p_btn * btn_strat["raise"])

    # ── BB decision (given BTN 4bet) ──────────────────────────────────────────
    bb4_infoset = f"BB_vs_4bet:{bb_hand}"
    bb4_actions = spot_bb_vs4["actions"]
    bb4_strat = solver.get_strategy(bb4_infoset, bb4_actions,
                                    p_bb * bb_strat["3bet"] * btn3_strat["4bet"])

    equity = hand_vs_hand_equity(btn_hand, bb_hand)

    # ─── Terminal utilities (BTN perspective) ─────────────────────────────────
    # BTN folds preflop → loses 0 (hasn't put in any money)
    u_btn_fold = 0.0

    # BTN raises, BB folds → BTN wins dead money (1 BB = SB+BB minus BTN's raise... simplified)
    u_raise_bb_fold = dead  # BTN wins SB+BB

    # BTN raises, BB calls → heads-up flop (simplified: use preflop equity)
    pot_call = dead + raise_size * 2
    u_raise_bb_call = equity * pot_call - raise_size

    # BTN raises, BB 3bets, BTN folds → BTN loses raise_size
    u_raise_3bet_btn_fold = -raise_size

    # BTN raises, BB 3bets, BTN calls → HU post (equity based)
    pot_call_3bet = dead + three_bet * 2
    u_raise_3bet_btn_call = equity * pot_call_3bet - three_bet

    # BTN raises, BB 3bets, BTN 4bets, BB folds → BTN wins pot so far
    pot_before_4bet = dead + three_bet + raise_size
    u_raise_3bet_4bet_bb_fold = pot_before_4bet  # BTN wins SB+BB+3bet

    # BTN raises, BB 3bets, BTN 4bets, BB calls → all-in
    pot_allin = dead + four_bet * 2
    u_raise_3bet_4bet_bb_call = equity * pot_allin - four_bet

    # ─── BTN utility computation ──────────────────────────────────────────────
    # After BTN raise:
    u_after_raise = (
        bb_strat["fold"] * u_raise_bb_fold +
        bb_strat["call"] * u_raise_bb_call +
        bb_strat["3bet"] * (
            btn3_strat["fold"] * u_raise_3bet_btn_fold +
            btn3_strat["call"] * u_raise_3bet_btn_call +
            btn3_strat["4bet"] * (
                bb4_strat["fold"] * u_raise_3bet_4bet_bb_fold +
                bb4_strat["call"] * u_raise_3bet_4bet_bb_call
            )
        )
    )

    btn_utils = {
        "raise": u_after_raise,
        "fold": u_btn_fold,
    }

    btn_ev = sum(btn_strat[a] * btn_utils[a] for a in btn_actions)

    # ─── BTN regret update ────────────────────────────────────────────────────
    for a in btn_actions:
        solver.regret_sum[btn_infoset][a] = max(
            0.0,
            solver.regret_sum[btn_infoset][a] + p_bb * (btn_utils[a] - btn_ev)
        )

    # ─── BB utilities (mirror) ────────────────────────────────────────────────
    bb_eq = 1.0 - equity

    u_bb_fold_vs_raise = 0.0  # BB posted 1bb, but we track relative to posting
    u_bb_call_vs_raise = bb_eq * pot_call - raise_size  # BB called raise_size
    u_bb_3bet_btn_fold = raise_size + dead  # BB wins BTN raise + dead money... simplified: pot before 3bet
    u_bb_3bet_btn_call = bb_eq * pot_call_3bet - three_bet
    u_bb_3bet_4bet_fold = -three_bet  # BB loses 3bet
    u_bb_3bet_4bet_call = bb_eq * pot_allin - four_bet

    u_bb_if_raised = (
        bb_strat["fold"] * u_bb_fold_vs_raise +
        bb_strat["call"] * u_bb_call_vs_raise +
        bb_strat["3bet"] * (
            btn3_strat["fold"] * u_bb_3bet_btn_fold +
            btn3_strat["call"] * u_bb_3bet_btn_call +
            btn3_strat["4bet"] * (
                bb4_strat["fold"] * u_bb_3bet_4bet_fold +
                bb4_strat["call"] * u_bb_3bet_4bet_call
            )
        )
    )

    bb_utils_vs_raise = {
        "fold": u_bb_fold_vs_raise,
        "call": u_bb_call_vs_raise,
        "3bet": (
            btn3_strat["fold"] * u_bb_3bet_btn_fold +
            btn3_strat["call"] * u_bb_3bet_btn_call +
            btn3_strat["4bet"] * (
                bb4_strat["fold"] * u_bb_3bet_4bet_fold +
                bb4_strat["call"] * u_bb_3bet_4bet_call
            )
        ),
    }

    bb_ev_vs_raise = sum(bb_strat[a] * bb_utils_vs_raise[a] for a in bb_actions)

    for a in bb_actions:
        solver.regret_sum[bb_infoset][a] = max(
            0.0,
            solver.regret_sum[bb_infoset][a] + p_btn * btn_strat["raise"] * (
                bb_utils_vs_raise[a] - bb_ev_vs_raise
            )
        )

    # ─── BTN_vs_3bet regret update ────────────────────────────────────────────
    btn3_utils = {
        "fold": u_raise_3bet_btn_fold,
        "call": u_raise_3bet_btn_call,
        "4bet": (
            bb4_strat["fold"] * u_raise_3bet_4bet_bb_fold +
            bb4_strat["call"] * u_raise_3bet_4bet_bb_call
        ),
    }
    btn3_ev = sum(btn3_strat[a] * btn3_utils[a] for a in btn3_actions)
    for a in btn3_actions:
        solver.regret_sum[btn3_infoset][a] = max(
            0.0,
            solver.regret_sum[btn3_infoset][a] +
            p_bb * bb_strat["3bet"] * (btn3_utils[a] - btn3_ev)
        )

    # ─── BB_vs_4bet regret update ─────────────────────────────────────────────
    bb4_utils = {
        "fold": u_bb_3bet_4bet_fold,
        "call": u_bb_3bet_4bet_call,
    }
    bb4_ev = sum(bb4_strat[a] * bb4_utils[a] for a in bb4_actions)
    for a in bb4_actions:
        solver.regret_sum[bb4_infoset][a] = max(
            0.0,
            solver.regret_sum[bb4_infoset][a] +
            p_btn * btn_strat["raise"] * bb_strat["3bet"] * (bb4_utils[a] - bb4_ev)
        )

    return btn_ev
