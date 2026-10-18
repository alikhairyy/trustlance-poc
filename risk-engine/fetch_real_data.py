#!/usr/bin/env python3
"""
Downloads the real, labeled Ethereum account-fraud dataset used by the wallet
risk model.

Source: the Kaggle "Ethereum Fraud Detection Dataset" (vagifa) -- 9,841
Ethereum accounts, each with aggregate transaction statistics and a FLAG column
(1 = known fraudulent account). We fetch the copy committed in the MIT-licensed
repository https://github.com/eltontay/Ethereum-Fraud-Detection (Data/address_data_k.csv).

The CSV is not committed to this repo (see .gitignore): run this script once.

    python fetch_real_data.py
"""
import sys
import urllib.request
from pathlib import Path

URL = (
    "https://raw.githubusercontent.com/eltontay/Ethereum-Fraud-Detection/"
    "main/Data/address_data_k.csv"
)
DEST = Path(__file__).parent / "data" / "ethereum_fraud_kaggle.csv"


def main() -> int:
    if DEST.exists():
        print(f"Already present: {DEST} ({DEST.stat().st_size:,} bytes)")
        return 0
    DEST.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {URL}")
    urllib.request.urlretrieve(URL, DEST)
    print(f"Saved to {DEST} ({DEST.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
