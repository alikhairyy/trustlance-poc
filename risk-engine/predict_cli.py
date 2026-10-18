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


def main() -> None:
    payload = json.loads(sys.stdin.read())
    model = train_wallet_model()

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

    print(
        json.dumps(
            {
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
        )
    )


if __name__ == "__main__":
    main()
