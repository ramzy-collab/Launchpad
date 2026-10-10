// Public pages on the apex: the home page with the waitlist, and the login screen. They follow the
// "wall" prototype (fl.formelab.ai/wall) and use home.css; every style lives in that file so the
// pages keep a strict CSP.
import { HOME_FONTS, head, htmlResponse } from "./layout";

const homeHead = (title: string, scripts: string[] = []) => head(title, scripts, { css: "home.css", fonts: HOME_FONTS });

const CHECK = (stroke: string, width = 3.5) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${width}"><path d="M20 6 9 17l-5-5"/></svg>`;

function topNav(): string {
  return `<div class="container">
  <nav>
    <a class="logo" href="/" aria-label="Formelab home"><span class="mark" aria-hidden="true"></span>Formelab</a>
    <div class="nav-r">
      <a class="nbtn" href="/login">Log in</a>
      <a class="cta" href="/#signup" data-join><span class="long">Join the waitlist</span><span class="short">Join</span></a>
    </div>
  </nav>
</div>`;
}

/** The example apps on the rail. `copy` renders the duplicate set that makes the marquee seamless. */
function showcase(copy: boolean): string {
  const hidden = copy ? ' aria-hidden="true"' : "";
  const gid = copy ? "mg2" : "mg1";
  return `
<figure${hidden}>
  <div class="stage bg-blue"><div class="shot"><div class="cal">
    <div class="side">
      <div class="av"></div>
      <div class="host">Ana Ruiz</div>
      <div class="ev">Reformer Pilates</div>
      <div class="meta"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>50 min</div>
      <div class="meta"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>Oak St. Studio</div>
    </div>
    <div class="main">
      <h4>Select a Date &amp; Time</h4>
      <div class="mo"><span>October 2026</span><i>&#8249; &#8250;</i></div>
      <div class="grid">
        <span class="dh">MON</span><span class="dh">TUE</span><span class="dh">WED</span><span class="dh">THU</span><span class="dh">FRI</span><span class="dh">SAT</span><span class="dh">SUN</span>
        <span>12</span><span class="av2">13</span><span class="sel">14</span><span class="av2">15</span><span class="av2">16</span><span>17</span><span>18</span>
        <span class="av2">19</span><span class="av2">20</span><span>21</span><span class="av2">22</span><span class="av2">23</span><span>24</span><span>25</span>
      </div>
      <div class="slots"><span>8:30am</span><span class="pick">10:00am</span><span>12:15pm</span><span class="go">Next</span></div>
    </div>
  </div></div>
  <div class="float toast at-br"><span class="ti ti-blue"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></span><span><b>New booking</b><small>Maya R. · Tue, 10:00am</small></span></div></div>
  <figcaption><b>Class booking</b> by a studio owner</figcaption>
</figure>

<figure${hidden}>
  <div class="stage bg-peach"><div class="shot"><div class="asa">
    <div class="hd"><span class="pj"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg></span><b>Client onboarding</b></div>
    <div class="tabs"><span class="on">List</span><span>Board</span><span>Timeline</span><span>Files</span></div>
    <div class="colh"><span>Task name</span><span>Assignee</span><span>Due date</span></div>
    <div class="sec"><svg width="8" height="8" viewBox="0 0 10 10"><path d="M1 3l4 4 4-4" fill="none" stroke="#1e1f21" stroke-width="1.6"/></svg>Harbor &amp; Co.</div>
    <div class="t"><span><i class="ck on">${CHECK("#fff", 4)}</i><span class="done">Signed agreement</span></span><i class="who p-blue">DK</i><span class="due">Oct 6</span></div>
    <div class="t"><span><i class="ck on">${CHECK("#fff", 4)}</i><span class="done">Kickoff call</span></span><i class="who p-purple">SL</i><span class="due">Oct 8</span></div>
    <div class="t"><span><i class="ck"></i>Collect brand assets</span><i class="who p-red">RM</i><span class="due late">Yesterday</span></div>
    <div class="t"><span><i class="ck"></i>Draft homepage copy</span><i class="who p-purple">SL</i><span class="due today">Today</span></div>
  </div></div>
  <div class="float working"><span class="faces"><i class="p-blue"></i><i class="p-purple"></i><i class="p-red"></i></span><b>3 working</b></div>
  <div class="float toast at-bl"><span class="ti ti-green"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg></span><span><b>Kickoff call</b><small>Marked complete by Sam</small></span></div></div>
  <figcaption><b>Onboarding checklist</b> by a 4-person agency</figcaption>
</figure>

<figure${hidden}>
  <div class="stage bg-night"><div class="shot"><div class="str">
    <div class="lbl">Rent collected <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="#687385" stroke-width="1.5"/></svg></div>
    <div class="amt">$21,450.00<span class="delta">+4.2%</span><small>October</small></div>
    <svg class="chart" viewBox="0 0 300 54" preserveAspectRatio="none">
      <path d="M0 46 L30 44 L60 40 L90 41 L120 33 L150 30 L180 24 L210 22 L240 15 L270 12 L300 8" fill="none" stroke="#635bff" stroke-width="1.8"/>
      <path d="M0 46 L30 46 L60 45 L90 43 L120 40 L150 38 L180 36 L210 35 L240 32 L270 31 L300 29" fill="none" stroke="#c1c9d2" stroke-width="1.4" stroke-dasharray="3 3"/>
    </svg>
    <div class="th"><span>Amount</span><span>Status</span><span>Unit</span></div>
    <div class="tr"><b>$2,350.00</b><span class="badge ok">Succeeded <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><path d="M20 6 9 17l-5-5"/></svg></span><span class="desc">12 Elm St, Unit 1</span></div>
    <div class="tr"><b>$1,950.00</b><span class="badge inc">Incomplete</span><span class="desc">48 Centre St, Unit 3</span></div>
    <div class="tr"><b>$2,150.00</b><span class="badge fail">Failed</span><span class="desc">7 Park Ln, Unit 1</span></div>
  </div></div>
  <div class="float toast at-br2"><span class="ti ti-mint"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#006908" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg></span><span><b>Payment received</b><small>12 Elm St, Unit 1</small></span><b class="gain">+$2,350</b></div></div>
  <figcaption><b>Rent tracker</b> by a landlord with 12 units</figcaption>
</figure>

<figure${hidden}>
  <div class="stage bg-mint"><div class="shot"><div class="doo">
    <p class="t">Team lunch, this week</p>
    <p class="s">Organized by Priya · 4 responses</p>
    <table>
      <tr><th>4 participants</th><th>WED<small>12:00</small></th><th class="best">THU<small>12:30</small></th><th>FRI<small>12:00</small></th></tr>
      <tr><td><span class="av v-blue">P</span>Priya</td><td class="y">${CHECK("#1d8a4a")}</td><td class="y">${CHECK("#1d8a4a")}</td><td></td></tr>
      <tr><td><span class="av v-orange">D</span>Dana</td><td></td><td class="y">${CHECK("#1d8a4a")}</td><td class="y">${CHECK("#1d8a4a")}</td></tr>
      <tr><td><span class="av v-green">S</span>Sam</td><td class="m"><span class="maybe">(✓)</span></td><td class="y">${CHECK("#1d8a4a")}</td><td></td></tr>
      <tr><td><span class="av v-violet">T</span>Theo</td><td></td><td class="y">${CHECK("#1d8a4a")}</td><td class="y">${CHECK("#1d8a4a")}</td></tr>
      <tr class="cnt"><td></td><td>1</td><td class="best">4</td><td>2</td></tr>
    </table>
  </div></div>
  <div class="float decided"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>Thursday 12:30 it is</div>
  <svg class="cursor" width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l14 8-6 1.5L10 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
  <figcaption><b>Team poll</b> by an office manager</figcaption>
</figure>

<figure${hidden}>
  <div class="stage bg-sand"><div class="shot"><div class="mer">
    <div class="lbl">Total balance</div>
    <div class="bal">$68,412<span>.37</span></div>
    <div class="chg"><b>+$3,906.10</b> last 30 days</div>
    <svg class="chart" viewBox="0 0 300 60" preserveAspectRatio="none">
      <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5266eb" stop-opacity=".18"/><stop offset="1" stop-color="#5266eb" stop-opacity="0"/></linearGradient></defs>
      <path d="M0 44 C30 42 45 48 70 40 S110 30 140 34 S190 22 215 24 S265 12 300 10 L300 60 L0 60Z" fill="url(#${gid})"/>
      <path d="M0 44 C30 42 45 48 70 40 S110 30 140 34 S190 22 215 24 S265 12 300 10" fill="none" stroke="#5266eb" stroke-width="1.8"/>
    </svg>
    <div class="acct"><span class="ic"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/></svg></span><span>Checking<small>&#8226;&#8226;4821</small></span><b>$52,108.02</b></div>
    <div class="acct"><span class="ic"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 20V10l8-6 8 6v10"/><path d="M9 20v-6h6v6"/></svg></span><span>Savings<small>&#8226;&#8226;9930</small></span><b>$16,304.35</b></div>
  </div></div>
  <div class="float debit">
    <div class="top">Bean &amp; Barrel<span>DEBIT</span></div>
    <i class="chip"></i>
    <div class="num">•••• 4821</div></div></div>
  <figcaption><b>Cash dashboard</b> by a coffee shop owner</figcaption>
</figure>

<figure${hidden}>
  <div class="stage bg-butter"><div class="shot"><div class="not">
    <div class="emo">💌</div>
    <h5>Wedding RSVPs</h5>
    <div class="view"><span class="on">Table</span><span>By table</span><span>Dietary</span></div>
    <div class="r h"><span>Aa Name</span><span>RSVP</span><span>#</span></div>
    <div class="r"><span class="nm">Priya Shah</span><span><i class="tag g">Attending</i></span><span>2</span></div>
    <div class="r"><span class="nm">The Okafors</span><span><i class="tag g">Attending</i></span><span>4</span></div>
    <div class="r"><span class="nm">Marcus Lee</span><span><i class="tag yel">Maybe</i></span><span>1</span></div>
    <div class="r"><span class="nm">Elena Novak</span><span><i class="tag rd">Declined</i></span><span>0</span></div>
    <div class="r"><span class="nm">Sam &amp; Theo</span><span><i class="tag g">Attending</i></span><span>2</span></div>
  </div></div>
  <div class="float std">
    <div class="kicker">Save the date</div>
    <div class="names">Maya &amp; Jon</div>
    <div class="when">June 6 · Hudson Valley</div></div></div>
  <figcaption><b>Wedding RSVPs</b> by the couple</figcaption>
</figure>
`;
}

export function homePage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${homeHead("Formelab: SaaS is dead", ["site.js"])}
<meta name="description" content="Software that fits you, not the other way around. Describe what you need, and Formelab makes it real.">
</head>
<body>
${topNav()}

<main class="screen" id="landing">
  <section class="hero container">
    <div class="sticker">psst, you can build this stuff now</div>
    <h1><span class="strike">SaaS</span> is <span class="dead">dead.</span></h1>
    <p class="subhead">Software that fits you, not the other way around.</p>
  </section>

  <section class="container">
    <p class="label">Built with Formelab</p>
    <div class="rail" aria-label="Example apps built with Formelab">
      <div class="track">${showcase(false)}${showcase(true)}</div>
    </div>
  </section>

  <section class="signup container" id="signup">
    <form class="join" id="wait-form" novalidate>
      <input type="email" id="email" name="email" placeholder="you@email.com" aria-label="Your email" autocomplete="email" required>
      <button class="btn" id="join-btn" type="submit"><span class="spin"></span><span class="lbl">Join the waitlist</span></button>
    </form>
    <div class="note" id="msg" role="status">Free early access. One email when we open.</div>
  </section>

  <section class="steps container">
    <p class="label">How it works</p>
    <div class="steps-grid">
      <div class="step"><div class="num">1</div><h3>Join the waitlist</h3><p>Free early access. No card, no setup.</p></div>
      <div class="step"><div class="num">2</div><h3>Install Formelab</h3><p>Connect it to the AI you already use.</p></div>
      <div class="step"><div class="num">3</div><h3>Ask your AI to build</h3><p>Describe it in plain words. It's live.</p></div>
    </div>
  </section>

  <div class="container"><footer><span>© 2026 Formelab</span><a href="/login">Log in</a></footer></div>
</main>

<main class="screen" id="confirm" hidden>
  <div class="container center">
    <div class="card">
      <div class="check"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
      <h2>You're on the list.</h2>
      <p>We'll email <b id="conf-email">you</b> when your spot opens. Until then, start thinking about what you'd make.</p>
      <button type="button" class="btn w100" id="share">Share Formelab</button>
      <button type="button" class="ghost" id="back-home">Back home</button>
      <div class="note center-text" id="share-msg" role="status"></div>
    </div>
  </div>
</main>
</body>
</html>`);
}

export function loginPage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${homeHead("Log in to Formelab")}
</head>
<body>
${topNav()}

<main>
  <div class="container center">
    <div class="card">
      <h2>Welcome back</h2>
      <p>Log in to your Formelab workspace.</p>
      <a class="btn w100" href="/app">Log in</a>
      <p class="hint">You'll confirm it's you with a one-time code sent to your email, or with your work account.</p>
      <div class="foot-row"><span>New here?</span><a class="tlink" href="/#signup">Join the waitlist</a></div>
    </div>
  </div>
</main>
</body>
</html>`);
}
