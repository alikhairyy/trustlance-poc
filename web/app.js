// Trustlance web client: one page, three role dashboards (client, freelancer, arbiter).
// Talks to the REST API in server/. No framework, so it runs anywhere without a build step.
const state = { token: localGet("tl_token"), user: null };

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Deliverable links: only http(s) links are clickable; anything else is shown as plain text.
const webLink = (url) => (/^https?:\/\//i.test(String(url ?? "").trim())
  ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`
  : esc(url));
const pill = (text, cls = text) => `<span class="pill ${esc(cls)}">${esc(String(text).replace(/_/g, " "))}</span>`;

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 4000);
}

async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: { "content-type": "application/json", ...(state.token ? { authorization: "Bearer " + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout();
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Runs an action, shows success or the API's error, then re-renders.
async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
    render();
  } catch (e) {
    toast(e.message, true);
    // The page is not re-rendered after an error, so turn the buttons back on to allow a retry.
    document.querySelectorAll("main button:disabled").forEach((b) => { b.disabled = false; });
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- session ----------
function logout() {
  state.token = null;
  state.user = null;
  localSet("tl_token", null);
  location.hash = "";
  render();
}

async function login(email, password) {
  const r = await api("POST", "/auth/login", { email, password });
  state.token = r.token;
  localSet("tl_token", r.token);
  location.hash = "";
  render();
}

// ---------- layout ----------
const NAV = {
  client: [["#/", "My jobs"], ["#/freelancers", "Hire a freelancer"], ["#/profile", "Profile"]],
  freelancer: [["#/", "Find work"], ["#/mine", "My jobs"], ["#/portfolio", "Portfolio & packages"], ["#/profile", "Profile"]],
  arbiter: [["#/", "Review queue"], ["#/profile", "Profile"]],
};
const VISITOR_NAV = [["#/", "Home"], ["#/freelancers", "Freelancers"], ["#/login", "Log in"]];

function renderChrome() {
  const route = location.hash || "#/";
  $("#nav").innerHTML = (state.user ? NAV[state.user.role] : VISITOR_NAV)
    .map(([h, l]) => `<a href="${h}" class="${route === h ? "active" : ""}">${l}</a>`).join("");
  $("#who").innerHTML = state.user
    ? `${esc(state.user.full_name)} ${pill(state.user.role)} <button id="logout">Log out</button>`
    : `<a class="nav-cta" href="#/login">Get started</a>`;
  if (state.user) $("#logout").onclick = logout;
}

async function render() {
  if (state.token && !state.user) {
    try { state.user = await api("GET", "/users/me"); } catch { return logout(); }
  }
  renderChrome();
  const view = $("#view");
  const route = location.hash || "#/";
  const userMatch = route.match(/^#\/u\/(\d+)$/);
  try {
    // Public pages: open to everyone, logged in or not.
    if (route === "#/freelancers") return await renderFreelancers(view);
    if (userMatch) return await renderPublicProfile(view, Number(userMatch[1]));
    if (!state.user) return route === "#/login" ? renderLogin(view) : await renderLanding(view);
  } catch (e) {
    view.innerHTML = `<div class="card">${esc(e.message)}</div>`;
    return;
  }

  const jobMatch = route.match(/^#\/job\/(\d+)$/);
  try {
    if (route === "#/profile") return await renderProfile(view);
    if (route === "#/portfolio" && state.user.role === "freelancer") return await renderMyPortfolio(view);
    if (jobMatch) return await renderJob(view, Number(jobMatch[1]));
    if (state.user.role === "client") return await renderClientHome(view);
    if (state.user.role === "freelancer") return route === "#/mine" ? await renderMyJobs(view) : await renderFindWork(view);
    return await renderArbiterQueue(view);
  } catch (e) {
    view.innerHTML = `<div class="card">${esc(e.message)}</div>`;
  }
}

// ---------- screens ----------

// ---------- shared pieces for the marketplace screens ----------

// Initials in a coloured circle, so freelancers have a face without photo uploads.
function avatar(name, size = "") {
  const initials = String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const hue = [...String(name || "")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<span class="avatar ${size}" style="background:hsl(${hue} 55% 42%)">${esc(initials)}</span>`;
}

const unreadBadge = (j) => (j.unread_messages ? `<span class="badge">${j.unread_messages} new ${j.unread_messages === 1 ? "message" : "messages"}</span>` : "");
const starLine = (rating, count) => (count
  ? `<span class="stars">★</span> <strong>${Number(rating).toFixed(1)}</strong> <span class="muted">(${count} ${count === 1 ? "review" : "reviews"})</span>`
  : `<span class="muted">No reviews yet</span>`);

const skillTags = (skills) => String(skills || "").split(",").map((s) => s.trim()).filter(Boolean)
  .map((s) => `<span class="tag">${esc(s)}</span>`).join("");

function packageCard(p, { showFreelancer = false, canBuy = false } = {}) {
  const perCase = Number(p.price_eth) / p.cases;
  return `<div class="pkg">
    ${showFreelancer ? `<a class="pkg-by" href="#/u/${p.freelancer_id}">${avatar(p.freelancer_name, "sm")} ${esc(p.freelancer_name)}</a>` : ""}
    <h3>${esc(p.title)}</h3>
    <p class="pkg-desc">${esc(p.description)}</p>
    <ul class="pkg-facts">
      <li><strong>${p.cases}</strong> ${p.cases === 1 ? "case" : "cases"}, each paid from escrow on delivery</li>
      <li>Delivered within <strong>${p.delivery_days}</strong> days</li>
    </ul>
    <div class="pkg-foot">
      <div><span class="price">${esc(p.price_eth)} ETH</span><span class="muted"> · ${perCase.toFixed(4).replace(/\.?0+$/, "")} ETH per case</span></div>
      ${canBuy ? `<button data-buy="${p.id}">Buy package</button>` : showFreelancer ? `<a class="btn small" href="#/u/${p.freelancer_id}">View</a>` : ""}
    </div>
  </div>`;
}

// A client buys a package: the server creates the job, its escrow and one milestone per case.
function wireBuyButtons(view) {
  view.querySelectorAll("[data-buy]").forEach((b) => {
    b.onclick = () => {
      if (!state.user) { location.hash = "#/login"; return; }
      if (!confirm("Buy this package? A job is created with one milestone per case. You fund each case before the work starts.")) return;
      b.disabled = true;
      act(async () => {
        const job = await api("POST", `/packages/${b.dataset.buy}/buy`);
        location.hash = `#/job/${job.id}`;
      }, "Package bought. Fund the first case to start.");
    };
  });
}

// Public landing page: what Trustlance does, for visitors who are not logged in.
async function renderLanding(view) {
  const [packages, freelancers] = await Promise.all([
    api("GET", "/public/packages").catch(() => []),
    api("GET", "/public/freelancers").catch(() => []),
  ]);
  view.innerHTML = `
    <section class="hero2">
      <div class="hero2-text">
        <p class="eyebrow">Escrow · explainable AI · a human in the loop</p>
        <h1>Hire freelancers with your money protected at every milestone.</h1>
        <p class="hero-sub">Browse portfolios, buy a fixed package or post a job. Every payment waits in escrow until the work is delivered, and if anything looks risky, a person checks it before money moves.</p>
        <div class="row">
          <a class="btn big" href="#/freelancers">Browse freelancers</a>
          <a class="btn big ghost" href="#/login">Join as a freelancer</a>
        </div>
        <div class="trust-row">
          <span>✓ Money held in escrow</span><span>✓ Every AI decision explained</span><span>✓ Holds end after 7 days</span>
        </div>
      </div>
      <div class="hero2-card" aria-hidden="true">
        <div class="mini-head">${avatar("Omar Freelancer")} <div><strong>Media buying starter</strong><span>3 campaigns · 0.9 ETH</span></div></div>
        <div class="mini-step done"><span>1</span> Case 1 funded and delivered <b>Released</b></div>
        <div class="mini-step live"><span>2</span> Case 2 submitted · risk 0.05 low <b>Ready</b></div>
        <div class="mini-step"><span>3</span> Case 3 waiting for funding</div>
      </div>
    </section>

    <section class="facts">
      <div><strong>0.92</strong><span>accuracy score (ROC-AUC) of our fraud model on 8,731 real wallets</span></div>
      <div><strong>7 days</strong><span>longest the AI can hold a payment. It can never move money.</span></div>
      <div><strong>100%</strong><span>of holds come with a written reason the freelancer can appeal</span></div>
    </section>

    ${packages.length ? `<section>
      <div class="section-head"><h2 class="section-title">Popular packages</h2><a href="#/freelancers">See all freelancers →</a></div>
      <p class="sub">Fixed scope, fixed price. Each case is a milestone paid from escrow when it is delivered.</p>
      <div class="pkg-grid">${packages.slice(0, 3).map((p) => packageCard(p, { showFreelancer: true })).join("")}</div>
    </section>` : ""}

    ${freelancers.length ? `<section>
      <div class="section-head"><h2 class="section-title">Freelancers with a portfolio</h2><a href="#/freelancers">Browse all →</a></div>
      <div class="fl-grid">${freelancers.slice(0, 3).map(freelancerCard).join("")}</div>
    </section>` : ""}

    <section id="how">
      <h2 class="section-title">How it works</h2>
      <div class="grid steps-grid">
        <div class="card step-card"><span class="step-n">1</span><h3>Pick a freelancer</h3><p>Check their portfolio and results, then buy one of their packages or post your own job.</p></div>
        <div class="card step-card"><span class="step-n">2</span><h3>Fund each milestone</h3><p>The amount is locked in escrow for that job. Neither side, and not the platform, can take it out alone.</p></div>
        <div class="card step-card"><span class="step-n">3</span><h3>Approve and pay</h3><p>When work is delivered, our AI checks the payout. Normal payments are released at once. A risky one waits for a human arbiter, for 7 days at most.</p></div>
      </div>
    </section>

    <section>
      <h2 class="section-title">Built for everyone in the job</h2>
      <div class="grid">
        <div class="card role-card"><h3>Freelancers</h3><p>Show your work in a public portfolio, sell fixed packages, and know the money is there before you start.</p></div>
        <div class="card role-card"><h3>Clients</h3><p>Pay into escrow, approve when you are happy, or dispute work that was not delivered.</p></div>
        <div class="card role-card"><h3>Arbiters</h3><p>Every held or disputed payment in one queue, with the AI's reason and the freelancer's appeal side by side.</p></div>
      </div>
    </section>

    <section class="cta-band">
      <div>
        <h2>Try it with the demo accounts</h2>
        <p>Log in as a client, a freelancer or an arbiter and follow one payment from start to finish.</p>
      </div>
      <a class="btn big light" href="#/login">Open the demo</a>
    </section>

    <p class="footer-note">Trustlance is a graduation project at ESLSCA University. It runs on a test network with test ETH: no real money is involved.</p>`;
}

function freelancerCard(f) {
  return `<a class="fl-card" href="#/u/${f.id}">
    <div class="fl-top">${avatar(f.full_name, "lg")}<div><h3>${esc(f.full_name)}</h3>
      <div class="fl-rating">${starLine(f.rating, f.reviews)}</div>
      <span class="muted">${f.portfolio_count} portfolio ${f.portfolio_count === 1 ? "item" : "items"} · ${f.completed_jobs} ${f.completed_jobs === 1 ? "job" : "jobs"} completed</span></div></div>
    <p class="fl-bio">${esc(f.bio || "No bio yet.")}</p>
    <div class="tags">${skillTags(f.skills)}</div>
    <div class="fl-foot">${f.from_eth ? `Packages from <strong>${esc(f.from_eth)} ETH</strong>` : `<span class="muted">No packages yet</span>`}<span>View profile →</span></div>
  </a>`;
}

// Directory of freelancers: open to everyone, with search, filters and sorting.
const freelancerSearch = { q: "", max_price: "", min_rating: "", sort: "rating" };

async function renderFreelancers(view) {
  const s = freelancerSearch;
  view.innerHTML = `
    <h1>Freelancers</h1><p class="sub">Open a profile to see their portfolio and packages. Payments for every package go through escrow.</p>
    <form id="flSearch" class="search-bar card">
      <input name="q" placeholder="Search by name, skill or service, e.g. media buying" value="${esc(s.q)}" />
      <select name="max_price"><option value="">Any price</option>${["0.5", "1", "2", "5"].map((p) => `<option value="${p}" ${s.max_price === p ? "selected" : ""}>Packages up to ${p} ETH</option>`).join("")}</select>
      <select name="min_rating"><option value="">Any rating</option>${["4.5", "4", "3"].map((r) => `<option value="${r}" ${s.min_rating === r ? "selected" : ""}>${r}★ and up</option>`).join("")}</select>
      <select name="sort">${[["rating", "Best rated"], ["jobs", "Most jobs"], ["price", "Lowest price"]].map(([v, l]) => `<option value="${v}" ${s.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select>
      <button>Search</button>
    </form>
    <div id="flResults"><p class="muted">Loading…</p></div>`;
  const show = async () => {
    const params = new URLSearchParams(Object.entries(freelancerSearch).filter(([, v]) => v));
    const list = await api("GET", `/public/freelancers?${params}`);
    $("#flResults").innerHTML = list.length
      ? `<p class="muted">${list.length} ${list.length === 1 ? "freelancer" : "freelancers"}</p><div class="fl-grid">${list.map(freelancerCard).join("")}</div>`
      : `<div class="card muted">No freelancers match. Try fewer words or a wider filter.</div>`;
  };
  const form = $("#flSearch");
  form.onsubmit = (e) => { e.preventDefault(); Object.assign(freelancerSearch, formData(form)); show().catch((err) => toast(err.message, true)); };
  form.querySelectorAll("select").forEach((sel) => (sel.onchange = () => form.requestSubmit()));
  await show();
}

// A freelancer's public profile: portfolio and packages. Clients can buy a package here.
async function renderPublicProfile(view, id) {
  const f = await api("GET", `/public/freelancers/${id}`);
  const canBuy = !state.user || state.user.role === "client";
  const own = state.user && state.user.id === f.id;
  view.innerHTML = `
    <p><a href="#/freelancers">← All freelancers</a></p>
    <section class="profile-head card">
      ${avatar(f.full_name, "xl")}
      <div class="profile-main">
        <h1>${esc(f.full_name)}</h1>
        <p>${esc(f.bio || "No bio yet.")}</p>
        <div class="tags">${skillTags(f.skills)}</div>
        <p class="fl-rating">${starLine(f.rating, f.reviews)}</p>
        <p class="muted">${f.completed_jobs} ${f.completed_jobs === 1 ? "job" : "jobs"} completed on Trustlance · member since ${esc(String(f.member_since).slice(0, 10))}</p>
      </div>
      ${own ? `<a class="btn" href="#/portfolio">Edit portfolio</a>` : ""}
    </section>

    <h2 class="section-title">Packages</h2>
    ${f.packages.length ? `<div class="pkg-grid">${f.packages.map((p) => packageCard(p, { canBuy: canBuy && !own })).join("")}</div>`
      : `<div class="card muted">No packages offered right now.</div>`}
    ${!state.user && f.packages.length ? `<p class="muted">Log in as a client to buy a package.</p>` : ""}

    <h2 class="section-title" style="margin-top:28px">Portfolio</h2>
    ${f.portfolio.length ? `<div class="port-grid">${f.portfolio.map((p) => `
      <div class="port-item">
        <h3>${esc(p.title)}</h3>
        ${p.result ? `<p class="port-result">${esc(p.result)}</p>` : ""}
        <p>${esc(p.description)}</p>
        ${p.link ? `<p class="muted">${webLink(p.link)}</p>` : ""}
      </div>`).join("")}</div>` : `<div class="card muted">No portfolio items yet.</div>`}

    <h2 class="section-title" style="margin-top:28px">Reviews</h2>
    ${f.review_list.length ? `<div class="card">${f.review_list.map((r) => `<div class="review">
        <span class="stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span> <strong>${esc(r.reviewer)}</strong>
        <span class="muted">· ${esc(r.job_title)} · ${esc(String(r.created_at).slice(0, 10))}</span>
        ${r.comment ? `<p>${esc(r.comment)}</p>` : ""}</div>`).join("")}</div>`
      : `<div class="card muted">No reviews yet. Reviews appear after a completed job.</div>`}`;
  wireBuyButtons(view);
}

// A freelancer manages their own portfolio items and packages.
async function renderMyPortfolio(view) {
  const [items, packages] = await Promise.all([api("GET", "/me/portfolio"), api("GET", "/me/packages")]);
  view.innerHTML = `
    <div class="row spread"><div><h1>Portfolio & packages</h1><p class="sub">This is what clients see on your public profile.</p></div>
      <a class="btn" href="#/u/${state.user.id}">View my public profile</a></div>
    <div class="grid">
      <div class="card">
        <h2>Add a package</h2>
        <p class="muted">A fixed offer a client can buy directly. Each case becomes a milestone paid from escrow.</p>
        <form id="pkgForm">
          <label>Title</label><input name="title" required maxlength="120" placeholder="Media buying starter: 3 campaigns" />
          <label>What is included</label><textarea name="description" maxlength="2000"></textarea>
          <div class="row"><div style="flex:1"><label>Number of cases</label><input name="cases" type="number" min="1" max="12" value="3" required /></div>
            <div style="flex:1"><label>Total price (ETH)</label><input name="price_eth" required placeholder="0.9" /></div>
            <div style="flex:1"><label>Delivery (days)</label><input name="delivery_days" type="number" min="1" max="365" value="30" /></div></div>
          <div class="row" style="margin-top:14px"><button>Add package</button></div>
        </form>
      </div>
      <div class="card">
        <h2>Add portfolio work</h2>
        <form id="portForm">
          <label>Title</label><input name="title" required maxlength="120" placeholder="Ramadan campaign for a fashion store" />
          <label>Result (one line)</label><input name="result" maxlength="120" placeholder="ROAS 4.2x on 60,000 EGP spend" />
          <label>Description</label><textarea name="description" maxlength="2000"></textarea>
          <label>Link (optional)</label><input name="link" placeholder="https://" />
          <div class="row" style="margin-top:14px"><button>Add to portfolio</button></div>
        </form>
      </div>
    </div>
    <h2 class="section-title">Your packages</h2>
    <div class="card">${packages.length ? `<table><tr><th>Package</th><th>Cases</th><th>Price</th><th>Status</th><th></th></tr>
      ${packages.map((p) => `<tr><td>${esc(p.title)}</td><td>${p.cases}</td><td>${esc(p.price_eth)} ETH</td><td>${pill(p.active ? "offered" : "hidden", p.active ? "released" : "")}</td>
        <td><button class="secondary" data-toggle="${p.id}" data-active="${p.active ? 0 : 1}">${p.active ? "Hide" : "Offer again"}</button></td></tr>`).join("")}</table>`
      : `<p class="muted">No packages yet.</p>`}</div>
    <h2 class="section-title">Your portfolio</h2>
    ${items.length ? `<div class="port-grid">${items.map((p) => `
      <div class="port-item"><h3>${esc(p.title)}</h3>${p.result ? `<p class="port-result">${esc(p.result)}</p>` : ""}<p>${esc(p.description)}</p>
        ${p.link ? `<p class="muted">${webLink(p.link)}</p>` : ""}
        <button class="secondary small" data-del="${p.id}">Remove</button></div>`).join("")}</div>`
      : `<div class="card muted">No portfolio items yet.</div>`}`;
  $("#pkgForm").onsubmit = (e) => { e.preventDefault(); act(() => api("POST", "/me/packages", formData(e.target)), "Package added"); };
  $("#portForm").onsubmit = (e) => { e.preventDefault(); act(() => api("POST", "/me/portfolio", formData(e.target)), "Added to your portfolio"); };
  view.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = () => act(() => api("PUT", `/me/packages/${b.dataset.toggle}`, { active: b.dataset.active === "1" }), "Package updated");
  });
  view.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => { if (confirm("Remove this item from your portfolio?")) act(() => api("DELETE", `/me/portfolio/${b.dataset.del}`), "Removed"); };
  });
}

function renderLogin(view) {
  view.innerHTML = `
    <div class="login">
      <div class="card">
        <h1>Log in</h1>
        <p class="sub">Milestone payments held in escrow, checked by an explainable risk score.</p>
        <form id="loginForm">
          <label>Email</label><input name="email" type="email" required />
          <label>Password</label><input name="password" type="password" required />
          <div class="row" style="margin-top:14px"><button>Log in</button></div>
        </form>
        <p class="muted demo-logins">Demo accounts (password demo1234):<br>
          <button class="secondary" data-e="client@demo.com">Client</button>
          <button class="secondary" data-e="freelancer@demo.com">Freelancer</button>
          <button class="secondary" data-e="risky@demo.com">Risky freelancer</button>
          <button class="secondary" data-e="arbiter@demo.com">Arbiter</button>
        </p>
      </div>
      <div class="card">
        <h2>Create an account</h2>
        <form id="regForm">
          <label>Full name</label><input name="full_name" required />
          <label>Email</label><input name="email" type="email" required />
          <label>Password (8+ characters)</label><input name="password" type="password" minlength="8" required />
          <label>I am a</label>
          <select name="role"><option value="client">Client</option><option value="freelancer">Freelancer</option><option value="arbiter">Arbiter</option></select>
          <div class="row" style="margin-top:14px"><button>Create account</button></div>
        </form>
      </div>
    </div>`;
  $("#loginForm").onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); act(() => login(d.email, d.password)); };
  view.querySelectorAll("[data-e]").forEach((b) => (b.onclick = () => act(() => login(b.dataset.e, "demo1234"))));
  $("#regForm").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const r = await api("POST", "/auth/register", formData(e.target));
      state.token = r.token;
      localSet("tl_token", r.token);
      location.hash = "#/";
    }, "Account created");
  };
}

async function renderClientHome(view) {
  const [jobs, freelancers] = await Promise.all([
    api("GET", "/jobs?mine=1"),
    api("GET", "/public/freelancers").catch(() => []),
  ]);
  // Recommended: freelancers with the most completed jobs first, then the fullest portfolios.
  const recommended = freelancers
    .filter((f) => f.portfolio_count > 0 || f.packages > 0)
    .sort((a, b) => b.completed_jobs - a.completed_jobs || b.portfolio_count - a.portfolio_count)
    .slice(0, 3);
  view.innerHTML = `
    <h1>My jobs</h1><p class="sub">Post a job and accept a proposal, or <a href="#/freelancers">buy a package from a freelancer</a>. Then pay milestone by milestone.</p>
    <div class="grid">
      <div class="card">
        <h2>Post a job</h2>
        <form id="jobForm">
          <label>Title</label><input name="title" required />
          <label>Description</label><textarea name="description" required></textarea>
          <label>Budget (ETH)</label><input name="budget_eth" required placeholder="1.5" />
          <label>Skills</label><input name="skills" placeholder="React, Solidity" />
          <div class="row" style="margin-top:14px"><button>Post job</button></div>
        </form>
      </div>
      <div class="card">
        <h2>Your jobs</h2>
        ${jobs.length ? `<table><tr><th>Job</th><th>Budget</th><th>Status</th></tr>
          ${jobs.map((j) => `<tr><td><a href="#/job/${j.id}">${esc(j.title)}</a> ${unreadBadge(j)}</td><td>${esc(j.budget_eth)} ETH</td><td>${pill(j.status)}</td></tr>`).join("")}
        </table>` : `<p class="muted">No jobs yet.</p>`}
      </div>
    </div>
    ${recommended.length ? `<section style="margin-top:12px">
      <div class="section-head"><h2 class="section-title">Recommended freelancers</h2><a href="#/freelancers">See all freelancers →</a></div>
      <p class="sub">Open a profile to see their portfolio and buy one of their packages.</p>
      <div class="fl-grid">${recommended.map(freelancerCard).join("")}</div>
    </section>` : ""}`;
  $("#jobForm").onsubmit = (e) => { e.preventDefault(); act(() => api("POST", "/jobs", formData(e.target)), "Job posted"); };
}

const jobSearch = { q: "", min_budget: "" };

async function renderFindWork(view) {
  const params = new URLSearchParams(Object.entries(jobSearch).filter(([, v]) => v));
  const jobs = await api("GET", `/jobs?${params}`);
  view.innerHTML = `
    <h1>Find work</h1><p class="sub">Open jobs. Payment for each milestone is locked in escrow before you start.</p>
    <form id="jobSearch" class="search-bar card">
      <input name="q" placeholder="Search jobs by title, description or skill" value="${esc(jobSearch.q)}" />
      <select name="min_budget"><option value="">Any budget</option>${["0.5", "1", "2"].map((b) => `<option value="${b}" ${jobSearch.min_budget === b ? "selected" : ""}>${b} ETH or more</option>`).join("")}</select>
      <button>Search</button>
    </form>
    ${jobSearch.q || jobSearch.min_budget ? `<p class="muted">${jobs.length} matching ${jobs.length === 1 ? "job" : "jobs"}</p>` : ""}
    ${jobs.map((j) => `
      <div class="card">
        <div class="row spread"><h2>${esc(j.title)}</h2><strong>${esc(j.budget_eth)} ETH</strong></div>
        <p>${esc(j.description)}</p>
        <p class="muted">Client: ${esc(j.client_name)} · Skills: ${esc(j.skills || "any")}</p>
        <form data-job="${j.id}" class="proposal">
          <label>Cover letter</label><textarea name="cover_letter" required></textarea>
          <label>Your price (ETH)</label><input name="price_eth" required />
          <div class="row" style="margin-top:12px"><button>Send proposal</button></div>
        </form>
      </div>`).join("") || `<div class="card muted">${jobSearch.q || jobSearch.min_budget ? "No jobs match your search." : "No open jobs right now."}</div>`}`;
  const sf = $("#jobSearch");
  sf.onsubmit = (e) => { e.preventDefault(); Object.assign(jobSearch, formData(sf)); render(); };
  sf.querySelector("select").onchange = () => sf.requestSubmit();
  view.querySelectorAll("form.proposal").forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); act(() => api("POST", `/jobs/${f.dataset.job}/proposals`, formData(f)), "Proposal sent"); };
  });
}

async function renderMyJobs(view) {
  const jobs = await api("GET", "/jobs?mine=1");
  view.innerHTML = `<h1>My jobs</h1><p class="sub">Jobs you were hired for.</p>
    <div class="card">${jobs.length ? `<table><tr><th>Job</th><th>Budget</th><th>Status</th></tr>
      ${jobs.map((j) => `<tr><td><a href="#/job/${j.id}">${esc(j.title)}</a> ${unreadBadge(j)}</td><td>${esc(j.budget_eth)} ETH</td><td>${pill(j.status)}</td></tr>`).join("")}</table>`
      : `<p class="muted">No accepted proposals yet.</p>`}</div>`;
}

function riskBlock(m, detail) {
  const r = detail && detail.risk.length ? detail.risk[detail.risk.length - 1] : null;
  if (!r) return "";
  return `<div class="reason ${r.band === "low" ? "ok" : ""}">
    ${pill(`risk ${r.band} · ${Number(r.score).toFixed(2)}`, r.band)} ${esc(r.reason)}
    ${m.risk_flagged && ["funded", "submitted"].includes(m.status) && m.review_deadline ? `<div class="muted">Held for arbiter review until ${esc(new Date(m.review_deadline).toLocaleString())}</div>` : ""}
  </div>`;
}

// Budget not yet planned into milestones (refunded and cancelled ones give their amount back).
// Works in wei-like integers so 1.5 - 0.6 shows 0.9, not 0.8999999.
function budgetLeft(job) {
  const wei = (s) => { const [w, f = ""] = String(s).split("."); return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, "0").slice(0, 18)); };
  const used = job.milestones.filter((m) => !["refunded", "cancelled"].includes(m.status)).reduce((s, m) => s + wei(m.amount_eth), 0n);
  const left = wei(job.budget_eth) - used;
  if (left <= 0n) return "0";
  const whole = left / 10n ** 18n, frac = (left % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// The job chat: loads the messages, sends new ones, and checks for replies every 4 seconds while the
// job page is open. Only the chat box is redrawn, so nothing typed elsewhere on the page is lost.
function startChat(jobId) {
  clearInterval(state.chatTimer);
  const route = `#/job/${jobId}`;
  let lastId = -1;
  const load = async () => {
    const list = $("#chatList");
    if (!list || location.hash !== route) { clearInterval(state.chatTimer); return; }
    let msgs;
    try { msgs = await api("GET", `/jobs/${jobId}/messages`); } catch { return; }
    const newest = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (newest === lastId) return;
    lastId = newest;
    list.innerHTML = msgs.length
      ? msgs.map((m) => `<div class="msg ${m.sender_id === state.user.id ? "mine" : ""}">
          <div class="msg-meta">${esc(m.sender_name)} · ${esc(new Date(m.created_at.replace(" ", "T") + "Z").toLocaleString())}</div>
          <div class="msg-body">${esc(m.body)}</div></div>`).join("")
      : `<p class="muted">No messages yet. Say hello and agree on the details.</p>`;
    list.scrollTop = list.scrollHeight;
  };
  load();
  state.chatTimer = setInterval(load, 4000);
  const form = $("#chatForm");
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    const body = input.value.trim();
    if (!body) return;
    input.disabled = true;
    try {
      await api("POST", `/jobs/${jobId}/messages`, { body });
      input.value = "";
      await load();
    } catch (err) {
      toast(err.message, true);
    } finally {
      input.disabled = false;
      input.focus();
    }
  };
}

async function renderJob(view, id) {
  const job = await api("GET", `/jobs/${id}`);
  const role = state.user.role;
  const isClient = role === "client" && job.client_id === state.user.id;
  const proposals = isClient && job.status === "open" ? await api("GET", `/jobs/${id}/proposals`) : [];
  const details = await Promise.all(job.milestones.map((m) => api("GET", `/milestones/${m.id}`)));
  const me = state.user.id;
  const isParty = me === job.client_id || me === job.freelancer_id;
  const hasChat = Boolean(job.freelancer_id) && (isParty || me === job.arbiter_id);
  const reviews = job.status === "completed" && (isParty || me === job.arbiter_id) ? await api("GET", `/jobs/${id}/reviews`) : [];
  const canReview = job.status === "completed" && isParty && !reviews.some((r) => r.reviewer_id === me);
  const stars = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  const milestoneCard = (m, d) => {
    const buttons = [];
    if (isClient && m.status === "pending") {
      buttons.push(`<button data-a="fund" data-id="${m.id}">Fund ${esc(m.amount_eth)} ETH</button>`);
      buttons.push(`<button class="secondary" data-a="cancel" data-id="${m.id}">Cancel milestone</button>`);
    }
    if (isClient && m.status === "submitted") {
      buttons.push(`<button data-a="approve" data-id="${m.id}">Approve and release</button>`);
      if (!m.risk_flagged) {
        buttons.push(`<button class="secondary" data-a="changes" data-id="${m.id}">Request changes</button>`);
      }
      buttons.push(`<button class="secondary" data-a="dispute" data-id="${m.id}">Dispute</button>`);
    }
    if (role === "freelancer" && m.status === "funded") {
      buttons.push(`<input placeholder="Link to your work" id="url-${m.id}" style="max-width:320px" /><button data-a="submit" data-id="${m.id}">Submit work</button>`);
    }
    if (role === "freelancer" && m.risk_flagged && !m.appealed && ["funded", "submitted"].includes(m.status)) {
      buttons.push(`<input placeholder="Why the flag is wrong" id="note-${m.id}" style="max-width:320px" /><button class="secondary" data-a="appeal" data-id="${m.id}">Appeal flag</button>`);
    }
    // The latest change request, shown while the work is back with the freelancer.
    const lastChange = [...d.history].reverse().find((h) => h.event === "changes_requested");
    const revisions = d.history.filter((h) => h.event === "changes_requested").length;
    return `<div class="card">
      <div class="row spread"><h2>${esc(m.title)}</h2><div>${esc(m.amount_eth)} ETH ${pill(m.status)} ${m.risk_flagged ? pill("flagged") : ""} ${m.appealed ? pill("appealed") : ""} ${revisions ? pill(`${revisions} ${revisions === 1 ? "revision" : "revisions"}`, "medium") : ""}</div></div>
      ${lastChange && m.status === "funded" ? `<div class="reason warn"><strong>Changes requested:</strong> ${esc(lastChange.detail)}</div>` : ""}
      ${m.deliverable_url ? `<p class="muted">Deliverable: ${webLink(m.deliverable_url)}</p>` : ""}
      ${riskBlock(m, d)}
      <div class="row">${buttons.join("")}</div>
      <details style="margin-top:10px"><summary class="muted">History</summary><ul class="timeline">
        ${d.history.map((h) => `<li><strong>${esc(h.event.replace(/_/g, " "))}</strong> · ${esc(h.actor)} · ${esc(h.detail)} ${h.tx_hash ? `<span class="mono">tx ${esc(h.tx_hash.slice(0, 12))}…</span>` : ""}</li>`).join("")}
      </ul></details>
    </div>`;
  };

  view.innerHTML = `
    <p><a href="#/">← Back</a></p>
    <div class="card">
      <div class="row spread"><h1>${esc(job.title)}</h1>${pill(job.status)}</div>
      ${job.package_id ? `<p class="muted">Bought as a package from <a href="#/u/${job.freelancer_id}">the freelancer's profile</a>. Fund each case to start it.</p>` : ""}
      <p>${esc(job.description)}</p>
      <p class="muted">Budget ${esc(job.budget_eth)} ETH${job.escrow_address ? ` · Escrow contract <span class="mono">${esc(job.escrow_address)}</span>` : ""}</p>
    </div>
    ${isClient && job.status === "open" ? `<div class="card"><h2>Proposals</h2>${proposals.length ? `<table><tr><th>Freelancer</th><th>Cover letter</th><th>Price</th><th></th></tr>
      ${proposals.map((p) => `<tr><td>${esc(p.freelancer_name)}<div class="muted">${esc(p.freelancer_skills)}</div></td><td>${esc(p.cover_letter)}</td><td>${esc(p.price_eth)} ETH</td>
        <td><button data-accept="${p.id}">Accept</button></td></tr>`).join("")}</table>` : `<p class="muted">No proposals yet.</p>`}</div>` : ""}
    ${job.status !== "open" ? `<h2 style="margin-top:8px">Milestones</h2>${job.milestones.map((m, i) => milestoneCard(m, details[i])).join("") || `<p class="muted">No milestones yet.</p>`}` : ""}
    ${isClient && job.status === "in_progress" ? `<div class="card"><h2>Add a milestone</h2>
      <p class="muted">Budget left: ${esc(budgetLeft(job))} ETH of ${esc(job.budget_eth)} ETH</p>
      <form id="msForm" class="row"><input name="title" placeholder="Title" required style="max-width:300px" />
      <input name="amount_eth" placeholder="Amount (ETH)" required style="max-width:160px" /><button>Add</button></form>
      ${job.milestones.length && job.milestones.every((m) => ["released", "refunded", "cancelled"].includes(m.status))
        ? `<div class="row" style="margin-top:12px"><button class="secondary" id="closeJob">Close job</button>
           <span class="muted">All milestones are settled. Close the job if the work is finished.</span></div>` : ""}</div>` : ""}
    ${job.status === "completed" && (reviews.length || canReview) ? `<div class="card">
      <h2>Reviews</h2>
      ${reviews.map((r) => `<div class="review"><span class="stars">${stars(r.rating)}</span> <strong>${esc(r.reviewer_name)}</strong>
        ${r.comment ? `<p>${esc(r.comment)}</p>` : ""}</div>`).join("") || `<p class="muted">No reviews yet.</p>`}
      ${canReview ? `<form id="reviewForm" class="review-form">
        <label>Your rating of the ${me === job.client_id ? "freelancer" : "client"}</label>
        <div class="star-pick">${[5, 4, 3, 2, 1].map((n) => `<input type="radio" name="rating" id="r${n}" value="${n}" ${n === 5 ? "checked" : ""}/><label for="r${n}" title="${n} stars">★</label>`).join("")}</div>
        <label>Comment (optional)</label><textarea name="comment" maxlength="1000"></textarea>
        <div class="row" style="margin-top:12px"><button>Post review</button></div>
      </form>` : ""}
    </div>` : ""}
    ${hasChat ? `<div class="card" id="chat">
      <h2>Messages</h2>
      ${!isParty ? `<p class="muted">You can read this conversation as the job's arbiter.</p>` : ""}
      <div class="chat-list" id="chatList"><p class="muted">Loading…</p></div>
      ${isParty ? `<form id="chatForm" class="chat-form"><input name="body" placeholder="Write a message" maxlength="2000" autocomplete="off" required /><button>Send</button></form>` : ""}
    </div>` : ""}`;

  const reviewForm = $("#reviewForm");
  if (reviewForm) reviewForm.onsubmit = (e) => {
    e.preventDefault();
    const d = formData(reviewForm);
    act(() => api("POST", `/jobs/${id}/reviews`, { rating: Number(d.rating), comment: d.comment }), "Review posted");
  };
  if (hasChat) startChat(id);

  view.querySelectorAll("[data-accept]").forEach((b) => {
    b.onclick = () => act(() => api("POST", `/proposals/${b.dataset.accept}/accept`), "Proposal accepted. Escrow contract deployed.");
  });
  const closeJob = $("#closeJob");
  if (closeJob) closeJob.onclick = () => {
    if (confirm("Close this job? No more milestones can be added after this.")) act(() => api("POST", `/jobs/${id}/complete`), "Job closed");
  };
  const msForm = $("#msForm");
  if (msForm) msForm.onsubmit = (e) => { e.preventDefault(); act(() => api("POST", `/jobs/${id}/milestones`, formData(msForm)), "Milestone added"); };
  view.querySelectorAll("[data-a]").forEach((b) => {
    const mid = b.dataset.id;
    b.onclick = () => {
      b.disabled = true;
      const a = b.dataset.a;
      if (a === "fund") return act(() => api("POST", `/milestones/${mid}/fund`), "Funds locked in escrow");
      if (a === "cancel") return act(() => api("POST", `/milestones/${mid}/cancel`), "Milestone cancelled");
      if (a === "approve") return act(() => api("POST", `/milestones/${mid}/approve`), "Payment released");
      if (a === "dispute") return act(() => api("POST", `/milestones/${mid}/dispute`, { reason: "Disputed by client" }), "Sent to the arbiter");
      if (a === "changes") {
        const note = prompt("What should the freelancer change?");
        if (!note || !note.trim()) { b.disabled = false; return; }
        return act(() => api("POST", `/milestones/${mid}/request-changes`, { note }), "Sent back to the freelancer with your note");
      }
      if (a === "appeal") return act(() => api("POST", `/milestones/${mid}/appeal`, { note: $(`#note-${mid}`).value }), "Appeal recorded on-chain");
      if (a === "submit") {
        toast("Submitting. The risk engine is scoring your payout wallet…");
        return act(async () => {
          const r = await api("POST", `/milestones/${mid}/submit`, { deliverable_url: $(`#url-${mid}`).value });
          toast(`Submitted. Risk ${r.risk.band} (${r.risk.score.toFixed(2)})`);
        });
      }
    };
  });
}

async function renderArbiterQueue(view) {
  const [queue, jobs] = await Promise.all([api("GET", "/arbiter/queue"), api("GET", "/jobs?mine=1")]);
  view.innerHTML = `
    <h1>Review queue</h1><p class="sub">Flagged and disputed milestones on your jobs. You decide; the contract only lets you release or refund.</p>
    ${queue.map((q) => `
      <div class="card">
        <div class="row spread"><h2>${esc(q.job_title)} · ${esc(q.title)}</h2><div>${esc(q.amount_eth)} ETH ${pill(q.status)} ${q.risk_flagged ? pill("flagged") : ""}</div></div>
        <p class="muted">Client ${esc(q.client_name)} · Freelancer ${esc(q.freelancer_name)}${q.review_deadline ? ` · Review window ends ${esc(new Date(q.review_deadline).toLocaleString())}` : ""}</p>
        ${q.risk_reason ? `<div class="reason">${pill(`risk ${Number(q.risk_score).toFixed(2)}`, "high")} ${esc(q.risk_reason)}</div>` : ""}
        ${q.appeal_note ? `<p><strong>Freelancer's appeal:</strong> ${esc(q.appeal_note)}</p>` : ""}
        ${q.deliverable_url ? `<p class="muted">Deliverable: ${webLink(q.deliverable_url)}</p>` : ""}
        <div class="row"><button data-d="release" data-id="${q.id}">Release to freelancer</button><button class="danger" data-d="refund" data-id="${q.id}">Refund client</button>
          <a href="#/job/${q.job_id}" class="muted">Full history</a></div>
      </div>`).join("") || `<div class="card muted">Nothing to review.</div>`}
    <div class="card"><h2>Your jobs</h2>${jobs.length ? `<table><tr><th>Job</th><th>Status</th><th>Emergency</th></tr>
      ${jobs.map((j) => `<tr><td><a href="#/job/${j.id}">${esc(j.title)}</a></td><td>${pill(j.status)}</td>
        <td>${j.status !== "in_progress" ? `<span class="muted">Not needed</span>`
          : j.paused ? `${pill("paused")} <button class="secondary" data-p="unpause" data-j="${j.id}">Unpause</button>`
          : `<button class="secondary" data-p="pause" data-j="${j.id}">Pause</button>`}</td></tr>`).join("")}</table>`
      : `<p class="muted">No jobs assigned.</p>`}</div>`;
  view.querySelectorAll("[data-d]").forEach((b) => {
    b.onclick = () => {
      const release = b.dataset.d === "release";
      // Arbiter decisions move money on-chain and cannot be undone, so ask first.
      if (!confirm(release ? "Release this payment to the freelancer? This cannot be undone." : "Refund this payment to the client? This cannot be undone.")) return;
      act(() => api("POST", `/arbiter/milestones/${b.dataset.id}/${b.dataset.d}`), release ? "Released" : "Refunded");
    };
  });
  view.querySelectorAll("[data-p]").forEach((b) => {
    b.onclick = () => act(() => api("POST", `/arbiter/jobs/${b.dataset.j}/${b.dataset.p}`), b.dataset.p === "pause" ? "Contract paused" : "Contract unpaused");
  });
}

async function renderProfile(view) {
  const [me, notes] = await Promise.all([api("GET", "/users/me"), api("GET", "/users/me/notifications")]);
  view.innerHTML = `
    <h1>Profile</h1><p class="sub">${pill(me.role)} ${esc(me.email)}</p>
    <div class="grid">
      <div class="card">
        <form id="profForm">
          <label>Full name</label><input name="full_name" value="${esc(me.full_name)}" />
          <label>Bio</label><textarea name="bio">${esc(me.bio)}</textarea>
          <label>Skills</label><input name="skills" value="${esc(me.skills)}" />
          ${me.role === "freelancer" ? `<p class="muted" style="margin-top:12px">Development only: the risk engine scores a real dataset wallet (${esc(me.dev_risk_profile)}) as your payout history. It is set when the account is created and cannot be changed here.</p>` : ""}
          <div class="row" style="margin-top:14px"><button>Save</button></div>
        </form>
      </div>
      <div class="card">
        <h2>Wallet</h2>
        <p class="mono">${esc(me.wallet_address)}</p>
        <p>Balance: <strong>${Number(me.balance_eth).toFixed(4)} ETH</strong> <span class="muted">(local test chain)</span></p>
        <h2 style="margin-top:18px">Notifications</h2>
        ${notes.length ? `<ul class="timeline">${notes.slice(0, 10).map((n) => `<li>${esc(n.message)}</li>`).join("")}</ul>` : `<p class="muted">None yet.</p>`}
      </div>
    </div>`;
  $("#profForm").onsubmit = (e) => {
    e.preventDefault();
    act(async () => { state.user = { ...state.user, ...(await api("PUT", "/users/me", formData(e.target))) }; }, "Saved");
  };
}

window.addEventListener("hashchange", render);
render();
