// Demo accounts and one open job, so the app can be shown without typing setup data.
// risky@demo.com is linked to a real wallet the dataset labels as fraud (see walletFeatures.js),
// so submitting work as that user shows the risk hold.
const { hashPassword } = require("./services/passwords");

const USERS = [
  { email: "client@demo.com", role: "client", full_name: "Mona Client", profile: "legit", skills: "" },
  { email: "freelancer@demo.com", role: "freelancer", full_name: "Omar Freelancer", profile: "legit", skills: "React, Node.js, Solidity" },
  { email: "risky@demo.com", role: "freelancer", full_name: "Karim NewWallet", profile: "fraud", skills: "Web design" },
  { email: "arbiter@demo.com", role: "arbiter", full_name: "Sara Arbiter", profile: "legit", skills: "" },
];

async function seedDemo(db, chain) {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) return;
  const insert = db.prepare(
    `INSERT INTO users (email, password_hash, role, full_name, skills, wallet_address, dev_wallet_index, dev_risk_profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [i, u] of USERS.entries()) {
    const wallet = await chain.devWallet(i + 1);
    insert.run(u.email, hashPassword("demo1234"), u.role, u.full_name, u.skills, wallet.address, i + 1, u.profile);
  }
  db.prepare("INSERT INTO jobs (client_id, title, description, budget_eth, skills) VALUES (1, ?, ?, ?, ?)").run(
    "Landing page for a payments startup",
    "Responsive landing page with a pricing section and a contact form. Delivered in two milestones: design, then build.",
    "1.5",
    "HTML, CSS, React"
  );
}

module.exports = { seedDemo };
