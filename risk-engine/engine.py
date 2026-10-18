"""
Risk engine: turns a wallet score into a band, an action and a plain-language reason.

The score comes from the wallet model (wallet_model.py), a logistic regression trained
on real labeled Ethereum fraud data. Because the model is linear, each fact's
contribution to the score is known exactly, so the biggest contributors can be written
as sentences. That is what makes the score explainable rather than just a number.

Bands (thresholds are tunable; they are the project's starting point, not tuned values):
  below 0.35        low     -> auto_approve
  0.35 to below 0.65 medium  -> monitor
  0.65 and above    high    -> hold_for_review
"""
from dataclasses import dataclass

from wallet_model import READABLE

LOW_THRESHOLD = 0.35
HIGH_THRESHOLD = 0.65
MAX_REASON_CHARS = 480  # stays under MilestoneEscrow.MAX_TEXT_LENGTH (512 bytes)


@dataclass
class RiskAssessment:
    score: float
    band: str  # "low" | "medium" | "high"
    action: str  # "auto_approve" | "monitor" | "hold_for_review"
    reason: str
    top_factors: list


def band_and_action(score: float) -> tuple:
    if score < LOW_THRESHOLD:
        return "low", "auto_approve"
    if score < HIGH_THRESHOLD:
        return "medium", "monitor"
    return "high", "hold_for_review"


def describe_factor(name: str, contribution: float, features: dict) -> str:
    value = features[name]
    value_str = f"{value:.1f}" if abs(value) < 1000 else f"{value:,.0f}"
    direction = "raises" if contribution > 0 else "lowers"
    return f"{READABLE[name]} ({value_str}) {direction} risk"


def assess(wallet_model, features: dict, top_n: int = 3) -> RiskAssessment:
    score = wallet_model.score(features)
    band, action = band_and_action(score)
    top = wallet_model.contributions(features)[:top_n]
    sentences = "; ".join(describe_factor(n, c, features) for n, c in top)

    if action == "hold_for_review":
        tail = "Flagged: release held for arbiter review before funds move."
    elif action == "monitor":
        tail = "Not flagged on-chain, but logged for monitoring."
    else:
        tail = "No flag raised; eligible for automatic release on client approval."

    reason = f"Risk score {score:.2f} ({band}). Payout wallet: {sentences}. {tail}"
    if len(reason) > MAX_REASON_CHARS:  # the contract rejects reasons over 512 bytes
        reason = reason[: MAX_REASON_CHARS - 1] + "…"
    return RiskAssessment(score=score, band=band, action=action, reason=reason, top_factors=[n for n, _ in top])
