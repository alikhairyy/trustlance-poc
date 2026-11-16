# How to run Trustlance

These steps are for Windows (PowerShell). On macOS or Linux, use `.venv/bin/python` wherever the steps say `.\.venv\Scripts\python.exe`.

## What you need

- Node.js 18 or later (`node -v` to check)
- Python 3.10 or later (`python --version`)
- Git

## First time only

```powershell
git clone https://github.com/alikhairyy/trustlance-poc
cd trustlance-poc
npm install

python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r risk-engine\requirements.txt
.\.venv\Scripts\python.exe risk-engine\fetch_real_data.py
```

The last command downloads the Kaggle Ethereum fraud dataset (about 3 MB) into `risk-engine\data\`. If your network blocks it, copy `ethereum_fraud_kaggle.csv` from the project zip's dataset folder into `risk-engine\data\` instead.

## Start the web app

```powershell
npm run dev
```

Wait for `Trustlance running at http://localhost:3000`, then open that address in your browser. The local blockchain and the database start empty every time, and four demo accounts are created for you. They all use the password `demo1234`:

| Email | Role | What it shows |
|---|---|---|
| client@demo.com | Client | Owns a sample job, "Landing page for a payments startup" |
| freelancer@demo.com | Freelancer | Wallet with a legitimate history: low risk, paid at once |
| risky@demo.com | Freelancer | Wallet the dataset labels as fraud: payment is held |
| arbiter@demo.com | Arbiter | Reviews held and disputed payments |

The login page has a button for each account, so you don't need to type them. Stop the app with Ctrl+C.

## Demo script (about 3 minutes)

1. Log in as **risky@demo.com**. Under Find work, send a proposal on the sample job.
2. Log in as **client@demo.com**. Open the job and click Accept. An escrow contract is deployed and its address appears on the page.
3. Still as the client, add a milestone (for example "Design mockups", 0.6 ETH) and click Fund.
4. Log in as **risky@demo.com**. Open My jobs, then the job, paste any link and click Submit work. The risk engine takes about two seconds and scores the wallet 0.90 (high).
5. Log in as the client and click Approve and release. The contract refuses it because the payment is held for review.
6. Log in as the freelancer again, type a note and click Appeal flag.
7. Log in as **arbiter@demo.com**. The review queue shows the score, the reason and the appeal. Click Release to freelancer.
8. Open the job and expand History to show every step with its transaction hash.

To show the normal case, repeat steps 1 to 5 with **freelancer@demo.com**: the score is low and the client's approval pays out straight away.

## Run the tests

```powershell
npm test                         # 25 contract tests + 11 API tests
cd risk-engine
..\.venv\Scripts\python.exe -m unittest -v   # 12 Python tests
cd ..
npm run demo                     # the Milestone 1 script demo, without the web app
```

## If something goes wrong

- **`npm run dev` says the port is in use.** Another copy is running, or something else uses port 3000. Close it, or run `$env:PORT=3001; npm run dev` and open http://localhost:3001.
- **Submitting work always gives "Risk check unavailable".** The app could not run Python. Check that the `.venv` folder exists in the project folder and that step 2 of "First time only" finished. You can point the app at a specific Python with `$env:PYTHON="C:\path\to\python.exe"`. While the engine is down the app holds every payment for the arbiter, so nothing is paid out unchecked.
- **`fetch_real_data.py` fails.** Copy the CSV from the project zip as described above.
- **`npx hardhat compile` fails with HH502.** Use `npm run build:contracts` instead; it compiles with the npm `solc` package and needs no download.
