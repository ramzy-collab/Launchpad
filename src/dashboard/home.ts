// Public pages on the apex: the home page with the waitlist, and the login screen.
import { head, htmlResponse, nav } from "./layout";

export function homePage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head("Formelab: SaaS is dead", ["site.js"])}
<meta name="description" content="Stop renting software that almost fits. Describe what you need, and Formelab makes it real.">
</head>
<body>
<div class="wrap">
${nav("/", `<a class="link" href="/login">Log in</a>`)}

<main class="screen" id="landing">
  <div class="hero">
    <div class="sticker">psst, you can build this stuff now</div>
    <h1><span class="strike">SaaS</span> is <span class="dead">dead.</span></h1>
    <p class="sub">Stop renting software that almost fits. Describe what you need, and Formelab makes it real. No code, no vendors, no waiting.</p>

    <form class="waitlist" id="wait-form" novalidate>
      <div class="field" id="field">
        <input type="email" id="email" name="email" placeholder="you@email.com" aria-label="Your email" autocomplete="email" required>
        <button class="btn" id="join-btn" type="submit"><span class="spin"></span><span class="lbl">Save my spot</span></button>
      </div>
      <div class="msg" id="msg" role="status">Early access is free. One email when we open, that's it.</div>
    </form>

    <div class="ideas" aria-label="Things people are making">
      <div class="ideas-label">Things people are making in the lab</div>
      <span class="chip"><span class="dot dot-1"></span>A booking page for my studio</span>
      <span class="chip"><span class="dot dot-2"></span>Rent tracker for 12 units</span>
      <span class="chip"><span class="dot dot-3"></span>Team lunch poll</span>
      <span class="chip"><span class="dot dot-4"></span>Client onboarding checklist</span>
    </div>
  </div>
</main>

<main class="screen" id="confirm" hidden>
  <div class="center">
    <div class="card confirm">
      <span class="tag-yellow">you're in!</span>
      <div class="badge">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
      </div>
      <h2>Your name's on the wall.</h2>
      <p>We saved a spot for <span class="you" id="conf-email">you</span>.</p>
      <p>When the lab opens, you'll be one of the first in. Start thinking about what you want to make.</p>
      <div class="actions-row">
        <button type="button" class="btn" id="share">Tell a friend</button>
        <button type="button" class="ghost" id="back-home">Back home</button>
      </div>
      <div class="msg" id="share-msg" role="status"></div>
    </div>
  </div>
</main>

<div class="foot">Formelab</div>
</div>
</body>
</html>`);
}

export function loginPage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${head("Log in to Formelab")}
</head>
<body>
<div class="wrap">
${nav("/")}

<main class="screen">
  <div class="center">
    <div class="card login">
      <h2>Welcome back</h2>
      <p class="lead">Your studio missed you.</p>
      <a class="btn full" href="/app">Log in</a>
      <p class="footnote">You'll confirm it's you with a one-time code sent to your email, or with your work account.</p>
      <div class="or">or</div>
      <p class="footnote">New here? <a class="textlink" href="/">Join the waitlist</a></p>
    </div>
  </div>
</main>

<div class="foot">Formelab</div>
</div>
</body>
</html>`);
}
