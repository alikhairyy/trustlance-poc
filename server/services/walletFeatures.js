// Wallet feature extraction for the risk engine.
//
// STUB (FR9 "Partial"): the development chain is empty, so a new dev wallet has no
// history to measure. Until the system runs on a public test network, each user is
// linked to one REAL held-out wallet from the Kaggle dataset (dev_risk_profile), and
// the engine scores that wallet's features. Never synthetic data.
//
// TODO (test-network phase): read the payout address's history from a block explorer
// API (activity span, transaction count, distinct senders/recipients, timing, ether
// received, contracts created) and pass {"wallet": {...features}} instead.
const PROFILES = ["legit", "fraud", "false_positive"];

function walletFeaturesFor(user) {
  const profile = PROFILES.includes(user.dev_risk_profile) ? user.dev_risk_profile : "legit";
  return { wallet_sample: profile };
}

module.exports = { walletFeaturesFor, PROFILES };
