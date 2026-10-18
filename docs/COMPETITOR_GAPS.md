# What competitors have that Trustlance does not

Source: our competitive landscape of 18 platforms, products and papers
(`Trustlance_Competitive_Landscape_Detailed.xlsx`), built from public descriptions. A competitor
"having" a feature means it is documented in that file, not that we tested it.

## Where Trustlance is different

Of the 18 reviewed, none documents all three of: smart-contract milestone escrow, an explainable
user-facing risk score, and a hybrid automated/human review path. That is the claim, limited to what we reviewed.

## Where competitors are ahead

| # | Capability | Who has it (from the landscape) | Trustlance today | Priority |
|---|---|---|---|---|
| 1 | **Job and talent matching** | Upwork, Fiverr, LaborX, Greelance (AI matching), Braintrust (AI recruiting), TrustLance Solana, Trust Lance (Vercel) | Designed, not built | Medium: needed for a full platform, not for the risk idea |
| 2 | **Credential and skill verification** | Greelance (pre-screens expertise), DeeLance (vetting), Braintrust (AI interviews), TrustLance.io (issuer-signed credentials) | Not in scope | Low for now |
| 3 | **Decentralized dispute resolution** (DAO or juror voting) | DLancer (DAO arbitration), Greelance (DAO), FreeLanceDAO, Ethlance | One human arbiter per job | Medium: shows the arbiter is a trust point; a multi-arbiter panel is the natural upgrade |
| 4 | **On-chain reputation** | TrustLance Solana | Ratings and history kept off-chain | Medium |
| 5 | **Fraud detection on the client side** (fake job posts, non-paying clients) | Upwork (ML scanning of job posts) | Scores the freelancer and the payout wallet only. Escrow already protects freelancers from non-paying clients | Medium: say so honestly |
| 6 | **Token or stablecoin payments, multiple currencies** | LaborX, Greelance ($GRL token), Upwork (fiat) | ETH only | Medium: a stablecoin avoids price swings |
| 7 | **Automatic contract generation** | Trust Lance (Vercel) | Not in scope | Low |
| 8 | **Scale, brand, funding, support teams** | Upwork, Fiverr, Braintrust (~$80M Series B) | Graduation project | Not comparable |
| 9 | **Live product with real users** | Upwork, Fiverr, LaborX, CryptoTask, Greelance | Proof of concept | Closed by the pilot in the plan |

## Where we already match or beat them

- Smart-contract milestone escrow (DLancer, FreeLanceDAO, CryptoTask, Greelance have it too).
- An on-chain record of every flag, appeal and arbiter decision, with the reason in plain language.
- An appeal path for flagged freelancers, a review window so a flag can never trap funds, an emergency
  pause and a tamper-evident decision log. None of the competitors' public descriptions that we
  reviewed mentions these (this is about what is documented, not about what exists inside them).

## Recommended positioning for the proposal

Do not try to match breadth. Say: *Trustlance goes deep on one problem, payment risk, and makes it
explainable and enforceable.* Then list items 1 to 6 as **planned future work or out of scope**, with
the reason for each. Pick one or two (matching and multi-arbiter dispute resolution) to appear in the
timeline.

## Security features: honest limit

The landscape file recorded features, not security designs. We cannot claim that competitors lack
the protections in `SECURITY.md`; we can claim Trustlance documents and tests them. Comparing
security properly would require reading each platform's technical documentation or contracts, which
we have not done.
