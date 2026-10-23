// Formelab admin: a separate area from anyone's own lab, for running Formelab itself. Admins only.
import type { Context } from "hono";
import { describeActivity, platformActivity } from "../audit";
import { listFlags, STATE_LABEL } from "../flags";
import { CHANGELOG_MD } from "../generated/assets";
import { VENDOR_GROUPS, VENDORS, type VendorGroup } from "../vendors";
import { isOwnerEmail } from "../auth";
import type { AppEnv } from "../env";
import { aiOrigin } from "../hosts";
import { plainPage } from "../serve";
import { adminStats, listUsers } from "../users";
import { escapeHtml as e } from "../util";
import { listWaitlist } from "../waitlist";
import { getPlan, inlineMarkdown, listPlans, planResults, RESULT_STATUSES, renderPlan, resultCounts } from "../testplans";
import { head, htmlResponse } from "./layout";
import { metricsBody } from "./metrics";
import { fmtTime, logoutControl, MENU_ICON } from "./page";

type Tab = "overview" | "metrics" | "users" | "waitlist" | "features" | "activity" | "changelog" | "testplans" | "vendors";

const TABS: Record<Tab, { title: string; intro: string }> = {
  overview: { title: "Overview", intro: "Formelab at a glance. Changes here affect everyone on Formelab." },
  metrics: { title: "Metrics", intro: "How Formelab is growing and being used: people, apps, MCP and the apps people host." },
  users: { title: "Users", intro: "Everyone with an account, and people let in who haven't logged in yet." },
  waitlist: { title: "Waitlist", intro: "People waiting to get in." },
  activity: { title: "Activity", intro: "Formelab-level changes, newest first." },
  features: { title: "Features", intro: "Turn new features on for admins, for specific people, then for everyone." },
  changelog: { title: "Changelog", intro: "Everything that has changed in Formelab, newest first." },
  testplans: { title: "Test plans", intro: "The browser test plan for each feature, with what passed, failed or was blocked. Hand one to Claude to run, then record what it found." },
  vendors: { title: "Vendors", intro: "Every service, AI app and open-source project Formelab uses, or used." },
};

/** The admin panel's frame: the same left menu as the web app, grouped into Users and Formelab. */
function adminShell(c: Context<AppEnv>, tab: Tab, body: string, scripts: string[] = [], page?: { title: string; intro?: string }): Response {
  const user = c.get("user");
  const link = (t: Tab, href: string) => `<a href="${href}"${t === tab ? ' aria-current="page"' : ""}>${TABS[t].title}</a>`;
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head(`${page?.title ?? TABS[tab].title} · Formelab Admin Panel`, ["dashboard.js", ...scripts])}
</head>
<body class="dash admin${tab === "metrics" ? " metrics" : ""}">
<div class="app-shell">
<header class="topbar">
  <a class="brand" href="/" aria-label="Formelab admin home"><span class="mark"></span>Formelab Admin Panel</a>
  <button type="button" class="menu-toggle" data-menu-toggle aria-controls="sidebar" aria-expanded="false" aria-label="Open menu">${MENU_ICON}</button>
</header>
<aside class="sidebar" id="sidebar">
  <a class="brand" href="/" aria-label="Formelab admin home"><span class="mark"></span>Formelab Admin Panel</a>
  <nav class="side-nav" aria-label="Admin sections">
    <p class="side-label">Users</p>
    ${link("overview", "/")}
    ${link("metrics", "/metrics")}
    ${link("users", "/users")}
    ${link("waitlist", "/waitlist")}
    ${link("activity", "/activity")}
    <p class="side-label">Formelab</p>
    ${link("features", "/features")}
    ${link("changelog", "/changelog")}
    ${link("testplans", "/test-plans")}
    ${link("vendors", "/vendors")}
  </nav>
  <details class="account">
    <summary><span class="avatar" aria-hidden="true">${e(user.email.slice(0, 1).toUpperCase())}</span><span class="who">Settings · <strong>${e(user.email)}</strong></span></summary>
    <div class="account-menu">
      <button type="button" class="link theme-item" data-theme-toggle><span class="to-dark">Dark mode</span><span class="to-light">Light mode</span></button>
      ${logoutControl(c)}
    </div>
  </details>
</aside>
<main class="content">
<div class="page-head">
  <h1>${e(page?.title ?? TABS[tab].title)}</h1>
  ${page ? (page.intro ? `<p>${page.intro}</p>` : "") : `<p>${e(TABS[tab].intro)}</p>`}
</div>
<div id="flash" role="status" hidden></div>
${body}
</main>
</div>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
</body>
</html>`);
}

/** Admins only; everyone else gets the same "not found" as any unknown page. */
export async function adminPage(c: Context<AppEnv>, tab: Tab): Promise<Response> {
  if (!c.get("user").isAdmin) return plainPage(404, "Not found", "There is nothing here.");
  if (tab === "metrics") return adminShell(c, tab, await metricsBody(c), ["viz.js"]);
  if (tab === "users") return adminShell(c, tab, await usersBody(c));
  if (tab === "waitlist") return adminShell(c, tab, await waitlistBody(c));
  if (tab === "activity") return adminShell(c, tab, await activityBody(c));
  if (tab === "features") return adminShell(c, tab, await featuresBody(c));
  if (tab === "changelog") return adminShell(c, tab, changelogBody());
  if (tab === "testplans") return adminShell(c, tab, await testPlansBody(c));
  if (tab === "vendors") return adminShell(c, tab, vendorsBody());
  return adminShell(c, tab, await overviewBody(c));
}

const stat = (label: string, value: number, href?: string) =>
  `<div class="stat">${href ? `<a href="${href}">` : ""}<span class="stat-value">${e(value)}</span><span class="stat-label">${e(label)}</span>${href ? "</a>" : ""}</div>`;

async function overviewBody(c: Context<AppEnv>): Promise<string> {
  const [s, waitlist, users] = await Promise.all([adminStats(c.env), listWaitlist(c.env, 5), listUsers(c.env, 5)]);
  const pending = waitlist.entries.filter((w) => !w.approvedAt);
  return `<section>
  <h2>At a glance</h2>
  <div class="stats">
    ${stat("People", s.users, "/users")}
    ${stat("Waiting to get in", s.waiting, "/waitlist")}
    ${stat("Let in, not logged in yet", s.letInNotSignedIn, "/users#not-signed-in")}
    ${stat("Sign-ups this week", s.signupsThisWeek, "/waitlist")}
    ${stat("Apps", s.apps)}
    ${stat("Spaces", s.namespaces)}
    ${stat("Admins", s.admins, "/users")}
  </div>
</section>

<section>
  <h2>Latest sign-ups</h2>
  ${
    pending.length
      ? `<div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${pending
          .map((w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td><td><button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button></td></tr>`)
          .join("")}</tbody></table></div>
  <p><a href="/waitlist">See the whole waitlist →</a></p>`
      : `<p class="muted">Nobody is waiting. Share the home page at <a href="${e(aiOrigin(c.env, c.req.url))}/">${e(aiOrigin(c.env, c.req.url))}/</a>.</p>`
  }
</section>

<section>
  <h2>Newest people</h2>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Joined</th></tr></thead><tbody>${users
    .map((u) => `<tr><td>${e(u.email)}</td><td>${statusTag(u)}</td><td class="nowrap">${e(fmtTime(u.createdAt))}</td></tr>`)
    .join("")}</tbody></table></div>
  <p><a href="/users">Manage people →</a></p>
</section>`;
}

const statusTag = (u: { isAdmin: boolean; status: string }) =>
  u.isAdmin ? '<span class="tag admin">admin</span>' : u.status === "active" ? "Active" : '<span class="tag">waitlist</span>';

async function usersBody(c: Context<AppEnv>): Promise<string> {
  const me = c.get("user");
  const [users, notSignedIn] = await Promise.all([listUsers(c.env), listWaitlist(c.env, 500, "let-in-not-signed-in")]);
  const rows = users
    .map((u) => {
      const owner = isOwnerEmail(c.env, u.email);
      const self = u.email === me.email;
      const adminBtn = owner || self
        ? ""
        : u.isAdmin
          ? `<button class="danger" data-action="user-admin" data-email="${e(u.email)}" data-admin="false">Remove admin</button>`
          : `<button class="secondary" data-action="user-admin" data-email="${e(u.email)}" data-admin="true">Make admin</button>`;
      const deleteBtn = owner || self ? "" : `<button class="danger" data-action="user-delete" data-email="${e(u.email)}" data-apps="${e(u.apps)}">Delete</button>`;
      const note = owner ? '<div class="muted">Owner</div>' : self ? '<div class="muted">You</div>' : "";
      return `<tr><td>${e(u.email)}${u.name ? `<div class="muted">${e(u.name)}</div>` : ""}${note}</td><td>${statusTag(u)}</td><td>${e(u.apps)}</td><td class="nowrap">${e(fmtTime(u.createdAt))}</td>
  <td><div class="inline">${adminBtn}${deleteBtn}</div></td></tr>`;
    })
    .join("");
  return `<section>
  <h2>People<span class="count">${e(users.length)}</span></h2>
  <p class="muted"><strong>Make admin</strong> gives someone this admin area (and lets them in if they were waiting). <strong>Delete</strong> removes the account and everything it owns: its spaces and apps (with their data and secrets), its place on other people's share lists, access keys and connected AI apps.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Status</th><th>Apps</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
</section>

<section id="not-signed-in">
  <h2>Let in, not logged in yet<span class="count">${e(notSignedIn.total)}</span></h2>
  ${
    notSignedIn.entries.length
      ? `<p class="muted">You let these people in (or invited them), but they haven't logged in yet. Their account is created the first time they do, and they move up to People.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Joined the waitlist</th><th>Let in</th></tr></thead><tbody>${notSignedIn.entries
    .map((w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td><td class="nowrap">${e(fmtTime(w.approvedAt!))}</td></tr>`)
    .join("")}</tbody></table></div>`
      : `<p class="muted">Everyone you've let in has logged in.</p>`
  }
</section>`;
}

/** Every outside service, AI app and open-source project Formelab uses or used (src/vendors.ts). */
export function vendorsBody(): string {
  const code = (s: string) => e(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const sinceText = (s: string) => s.replace(/(\d{4}-\d{2}-\d{2})/g, (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }));
  return (Object.keys(VENDOR_GROUPS) as VendorGroup[])
    .map((g) => {
      const list = VENDORS.filter((v) => v.group === g);
      const rows = list
        .map(
          (v) => `<tr>
  <td><a href="${e(v.url)}" target="_blank" rel="noopener"><strong>${e(v.name)}</strong></a><div class="muted">${e(sinceText(v.since))}</div></td>
  <td>${code(v.purpose)}</td>
  <td>${code(v.plan)}</td>
  <td class="muted">${code(v.setup)}</td>
</tr>`,
        )
        .join("");
      return `<section>
  <h2>${e(VENDOR_GROUPS[g].title)}<span class="count">${e(list.length)}</span></h2>
  <p class="muted">${e(VENDOR_GROUPS[g].intro)}</p>
  <div class="scroll"><table class="vendors"><thead><tr><th>Vendor</th><th>What it's for</th><th>Plan and cost</th><th>Where it's set up</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
    })
    .join("\n");
}

/**
 * CHANGELOG.md as HTML. It's our own file, in a small fixed format: "## YYYY-MM-DD" days and "- "
 * items with **bold**, `code` and [links](https://... or /path), such as a feature's test plan.
 */
export function changelogBody(): string {
  const inline = inlineMarkdown;
  const day = (iso: string) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const sections = CHANGELOG_MD.split(/^## /m).slice(1).map((chunk) => {
    const [date, ...lines] = chunk.split("\n");
    const items = lines.filter((l) => l.startsWith("- ")).map((l) => `<li>${inline(l.slice(2))}</li>`).join("");
    return `<section class="changelog-day">
  <h2><time datetime="${e(date!.trim())}">${e(day(date!.trim()))}</time></h2>
  <ul class="changelog">${items}</ul>
</section>`;
  });
  return sections.join("\n");
}

async function featuresBody(c: Context<AppEnv>): Promise<string> {
  const flags = await listFlags(c.env);
  const rows = flags
    .map(
      (f) => `<tr>
  <td><strong>${e(f.label)}</strong><div class="muted">${e(f.description)}</div></td>
  <td class="nowrap">${f.updatedAt ? `${e(fmtTime(f.updatedAt))}<div class="muted">${e(f.updatedBy ?? "")}</div>` : '<span class="muted">Never changed</span>'}</td>
  <td><form class="inline" data-action="feature-set" data-name="${e(f.name)}">
    <select name="state" aria-label="${e(f.label)}">${(["off", "admins", "on"] as const)
      .map((s) => `<option value="${s}"${s === f.state ? " selected" : ""}>${e(STATE_LABEL[s])}</option>`)
      .join("")}</select>
    <button>Save</button>
  </form></td>
</tr>
<tr class="flag-people">
  <td colspan="3">
    <p class="muted">Also on for${f.users.length ? "" : " nobody else yet"}:</p>
    ${
      f.users.length
        ? `<ul class="flag-users">${f.users
            .map(
              (u) => `<li><span>${e(u.email)}</span> <span class="muted">${e(fmtTime(u.addedAt))}${u.addedBy ? ` · ${e(u.addedBy)}` : ""}</span>
      <button class="danger" data-action="feature-user-remove" data-name="${e(f.name)}" data-email="${e(u.email)}">Remove</button></li>`,
            )
            .join("")}</ul>`
        : ""
    }
    <form class="inline" data-action="feature-user-add" data-name="${e(f.name)}">
      <input name="email" type="email" required placeholder="someone@example.com" aria-label="Turn ${e(f.label)} on for (email)">
      <button class="secondary">Turn on for this person</button>
    </form>
  </td>
</tr>`,
    )
    .join("");
  return `<section>
  <p class="muted">New features ship turned off. Turn one on for <strong>Admins only</strong> to try it yourself, then for <strong>Everyone</strong>. To let a few people try it first, turn it on for them by email: they get it whatever <strong>Who gets it</strong> says. Turning a feature off hides it again right away; nothing people set up is deleted.</p>
  <div class="scroll"><table><thead><tr><th>Feature</th><th>Last changed</th><th>Who gets it</th></tr></thead><tbody>${rows}</tbody></table></div>
</section>`;
}

async function activityBody(c: Context<AppEnv>): Promise<string> {
  const rows = (await platformActivity(c.env, 300))
    .map((a) => `<tr><td class="nowrap">${e(fmtTime(a.at))}</td><td>${e(a.actor)}</td><td>${e(describeActivity(a))}</td></tr>`)
    .join("");
  return `<section>
  <p class="muted">Formelab-level changes, newest first: people let in and invited, admin access, deleted accounts, spaces, and AI apps connected. What happens inside an app is in that app's own activity log, under <strong>Activity</strong> on its owner's My apps page.</p>
  ${rows ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What they did</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="muted">Nothing yet.</p>`}
</section>`;
}

async function waitlistBody(c: Context<AppEnv>): Promise<string> {
  const waitlist = await listWaitlist(c.env);
  const rows = waitlist.entries
    .map(
      (w) => `<tr><td>${e(w.email)}</td><td class="nowrap">${e(fmtTime(w.createdAt))}</td>
  <td>${w.approvedAt ? `<span class="tag">let in ${e(fmtTime(w.approvedAt).slice(0, 10))}</span>${w.signedIn ? "" : ' <span class="muted">not logged in yet</span>'}` : `<button data-action="waitlist-approve" data-email="${e(w.email)}">Let in</button>`}</td></tr>`,
    )
    .join("");
  return `<section id="waitlist">
  <h2>Waitlist<span class="count">${e(waitlist.total)}</span></h2>
  <p class="muted">${e(waitlist.entries.filter((w) => !w.approvedAt).length)} waiting, ${e(waitlist.entries.filter((w) => w.approvedAt).length)} let in.</p>
  ${
    waitlist.entries.length
      ? `<p class="muted">People who signed up on the home page or tried to log in, newest first${waitlist.total > waitlist.entries.length ? ` (latest ${waitlist.entries.length} shown)` : ""}. <strong>Let in</strong> lets them create apps and emails them.</p>
  <div class="scroll"><table><thead><tr><th>Email</th><th>Joined</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="muted">No sign-ups yet. Share the home page at <a href="${e(aiOrigin(c.env, c.req.url))}/">${e(aiOrigin(c.env, c.req.url))}/</a>.</p>`
  }
  <h3>Invite someone</h3>
  <p class="muted">They can create apps as soon as they log in, and get a "You're in" email.</p>
  <form class="inline" data-action="waitlist-invite">
    <input name="email" type="email" required placeholder="someone@example.com" aria-label="Email to invite">
    <button>Invite</button>
  </form>
</section>`;
}

const STATUS_NAME = { pass: "Pass", fail: "Fail", blocked: "Blocked" } as const;

/** Test plans: every feature's plan with how far its test run got. */
async function testPlansBody(c: Context<AppEnv>): Promise<string> {
  const [plans, counts] = [listPlans(), await resultCounts(c.env)];
  if (!plans.length) {
    return `<section><p class="muted">No test plans yet. Each feature PR adds one to <code>docs/test-plans</code>, and it shows up here once it's deployed.</p></section>`;
  }
  const rows = plans
    .map((p) => {
      const n = counts[p.slug] ?? { pass: 0, fail: 0, blocked: 0 };
      const run = n.pass + n.fail + n.blocked;
      return `<tr>
  <td><a href="/test-plans/${e(p.slug)}"><strong>${e(p.title)}</strong></a></td>
  <td class="nowrap">${e(p.date)}</td>
  <td class="num">${p.cases.length}</td>
  ${RESULT_STATUSES.map((s) => `<td class="num"><span class="tp-dot ${s}" aria-hidden="true"></span>${n[s]}</td>`).join("")}
  <td class="num">${p.cases.length - run}</td>
</tr>`;
    })
    .join("");
  return `<section>
  <div class="scroll"><table class="tp-list"><thead><tr><th>Plan</th><th>Added</th><th class="num">Cases</th>${RESULT_STATUSES.map((s) => `<th class="num">${STATUS_NAME[s]}</th>`).join("")}<th class="num">Not run</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="muted">Plans come from <code>docs/test-plans</code> in the repository, one per feature PR. Results are kept here, the latest one for each case.</p>
</section>`;
}

/** One test plan: the plan itself, with a result for each case. */
export async function testPlanPage(c: Context<AppEnv>, slug: string): Promise<Response> {
  if (!c.get("user").isAdmin) return plainPage(404, "Not found", "There is nothing here.");
  const plan = getPlan(slug);
  if (!plan) return plainPage(404, "Not found", "There is nothing here.");
  const results = await planResults(c.env, slug);
  const n = { pass: 0, fail: 0, blocked: 0, todo: 0 };
  for (const tc of plan.cases) n[results[tc.id]?.status ?? "todo"]++;
  const filter = (key: string, label: string, count: number, on = false) =>
    `<button type="button" class="tp-filter" data-tp-filter="${key}" aria-pressed="${on}">${key === "all" ? "" : `<span class="tp-dot ${key}" aria-hidden="true"></span>`}${label} <b data-tp-count="${key}">${count}</b></button>`;
  const body = `<div class="tp-page" data-test-plan="${e(slug)}">
<p class="crumb"><a href="/test-plans">Test plans</a> <span aria-hidden="true">/</span> <span>${e(plan.title)}</span></p>
<section class="tp-summary">
  <p class="muted">Added ${e(plan.date)} · ${plan.cases.length} cases</p>
  <div class="tp-bar" data-tp-bar role="img" aria-label="${n.pass} passed, ${n.fail} failed, ${n.blocked} blocked, ${n.todo} not run"><span class="pass"></span><span class="fail"></span><span class="blocked"></span></div>
  <div class="tp-filters" role="group" aria-label="Show cases">
    ${filter("all", "All", plan.cases.length, true)}${filter("todo", "Not run", n.todo)}${filter("pass", "Pass", n.pass)}${filter("fail", "Fail", n.fail)}${filter("blocked", "Blocked", n.blocked)}
  </div>
  <div class="tp-actions">
    <button type="button" data-tp-copy>Copy for Claude</button>
    <button type="button" class="secondary" data-tp-toggle="tp-import" aria-expanded="false" aria-controls="tp-import">Import results</button>
    <button type="button" class="secondary" data-tp-toggle="tp-clear" aria-expanded="false" aria-controls="tp-clear">Clear results</button>
  </div>
  <div class="tp-panel" id="tp-import" hidden>
    <p class="muted">Paste what Claude sent back: one line per case, like <code>MA-04 | fail | The chip said Only you</code>. The result is pass, fail or blocked, and the note is optional. Other lines are skipped.</p>
    <textarea id="tp-import-text" rows="8" spellcheck="false" aria-label="Results to import" placeholder="MA-01 | pass&#10;MA-02 | fail | Chip missing on Solo notes&#10;UP-06 | blocked | No Gemini key"></textarea>
    <div class="tp-actions"><button type="button" data-tp-import>Save these results</button><button type="button" class="secondary" data-tp-toggle="tp-import">Cancel</button></div>
  </div>
  <div class="tp-panel" id="tp-clear" hidden>
    <p class="muted">Clear every result for this plan to start a fresh test run? The plan itself stays.</p>
    <div class="tp-actions"><button type="button" class="danger" data-tp-clear>Clear all results</button><button type="button" class="secondary" data-tp-toggle="tp-clear">Keep them</button></div>
  </div>
</section>
<article class="tp-doc">
${renderPlan(plan, results)}
</article>
<textarea id="tp-markdown" hidden readonly aria-hidden="true">${e(plan.markdown)}</textarea>
</div>`;
  // The plan's own first paragraph introduces it, so the heading has no intro of its own.
  return adminShell(c, "testplans", body, [], { title: plan.title });
}
