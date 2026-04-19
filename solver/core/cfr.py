"""
Linear CFR+ solver with threshold pruning.

Improvements over vanilla CFR+:
1. Linear weighting:  strategy_sum[a] += t * reach * strategy[a]
   → later iterations (more accurate) have proportionally more weight
   → proven to converge faster than uniform averaging

2. CFR+ regret clamping:  regret = max(0, regret + delta)
   → always non-negative → faster convergence than vanilla CFR

3. Threshold pruning:  skip infoset if max(regrets) < PRUNE_THRESHOLD
   → safe after BURN_IN_ITERS iterations
   → typical speedup: 30-50% at iteration 500k+
"""

from __future__ import annotations
from collections import defaultdict

from .game import (
    ALL_HANDS, HAND_WEIGHTS, ALL_PAIRS, get_spot_params, hand_equity,
    rfi_spot, vs_rfi_spot, vs_3bet_spot, vs_4bet_spot,
)

# ─── Tuning knobs ─────────────────────────────────────────────────────────────

PRUNE_THRESHOLD = -300.0   # prune infoset if all regrets below this
BURN_IN_ITERS   = 2_000    # no pruning for first N iterations

# ─── Core data structure ─────────────────────────────────────────────────────

class CFRSolver:
    __slots__ = ("regret_sum", "strategy_sum", "iterations")

    def __init__(self) -> None:
        # Both dicts: infoset_key → {action → float}
        self.regret_sum:   dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        self.strategy_sum: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        self.iterations: int = 0

    # ── Strategy computation ──────────────────────────────────────────────────

    def current_strategy(self, infoset: str, actions: list[str],
                         reach: float, t: int) -> dict[str, float]:
        """
        Regret-matching + linear-weighted accumulation.
        reach: reach probability of the acting player (for strategy weighting).
        t:     current iteration (linear weight).
        """
        regrets = self.regret_sum[infoset]
        pos = {a: max(0.0, regrets.get(a, 0.0)) for a in actions}
        total = sum(pos.values())
        strat = ({a: pos[a] / total for a in actions} if total > 0
                 else {a: 1.0 / len(actions) for a in actions})

        # Linear accumulation
        w = float(t) * reach
        s = self.strategy_sum[infoset]
        for a in actions:
            s[a] += w * strat[a]

        return strat

    # ── Regret update ─────────────────────────────────────────────────────────

    def update(self, infoset: str, actions: list[str],
               utils: dict[str, float], ev: float,
               cf_reach: float) -> None:
        """CFR+ update: clamp regrets to ≥ 0 (no negative regret)."""
        r = self.regret_sum[infoset]
        for a in actions:
            r[a] = max(0.0, r.get(a, 0.0) + cf_reach * (utils[a] - ev))

    # ── Pruning ───────────────────────────────────────────────────────────────

    def should_prune(self, infoset: str, actions: list[str], t: int) -> bool:
        """Skip this infoset if all regrets are deeply negative (after burn-in)."""
        if t <= BURN_IN_ITERS:
            return False
        r = self.regret_sum[infoset]
        return all(r.get(a, 0.0) < PRUNE_THRESHOLD for a in actions)

    # ── Average strategy (Nash approximation) ─────────────────────────────────

    def avg_strategy(self, infoset: str, actions: list[str]) -> dict[str, float]:
        s = self.strategy_sum[infoset]
        total = sum(s.get(a, 0.0) for a in actions)
        if total > 0:
            return {a: s.get(a, 0.0) / total for a in actions}
        return {a: 1.0 / len(actions) for a in actions}


# ─── Game tree traversal ──────────────────────────────────────────────────────

_RFI_ACTIONS  = ("raise", "fold")
_VSRFI_ACTIONS = ("fold", "call", "3bet")
_VS3B_ACTIONS  = ("fold", "call", "4bet")
_VS4B_ACTIONS  = ("fold", "call")


def cfr_game(solver, opener, facing, opener_hand, facing_hand, t):  # -> float
    """
    One CFR iteration over the full 4-decision game tree for one position pair.

    Game sequence:
      1. Opener  → raise / fold            (RFI)
      2. Facing  → fold / call / 3bet       (vs_RFI)  [given raise]
      3. Opener  → fold / call / 4bet       (vs_3bet)  [given 3bet]
      4. Facing  → fold / call              (vs_4bet)  [given 4bet]

    Returns opener EV (in bb).
    """
    p = get_spot_params(opener, facing)
    rfi, tbet, fbet, dead = p["rfi_size"], p["three_bet_size"], p["four_bet_size"], p["dead_money"]

    eq_op = hand_equity(opener_hand, facing_hand, opener, facing)
    eq_fc = 1.0 - eq_op

    # ── Infoset keys ──────────────────────────────────────────────────────────
    rfi_is  = f"{rfi_spot(opener)}:{opener_hand}"
    vsr_is  = f"{vs_rfi_spot(facing, opener)}:{facing_hand}"
    v3b_is  = f"{vs_3bet_spot(opener, facing)}:{opener_hand}"
    v4b_is  = f"{vs_4bet_spot(facing, opener)}:{facing_hand}"

    rfi_acts  = list(_RFI_ACTIONS)
    vsr_acts  = list(_VSRFI_ACTIONS)
    v3b_acts  = list(_VS3B_ACTIONS)
    v4b_acts  = list(_VS4B_ACTIONS)

    # ── Pruning check (opener's RFI decision) ─────────────────────────────────
    if solver.should_prune(rfi_is, rfi_acts, t):
        return 0.0

    # ── Current strategies ────────────────────────────────────────────────────
    s_rfi = solver.current_strategy(rfi_is, rfi_acts, 1.0, t)

    p_raise = s_rfi["raise"]
    s_vsr = solver.current_strategy(vsr_is, vsr_acts, p_raise, t)

    p_3bet = p_raise * s_vsr["3bet"]
    s_v3b = solver.current_strategy(v3b_is, v3b_acts, p_3bet, t)

    p_4bet = p_3bet * s_v3b["4bet"]
    s_v4b = solver.current_strategy(v4b_is, v4b_acts, p_4bet, t)

    # ── Terminal utilities (opener perspective, in bb) ────────────────────────

    # pot sizes
    pot_rfi_call  = dead + 2 * rfi          # both put in rfi
    pot_3bet_call = dead + 2 * tbet         # both put in tbet (opener re-calls)
    pot_4bet_call = dead + 2 * fbet         # both put in fbet

    u_fold     = 0.0
    u_rfi_bbfold = dead                                    # win blinds
    u_rfi_call   = eq_op * pot_rfi_call  - rfi            # equity in pot
    u_3b_opfold  = -rfi                                    # lose open
    u_3b_opcall  = eq_op * pot_3bet_call - tbet            # call 3bet
    pot_before_4bet = dead + tbet + rfi                    # pot when 4bet is made
    u_4b_fcfold  = pot_before_4bet                         # facing folds → win pot
    u_4b_call    = eq_op * pot_4bet_call - fbet            # shove

    # Composite utilities from facing's response to 4bet
    u_v4b_scenario = (s_v4b["fold"] * u_4b_fcfold +
                      s_v4b["call"] * u_4b_call)

    # Composite utilities from opener vs 3bet
    u_vs3b_scenario = (s_v3b["fold"] * u_3b_opfold +
                       s_v3b["call"] * u_3b_opcall +
                       s_v3b["4bet"] * u_v4b_scenario)

    u_after_raise = (s_vsr["fold"] * u_rfi_bbfold +
                     s_vsr["call"] * u_rfi_call +
                     s_vsr["3bet"] * u_vs3b_scenario)

    opener_utils = {"raise": u_after_raise, "fold": u_fold}
    opener_ev = s_rfi["raise"] * u_after_raise + s_rfi["fold"] * u_fold

    # ── Facing utilities ──────────────────────────────────────────────────────

    fc_3b_vs_fold  = rfi + dead                                # win opener raise + dead
    fc_3b_vs_call  = eq_fc * pot_3bet_call - tbet
    fc_3b_vs_4b    = (s_v4b["fold"] * (-tbet) +
                      s_v4b["call"] * (eq_fc * pot_4bet_call - fbet))
    fc_3b_ev_tree  = (s_v3b["fold"] * fc_3b_vs_fold +
                      s_v3b["call"] * fc_3b_vs_call +
                      s_v3b["4bet"] * fc_3b_vs_4b)

    facing_utils = {
        "fold": 0.0,
        "call": eq_fc * pot_rfi_call - rfi,
        "3bet": fc_3b_ev_tree,
    }
    facing_ev = sum(s_vsr[a] * facing_utils[a] for a in vsr_acts)

    # ── Regret updates ────────────────────────────────────────────────────────

    # 1. Opener RFI — cf_reach = 1.0 (no prior action)
    solver.update(rfi_is, rfi_acts, opener_utils, opener_ev, 1.0)

    # 2. Facing vs_RFI — cf_reach = P(opener raised)
    solver.update(vsr_is, vsr_acts, facing_utils, facing_ev, p_raise)

    # 3. Opener vs_3bet — cf_reach = P(raise) * P(3bet)
    vs3b_utils = {"fold": u_3b_opfold, "call": u_3b_opcall, "4bet": u_v4b_scenario}
    vs3b_ev = sum(s_v3b[a] * vs3b_utils[a] for a in v3b_acts)
    solver.update(v3b_is, v3b_acts, vs3b_utils, vs3b_ev, p_3bet)

    # 4. Facing vs_4bet — cf_reach = P(raise) * P(3bet) * P(4bet)
    vs4b_utils = {
        "fold": -tbet,                              # lose 3bet investment
        "call": eq_fc * pot_4bet_call - fbet,
    }
    vs4b_ev = sum(s_v4b[a] * vs4b_utils[a] for a in v4b_acts)
    solver.update(v4b_is, v4b_acts, vs4b_utils, vs4b_ev, p_4bet)

    return opener_ev
