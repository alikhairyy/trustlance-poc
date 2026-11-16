// Starts the Trustlance web app and API.
//
//   npm run dev          (compiles the contract, starts a local chain in-process, seeds demo users)
//   open http://localhost:3000
//
// Runs on Hardhat's in-process chain, so blockchain state starts empty on every launch.
// The database is therefore in-memory by default too (set DB_PATH to keep it on disk
// when you point the app at a persistent chain).
const crypto = require("crypto");
const { ethers } = require("hardhat");
const { openDatabase } = require("./db");
const { createApp } = require("./app");
const { makeChain } = require("./services/chain");
const { makeRiskService } = require("./services/risk");
const { seedDemo } = require("./seed");

async function main() {
  const db = await openDatabase(process.env.DB_PATH || ":memory:");
  const chain = makeChain(ethers);
  const risk = makeRiskService();
  const app = createApp({ db, chain, risk, jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex") });

  if (process.env.SEED !== "0") await seedDemo(db, chain);

  const port = Number(process.env.PORT || 3000);
  await new Promise((resolve) => app.listen(port, resolve));
  console.log(`Trustlance running at http://localhost:${port}`);
  console.log("Demo logins (password demo1234): client@demo.com, freelancer@demo.com, risky@demo.com, arbiter@demo.com");
  await new Promise(() => {}); // keep running until Ctrl+C
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
