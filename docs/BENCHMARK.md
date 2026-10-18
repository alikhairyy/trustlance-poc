# Benchmark on real data

Dataset: Kaggle *Ethereum Fraud Detection Dataset* (labeled Ethereum accounts, FLAG = fraud),
fetched from the MIT-licensed repo `eltontay/Ethereum-Fraud-Detection` (`Data/address_data_k.csv`).

- Raw rows: 9,841
- Duplicate wallet addresses removed: 25
- Rows with an identical feature vector removed (would leak between train and test): 1,085
- Rows used: 8,731 (18.7% fraud)
- Split: 75% train / 25% test, stratified, seed 42 (6,548 / 2,183)
- Features (8): wallet_age_days, total_transactions, unique_senders, unique_recipients, avg_min_between_sent, total_ether_received, avg_value_received, created_contracts (log-transformed, standardized)
- Classification threshold 0.5

| Model | Accuracy | Precision | Recall | ROC-AUC |
|---|---|---|---|---|
| Logistic regression (our model, explainable) | 0.885 | 0.731 | 0.613 | 0.924 |
| Random forest (black box) | 0.937 | 0.882 | 0.767 | 0.972 |
| Gradient boosting (black box) | 0.938 | 0.874 | 0.779 | 0.976 |

## Reading the result

- On real data the explainable logistic regression reaches ROC-AUC 0.924; the best black-box model reaches 0.976. The price of explainability is about 0.05 AUC.
- Trustlance keeps the logistic regression because every score can be turned into a plain-language reason that a client, freelancer and arbiter can read. The black-box models are the benchmark, not the product.
- Recall matters most for a payment-hold system (a missed fraud costs money). Raising recall by lowering the threshold, or moving to a more accurate model, is future work.
- This dataset describes Ethereum *wallets*, not freelancers. It validates the wallet-risk signal on real labels; it is not a benchmark for freelancer payment risk, and we have not found a public one.
