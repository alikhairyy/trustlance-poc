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
  client: [["#/", "My jobs"], ["#/profile", "Profile"]],
  freelancer: [["#/", "Find work"], ["#/mine", "My jobs"], ["#/profile", "Profile"]],
  arbiter: [["#/", "Review queue"], ["#/profile", "Profile"]],
};

function renderChrome() {
  const route = location.hash || "#/";
  $("#nav").innerHTML = state.user
    ? NAV[state.user.role].map(([h, l]) => `<a href="${h}" class="${route === h ? "active" : ""}">${l}</a>`).join("")
    : `<a href="#/" class="${route === "#/" ? "active" : ""}">Home</a><a href="#/login" class="${route === "#/login" ? "active" : ""}">Log in</a>`;
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
  if (!state.user) return (location.hash === "#/login" ? renderLogin : renderLanding)(view);

  const route = location.hash || "#/";
  const jobMatch = route.match(/^#\/job\/(\d+)$/);
  try {
    if (route === "#/profile") return await renderProfile(view);
    if (jobMatch) return await renderJob(view, Number(jobMatch[1]));
    if (state.user.role === "client") return await renderClientHome(view);
    if (state.user.role === "freelancer") return route === "#/mine" ? await renderMyJobs(view) : await renderFindWork(view);
    return await renderArbiterQueue(view);
  } catch (e) {
    view.innerHTML = `<div class="card">${esc(e.message)}</div>`;
  }
}

// ---------- screens ----------

// Public landing page: what Trustlance does, for visitors who are not logged in.
function renderLanding(view) {
  view.innerHTML = `
    <section class="hero">
      <p class="eyebrow">Freelance payments with escrow, explainable AI and a human in the loop</p>
      <h1>Get paid for every milestone, and know why if a payment is held.</h1>
      <p class="hero-sub">Trustlance locks each milestone payment in a smart contract. When work is submitted, an AI model checks the wallet that will receive the money and explains its score in plain words. Normal payments go through at once. A risky one waits for a human arbiter, for seven days at most.</p>
      <div class="row">
        <a class="btn" href="#/login">Get started</a>
        <button class="secondary" id="howBtn">See how it works</button>
      </div>
    </section>

    <section class="facts">
      <div><strong>0.92</strong><span>ROC-AUC of the risk model on 8,731 real labelled wallets</span></div>
      <div><strong>7 days</strong><span>longest the AI can hold a payment; it can never move money</span></div>
      <div><strong>100%</strong><span>of flags come with a written reason the freelancer can appeal</span></div>
    </section>

    <section id="how">
      <h2 class="section-title">How it works</h2>
      <div class="grid steps-grid">
        <div class="card step-card"><span class="step-n">1</span><h3>The client funds a milestone</h3><p>The agreed amount is locked in a smart contract made for the job. Neither side, and not the platform, can take it out alone.</p></div>
        <div class="card step-card"><span class="step-n">2</span><h3>The freelancer submits the work</h3><p>Our risk engine scores the payout wallet from 0 to 1 and names the three facts that moved the score most.</p></div>
        <div class="card step-card"><span class="step-n">3</span><h3>Paid now, or reviewed by a person</h3><p>Low risk: the client approves and the money is released at once. High risk: the payment is held, the freelancer can appeal, and an arbiter decides.</p></div>
      </div>
    </section>

    <section>
      <h2 class="section-title">Built for everyone in the job</h2>
      <div class="grid">
        <div class="card"><h3>Freelancers</h3><p>The money for each milestone is locked before you start. If a payment is ever held, you see exactly why and can appeal on the record.</p></div>
        <div class="card"><h3>Clients</h3><p>You pay into escrow, approve when you are happy, and can dispute work that was not delivered. Payouts to wallets that look like fraud are stopped for review.</p></div>
        <div class="card"><h3>Arbiters</h3><p>One queue with the score, the reason, the appeal and the deliverable side by side. The contract lets you release or refund, nothing else.</p></div>
      </div>
    </section>

    <section class="cta card">
      <div>
        <h2>Try it with the demo accounts</h2>
        <p class="muted">Log in as a client, a freelancer or an arbiter and follow one payment from start to finish.</p>
      </div>
      <a class="btn" href="#/login">Open the demo</a>
    </section>

    <p class="footer-note">Trustlance is a graduation project at ESLSCA University, running on a test blockchain with test ETH. No real money is involved.</p>`;
  $("#howBtn").onclick = () => $("#how").scrollIntoView({ behavior: "smooth" });
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
  const jobs = await api("GET", "/jobs?mine=1");
  view.innerHTML = `
    <h1>My jobs</h1><p class="sub">Post a job, accept a proposal, then pay milestone by milestone.</p>
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
          ${jobs.map((j) => `<tr><td><a href="#/job/${j.id}">${esc(j.title)}</a></td><td>${esc(j.budget_eth)} ETH</td><td>${pill(j.status)}</td></tr>`).join("")}
        </table>` : `<p class="muted">No jobs yet.</p>`}
      </div>
    </div>`;
  $("#jobForm").onsubmit = (e) => { e.preventDefault(); act(() => api("POST", "/jobs", formData(e.target)), "Job posted"); };
}

async function renderFindWork(view) {
  const jobs = await api("GET", "/jobs");
  view.innerHTML = `
    <h1>Find work</h1><p class="sub">Open jobs. Payment for each milestone is locked in escrow before you start.</p>
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
      </div>`).join("") || `<div class="card muted">No open jobs right now.</div>`}`;
  view.querySelectorAll("form.proposal").forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); act(() => api("POST", `/jobs/${f.dataset.job}/proposals`, formData(f)), "Proposal sent"); };
  });
}

async function renderMyJobs(view) {
  const jobs = await api("GET", "/jobs?mine=1");
  view.innerHTML = `<h1>My jobs</h1><p class="sub">Jobs you were hired for.</p>
    <div class="card">${jobs.length ? `<table><tr><th>Job</th><th>Budget</th><th>Status</th></tr>
      ${jobs.map((j) => `<tr><td><a href="#/job/${j.id}">${esc(j.title)}</a></td><td>${esc(j.budget_eth)} ETH</td><td>${pill(j.status)}</td></tr>`).join("")}</table>`
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

async function renderJob(view, id) {
  const job = await api("GET", `/jobs/${id}`);
  const role = state.user.role;
  const isClient = role === "client" && job.client_id === state.user.id;
  const proposals = isClient && job.status === "open" ? await api("GET", `/jobs/${id}/proposals`) : [];
  const details = await Promise.all(job.milestones.map((m) => api("GET", `/milestones/${m.id}`)));

  const milestoneCard = (m, d) => {
    const buttons = [];
    if (isClient && m.status === "pending") {
      buttons.push(`<button data-a="fund" data-id="${m.id}">Fund ${esc(m.amount_eth)} ETH</button>`);
      buttons.push(`<button class="secondary" data-a="cancel" data-id="${m.id}">Cancel milestone</button>`);
    }
    if (isClient && m.status === "submitted") {
      buttons.push(`<button data-a="approve" data-id="${m.id}">Approve and release</button>`);
      buttons.push(`<button class="secondary" data-a="dispute" data-id="${m.id}">Dispute</button>`);
    }
    if (role === "freelancer" && m.status === "funded") {
      buttons.push(`<input placeholder="Link to your work" id="url-${m.id}" style="max-width:320px" /><button data-a="submit" data-id="${m.id}">Submit work</button>`);
    }
    if (role === "freelancer" && m.risk_flagged && !m.appealed && ["funded", "submitted"].includes(m.status)) {
      buttons.push(`<input placeholder="Why the flag is wrong" id="note-${m.id}" style="max-width:320px" /><button class="secondary" data-a="appeal" data-id="${m.id}">Appeal flag</button>`);
    }
    return `<div class="card">
      <div class="row spread"><h2>${esc(m.title)}</h2><div>${esc(m.amount_eth)} ETH ${pill(m.status)} ${m.risk_flagged ? pill("flagged") : ""} ${m.appealed ? pill("appealed") : ""}</div></div>
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
      <p>${esc(job.description)}</p>
      <p class="muted">Budget ${esc(job.budget_eth)} ETH${job.escrow_address ? ` · Escrow contract <span class="mono">${esc(job.escrow_address)}</span>` : ""}</p>
    </div>
    ${isClient && job.status === "open" ? `<div class="card"><h2>Proposals</h2>${proposals.length ? `<table><tr><th>Freelancer</th><th>Cover letter</th><th>Price</th><th></th></tr>
      ${proposals.map((p) => `<tr><td>${esc(p.freelancer_name)}<div class="muted">${esc(p.freelancer_skills)}</div></td><td>${esc(p.cover_letter)}</td><td>${esc(p.price_eth)} ETH</td>
        <td><button data-accept="${p.id}">Accept</button></td></tr>`).join("")}</table>` : `<p class="muted">No proposals yet.</p>`}</div>` : ""}
    ${job.status !== "open" ? `<h2 style="margin-top:8px">Milestones</h2>${job.milestones.map((m, i) => milestoneCard(m, details[i])).join("") || `<p class="muted">No milestones yet.</p>`}` : ""}
    ${isClient && job.status === "in_progress" ? `<div class="card"><h2>Add a milestone</h2>
      <form id="msForm" class="row"><input name="title" placeholder="Title" required style="max-width:300px" />
      <input name="amount_eth" placeholder="Amount (ETH)" required style="max-width:160px" /><button>Add</button></form></div>` : ""}`;

  view.querySelectorAll("[data-accept]").forEach((b) => {
    b.onclick = () => act(() => api("POST", `/proposals/${b.dataset.accept}/accept`), "Proposal accepted. Escrow contract deployed.");
  });
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
    b.onclick = () => act(() => api("POST", `/arbiter/milestones/${b.dataset.id}/${b.dataset.d}`), b.dataset.d === "release" ? "Released" : "Refunded");
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
