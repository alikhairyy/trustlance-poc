"""
Wallet-behavior risk model, trained on REAL labeled data.

The model is a logistic regression trained on the Kaggle "Ethereum Fraud Detection
Dataset" (9,841 Ethereum accounts, each labeled fraud / not fraud). It scores how much
the wallet that will receive a payout behaves like known fraudulent accounts. No
synthetic data is used anywhere in this project.

Limit: the dataset describes wallets, not freelancers, so signals about a freelancer's
own history (completion rate, disputes, ratings) are not in the model yet. They are
planned from survey and pilot data.

It is deliberately a logistic regression on a small, human-readable feature set, so every
score can be explained in plain language. A black-box benchmark (random forest, gradient
boosting) runs on the same split in benchmark.py so the price of explainability is
measured, not assumed.

Data cleaning (the raw Kaggle file has duplicates that would leak between the train and
test split and inflate every metric):
  1. drop repeated wallet addresses
  2. drop rows whose feature vector is identical to an earlier row
"""
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score
from sklearn.model_selection import train_test_split

DATA_PATH = Path(__file__).parent / "data" / "ethereum_fraud_kaggle.csv"

# our feature name -> column in the Kaggle CSV (after stripping header whitespace)
COLUMN_MAP = {
    "wallet_age_days": "Time Diff between first and last (Mins)",  # converted to days
    "total_transactions": None,  # sent + received, derived below
    "unique_senders": "Unique Received From Addresses",
    "unique_recipients": "Unique Sent To Addresses",
    "avg_min_between_sent": "Avg min between sent tnx",
    "total_ether_received": "total ether received",
    "avg_value_received": "avg val received",
    "created_contracts": "Number of Created Contracts",
}
WALLET_FEATURES = list(COLUMN_MAP)

READABLE = {
    "wallet_age_days": "wallet activity span",
    "total_transactions": "total transaction count",
    "unique_senders": "number of distinct senders",
    "unique_recipients": "number of distinct recipients",
    "avg_min_between_sent": "average minutes between sent transactions",
    "total_ether_received": "total ether received",
    "avg_value_received": "average value received",
    "created_contracts": "contracts created",
}

THRESHOLD = 0.5  # classification threshold used for the reported precision/recall


def _log(values: np.ndarray) -> np.ndarray:
    return np.log1p(np.clip(values, 0, None))


def load_real_dataset(path: Path = DATA_PATH):
    """Returns (raw_features_df, labels, cleaning_info)."""
    if not Path(path).exists():
        raise FileNotFoundError(
            f"{path} not found. Run `python fetch_real_data.py` once to download the dataset."
        )
    d = pd.read_csv(path)
    d.columns = [c.strip() for c in d.columns]
    n_raw = len(d)

    d = d.drop_duplicates("Address")
    n_after_addr = len(d)

    d["total_tx"] = d["Sent tnx"] + d["Received Tnx"]
    raw = pd.DataFrame(
        {
            "wallet_age_days": d["Time Diff between first and last (Mins)"] / 1440.0,
            "total_transactions": d["total_tx"],
            "unique_senders": d["Unique Received From Addresses"],
            "unique_recipients": d["Unique Sent To Addresses"],
            "avg_min_between_sent": d["Avg min between sent tnx"],
            "total_ether_received": d["total ether received"],
            "avg_value_received": d["avg val received"],
            "created_contracts": d["Number of Created Contracts"],
        }
    )
    y = d["FLAG"].to_numpy()

    keep = ~raw.duplicated().to_numpy()
    raw, y = raw[keep].reset_index(drop=True), y[keep]

    info = {
        "rows_raw": n_raw,
        "duplicate_addresses_removed": n_raw - n_after_addr,
        "duplicate_feature_rows_removed": n_after_addr - len(raw),
        "rows_used": len(raw),
        "fraud_share": round(float(y.mean()), 4),
    }
    return raw, y, info


@dataclass
class WalletModel:
    clf: LogisticRegression
    means: np.ndarray
    stds: np.ndarray
    metrics: dict = field(default_factory=dict)
    info: dict = field(default_factory=dict)
    # held-out rows kept so the demo can use REAL examples the model never trained on
    test_raw: pd.DataFrame = None
    test_y: np.ndarray = None

    def _z(self, features: dict) -> np.ndarray:
        x = np.array([features[n] for n in WALLET_FEATURES], dtype=float)
        return (_log(x) - self.means) / self.stds

    def score(self, features: dict) -> float:
        return float(self.clf.predict_proba(self._z(features).reshape(1, -1))[0, 1])

    def contributions(self, features: dict) -> list:
        contrib = self._z(features) * self.clf.coef_[0]
        return sorted(zip(WALLET_FEATURES, contrib.tolist()), key=lambda p: -abs(p[1]))

    def real_samples(self) -> dict:
        """Three REAL held-out wallets (never seen in training):
          legit          - clearly legitimate, scored low
          fraud          - labeled fraud in the dataset, scored high
          false_positive - labeled legitimate in the dataset but scored high by the
                           model: exactly the case the appeal path exists for
        Returns name -> {features, dataset_label}."""
        scores = np.array([self.score(row._asdict()) for row in self.test_raw.itertuples(index=False)])
        y = self.test_y

        def pick(mask, target):
            idx = np.where(mask)[0]
            return int(idx[np.argmin(np.abs(scores[idx] - target))])

        chosen = {
            "legit": pick(y == 0, 0.05),
            "fraud": pick(y == 1, 0.90),
            "false_positive": pick(y == 0, 0.75),
        }
        out = {}
        for name, i in chosen.items():
            feats = {k: float(v) for k, v in self.test_raw.iloc[i].items()}
            out[name] = {"features": feats, "dataset_label": int(y[i])}
        return out


def train_wallet_model(seed: int = 42) -> WalletModel:
    raw, y, info = load_real_dataset()
    x_log = _log(raw[WALLET_FEATURES].to_numpy(dtype=float))

    idx = np.arange(len(raw))
    tr, te = train_test_split(idx, test_size=0.25, random_state=seed, stratify=y)

    means = x_log[tr].mean(axis=0)
    stds = x_log[tr].std(axis=0)
    stds[stds == 0] = 1.0

    clf = LogisticRegression(max_iter=2000)
    clf.fit((x_log[tr] - means) / stds, y[tr])

    p = clf.predict_proba((x_log[te] - means) / stds)[:, 1]
    pred = (p >= THRESHOLD).astype(int)
    metrics = {
        "accuracy": round(float(accuracy_score(y[te], pred)), 3),
        "precision": round(float(precision_score(y[te], pred)), 3),
        "recall": round(float(recall_score(y[te], pred)), 3),
        "roc_auc": round(float(roc_auc_score(y[te], p)), 3),
        "n_train": int(len(tr)),
        "n_test": int(len(te)),
    }
    return WalletModel(
        clf=clf,
        means=means,
        stds=stds,
        metrics=metrics,
        info=info,
        test_raw=raw.iloc[te].reset_index(drop=True),
        test_y=y[te],
    )


if __name__ == "__main__":
    m = train_wallet_model()
    print("Dataset cleaning:", m.info)
    print("Held-out metrics:", m.metrics)
    for name, s in m.real_samples().items():
        print(name, "label", s["dataset_label"], "score", round(m.score(s["features"]), 3))
