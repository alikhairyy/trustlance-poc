# Datasets

## Short version

- **We did not find a public dataset of freelancer payment risk.** Our web search turned up freelance
  datasets of listings and contracts (for example, scraped Upwork contract data), but none that we could
  confirm carries fraud, dispute or payment-outcome labels. This should be re-checked with the supervisor.
- The risk engine therefore uses **only real data**. It scores the wallet that will receive the payout
  with a model trained on the Kaggle *Ethereum Fraud Detection Dataset* (9,841 labeled accounts).
- **No synthetic data is used anywhere in this repository.**
- **Limit:** the dataset describes wallets, not freelancers. Signals about a freelancer's own history
  (completion rate, dispute rate, ratings) are not in the model yet. They are planned from survey and pilot data.

## The real dataset

- **Name:** Ethereum Fraud Detection Dataset (Kaggle, user `vagifa`).
- **Copy used:** `Data/address_data_k.csv` from the MIT-licensed repository
  `https://github.com/eltontay/Ethereum-Fraud-Detection`. Download it with
  `python risk-engine/fetch_real_data.py`. The CSV is not committed to this repository.
- **Content:** one row per Ethereum account, with aggregate transaction statistics and a `FLAG`
  column (1 = fraudulent account).
- **Cleaning:** 25 repeated addresses and 1,085 rows with an identical feature vector were removed.
  Without this, duplicates land in both the training and test sets and inflate every metric.
  8,731 rows remain (18.7% fraud).
- **Features used (8, log-transformed and standardized):** wallet activity span in days, total
  transactions, distinct senders, distinct recipients, average minutes between sent transactions,
  total ether received, average value received, contracts created.

## Results on real data

Held-out 25% test split, stratified, seed 42, threshold 0.5. Full table: [`BENCHMARK.md`](BENCHMARK.md).

| Model | Accuracy | Precision | Recall | ROC-AUC |
|---|---|---|---|---|
| Logistic regression (ours, explainable) | 0.885 | 0.731 | 0.613 | 0.924 |
| Random forest (black box) | 0.937 | 0.882 | 0.767 | 0.972 |
| Gradient boosting (black box) | 0.938 | 0.874 | 0.779 | 0.976 |

We keep the logistic regression because every score becomes a plain-language reason. The price of
explainability on this data is about 0.05 ROC-AUC. Recall (0.61) is the weak point for a
payment-hold system; improving it is future work.

## What this does and does not show

- It **does** show the risk-scoring pipeline works on real labeled data, and measures the cost of explainability.
- It **does not** show accuracy on freelancers. The dataset describes wallets, not freelance work.
- The demo uses three **real held-out wallets** (features only, never the addresses) as the payout wallets in
  Cases A, B and C: a clearly legitimate one, one the dataset labels as fraud, and a legitimate one that the model
  scores high (a false positive, which is what the appeal path exists for). The model never saw them in training.

## Plan for freelancer data

1. Survey freelancers and clients about disputes, late payment and non-payment.
2. Run a small pilot with real users and record outcomes.
3. Add freelancer-history signals to the model and re-run the same benchmark.

## Other datasets reviewed

- *Elliptic Bitcoin transaction dataset* (labeled illicit/licit Bitcoin transactions): a possible second
  method check; not evaluated yet.
- Public freelance listing datasets (for example scraped Upwork contracts): a possible source for job-matching
  research. We did not find fraud or dispute labels in what we saw, so we did not use them for risk.
