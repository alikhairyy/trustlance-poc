#!/usr/bin/env python3
"""
CLI bridge between the Python risk engine and the Node/Hardhat integration demo
(scripts/demo.js). Trains the wallet model once per process, reads one case as JSON on
stdin and writes the risk assessment as JSON on stdout. Every decision is also appended
to the tamper-evident audit log (audit_log.py).

Input JSON (one of):
    {"case_id": "A", "wallet_sample": "legit" | "fraud" | "false_positive"}   # a REAL held-out wallet
    {"case_id": "A", "wallet": {wallet_age_days: ..., total_transactions: ..., ...}}

Usage:
    echo '{...}' | python predict_cli.py
"""
import json
import sys

from audit_log import append_decision
from engine import assess
from wallet_model import train_wallet_model

MODEL_VERSION = "wallet-ethereum-kaggle-v1"


def handle(model, payload: dict) -> dict:
    """Scores one case and appends it to the audit log. Returns the JSON-ready answer."""
    label = None
    if "wallet_sample" in payload:
        sample = model.real_samples()[payload["wallet_sample"]]
        features, label = sample["features"], sample["dataset_label"]
    else:
        features = payload["wallet"]

    result = assess(model, features)

    entry = append_decision(
        {
            "case_id": payload.get("case_id", "unlabeled"),
            "model_version": MODEL_VERSION,
            "score": round(result.score, 4),
            "band": result.band,
            "action": result.action,
            "reason": result.reason,
        },
        {"wallet": features},  # hashed, never stored raw
    )

    return {
        "score": round(result.score, 4),
        "band": result.band,
        "action": result.action,
        "reason": result.reason,
        "top_factors": result.top_factors,
        "wallet_features": features,
        "wallet_dataset_label": label,
        "model_metrics": model.metrics,
        "audit_hash": entry["hash"],
    }


def main() -> None:
    payload = json.loads(sys.stdin.read())
    print(json.dumps(handle(train_wallet_model(), payload)))


def serve() -> None:
    """Long-running mode used by the web server: train once, then answer one JSON
    request per line on stdin with one JSON line on stdout. Loading pandas and
    scikit-learn and training the model takes seconds, so doing it once at start-up
    keeps each risk check fast."""
    model = train_wallet_model()
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            answer = handle(model, json.loads(line))
        except Exception as exc:  # report the error for this request, keep serving
            answer = {"error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(answer), flush=True)


if __name__ == "__main__":
    serve() if "--serve" in sys.argv else main()
