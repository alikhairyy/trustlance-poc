// Demo accounts, one open job, and portfolios and packages for the freelancers, so the app
// can be shown without typing setup data.
// risky@demo.com is linked to a real wallet the dataset labels as fraud (see walletFeatures.js),
// so submitting work as that user shows the risk hold.
const { hashPassword } = require("./services/passwords");

const USERS = [
  { email: "client@demo.com", role: "client", full_name: "Mona Client", profile: "legit", skills: "", bio: "" },
  {
    email: "freelancer@demo.com", role: "freelancer", full_name: "Omar Freelancer", profile: "legit",
    skills: "Media buying, Meta Ads, Google Ads, Landing pages",
    bio: "Performance marketer. I plan and run paid campaigns for e-commerce and service brands in Egypt and the Gulf, and report results every week.",
  },
  {
    email: "risky@demo.com", role: "freelancer", full_name: "Karim NewWallet", profile: "fraud",
    skills: "Web design, Figma", bio: "Web and UI designer.",
  },
  { email: "arbiter@demo.com", role: "arbiter", full_name: "Sara Arbiter", profile: "legit", skills: "", bio: "" },
];

// Example work for the portfolios (made up for the demo).
const PORTFOLIO = {
  "freelancer@demo.com": [
    { title: "Ramadan campaign for a fashion store", description: "Meta and Instagram ads over 30 days, with a new creative every week.", result: "ROAS 4.2x on 60,000 EGP spend" },
    { title: "Lead generation for a dental clinic", description: "Google Search and Meta lead forms for two branches.", result: "310 booked appointments in 6 weeks" },
    { title: "App installs for a food delivery start-up", description: "Campaign set-up, tracking and weekly optimisation.", result: "Cost per install down 38%" },
  ],
  "risky@demo.com": [
    { title: "Landing page redesign", description: "New layout and visual style for a SaaS landing page.", result: "" },
  ],
};

const PACKAGES = {
  "freelancer@demo.com": [
    { title: "Media buying starter: 3 campaigns", description: "Three paid campaigns on Meta or Google: set-up, creatives brief, daily optimisation and a results report per campaign.", cases: 3, price_eth: "0.9", delivery_days: 30 },
    { title: "Media buying growth: 6 campaigns", description: "Six campaigns over two months, with A/B testing and a weekly report.", cases: 6, price_eth: "1.6", delivery_days: 60 },
  ],
  "risky@demo.com": [
    { title: "Landing page design", description: "One landing page designed in Figma, two rounds of changes.", cases: 1, price_eth: "0.4", delivery_days: 10 },
  ],
};

async function seedDemo(db, chain) {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) return;
  const insert = db.prepare(
    `INSERT INTO users (email, password_hash, role, full_name, skills, bio, wallet_address, dev_wallet_index, dev_risk_profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [i, u] of USERS.entries()) {
    const wallet = await chain.devWallet(i + 1);
    insert.run(u.email, hashPassword("demo1234"), u.role, u.full_name, u.skills, u.bio, wallet.address, i + 1, u.profile);
  }
  const idOf = (email) => db.prepare("SELECT id FROM users WHERE email = ?").get(email).id;
  for (const [email, items] of Object.entries(PORTFOLIO)) {
    for (const p of items) {
      db.prepare("INSERT INTO portfolio_items (freelancer_id, title, description, result) VALUES (?, ?, ?, ?)").run(idOf(email), p.title, p.description, p.result);
    }
  }
  for (const [email, items] of Object.entries(PACKAGES)) {
    for (const p of items) {
      db.prepare("INSERT INTO packages (freelancer_id, title, description, cases, price_eth, delivery_days) VALUES (?, ?, ?, ?, ?, ?)")
        .run(idOf(email), p.title, p.description, p.cases, p.price_eth, p.delivery_days);
    }
  }
  db.prepare("INSERT INTO jobs (client_id, title, description, budget_eth, skills) VALUES (1, ?, ?, ?, ?)").run(
    "Landing page for a payments startup",
    "Responsive landing page with a pricing section and a contact form. Delivered in two milestones: design, then build.",
    "1.5",
    "HTML, CSS, React"
  );
}

module.exports = { seedDemo };
