#!/usr/bin/env python3
"""
Benchmark on REAL data: how much accuracy does the explainable logistic
regression give up compared with black-box models, on the same cleaned data and
the same train/test split?

Writes docs/BENCHMARK.md. Run:  python benchmark.py
"""
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split

from wallet_model import WALLET_FEATURES, _log, load_real_dataset

OUT = Path(__file__).resolve().parent.parent / "docs" / "BENCHMARK.md"


def evaluate(name, clf, xtr, ytr, xte, yte):
    clf.fit(xtr, ytr)
    p = clf.predict_proba(xte)[:, 1]
    pred = (p >= 0.5).astype(int)
    return {
        "model": name,
        "accuracy": accuracy_score(yte, pred),
        "precision": precision_score(yte, pred),
        "recall": recall_score(yte, pred),
        "roc_auc": roc_auc_score(yte, p),
    }


def main() -> None:
    raw, y, info = load_real_dataset()
    x = _log(raw[WALLET_FEATURES].to_numpy(dtype=float))
    idx = np.arange(len(raw))
    tr, te = train_test_split(idx, test_size=0.25, random_state=42, stratify=y)
    mu, sd = x[tr].mean(axis=0), x[tr].std(axis=0)
    sd[sd == 0] = 1.0
    xtr, xte = (x[tr] - mu) / sd, (x[te] - mu) / sd

    rows = [
        evaluate("Logistic regression (our model, explainable)", LogisticRegression(max_iter=2000), xtr, y[tr], xte, y[te]),
        evaluate("Random forest (black box)", RandomForestClassifier(300, random_state=42, n_jobs=-1), xtr, y[tr], xte, y[te]),
        evaluate("Gradient boosting (black box)", HistGradientBoostingClassifier(random_state=42), xtr, y[tr], xte, y[te]),
    ]

    lines = [
        "# Benchmark on real data",
        "",
        "Dataset: Kaggle *Ethereum Fraud Detection Dataset* (labeled Ethereum accounts, FLAG = fraud),",
        "fetched from the MIT-licensed repo `eltontay/Ethereum-Fraud-Detection` (`Data/address_data_k.csv`).",
        "",
        f"- Raw rows: {info['rows_raw']:,}",
        f"- Duplicate wallet addresses removed: {info['duplicate_addresses_removed']}",
        f"- Rows with an identical feature vector removed (would leak between train and test): {info['duplicate_feature_rows_removed']:,}",
        f"- Rows used: {info['rows_used']:,} ({info['fraud_share']:.1%} fraud)",
        f"- Split: 75% train / 25% test, stratified, seed 42 ({len(tr):,} / {len(te):,})",
        f"- Features ({len(WALLET_FEATURES)}): " + ", ".join(WALLET_FEATURES) + " (log-transformed, standardized)",
        "- Classification threshold 0.5",
        "",
        "| Model | Accuracy | Precision | Recall | ROC-AUC |",
        "|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['model']} | {r['accuracy']:.3f} | {r['precision']:.3f} | {r['recall']:.3f} | {r['roc_auc']:.3f} |"
        )
    gap = rows[1]["roc_auc"] - rows[0]["roc_auc"]
    lines += [
        "",
        "## Reading the result",
        "",
        f"- On real data the explainable logistic regression reaches ROC-AUC {rows[0]['roc_auc']:.3f}; "
        f"the best black-box model reaches {max(rows[1]['roc_auc'], rows[2]['roc_auc']):.3f}. "
        f"The price of explainability is about {gap:.2f} AUC.",
        "- Trustlance keeps the logistic regression because every score can be turned into a "
        "plain-language reason that a client, freelancer and arbiter can read. The black-box "
        "models are the benchmark, not the product.",
        "- Recall matters most for a payment-hold system (a missed fraud costs money). Raising recall "
        "by lowering the threshold, or moving to a more accurate model, is future work.",
        "- This dataset describes Ethereum *wallets*, not freelancers. It validates the wallet-risk "
        "signal on real labels; it is not a benchmark for freelancer payment risk, and we have not "
        "found a public one.",
        "",
    ]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
