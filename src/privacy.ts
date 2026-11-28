// formelab.ai/privacy: the privacy policy. Plain language, and only what the code actually does:
// check this page whenever what Formelab stores or who it shares data with changes.
import { homeHead, topNav } from "./dashboard/home";
import { htmlResponse } from "./dashboard/layout";

const UPDATED = "November 28, 2026";
const CONTACT = "hello@formelab.ai";

const BODY = `
<h1>Privacy</h1>
<p class="meta">Last updated ${UPDATED}</p>

<p>Formelab hosts small web apps that people build with AI tools. This page explains what we keep, why, who else handles it, and how to get it deleted. It covers formelab.ai, the apps at their own addresses on formelab.app, and the Formelab connectors for AI tools.</p>

<h2>What we keep about you</h2>
<ul>
  <li><strong>Your account:</strong> your email address, your name if your sign-in provides one, and when you joined. Your password, if you set one, is held by our sign-in provider, WorkOS, never by Formelab.</li>
  <li><strong>Apps you publish:</strong> their files, settings and who they're shared with.</li>
  <li><strong>Data your apps save:</strong> what an app stores for everyone who uses it, what it stores for each person privately, and answers sent through its forms.</li>
  <li><strong>Keys and connected services:</strong> API keys you save and the access you give to services such as Google Sheets. These are stored encrypted, and apps use them through Formelab without ever seeing them.</li>
  <li><strong>An activity log:</strong> who published, shared or changed what, and when, so owners can see what happened to their apps. It never holds the values of keys. Records of calls apps make to outside services are kept for a year.</li>
  <li><strong>Usage counts:</strong> which apps are opened and how AI tools use Formelab, so we can understand how it's used and keep it working.</li>
  <li><strong>The waitlist:</strong> your email and when you joined, if you sign up there.</li>
</ul>

<h2>People who use apps built on Formelab</h2>
<p>If you use an app someone built on Formelab, that app's owner decides what it collects and who can see it. Formelab stores it on their behalf: the owner is responsible for the data, and we handle it for them.</p>
<ul>
  <li>An app can add you by email so you can open it. If you never sign in, that email is all that's kept, and only on that app's list.</li>
  <li>When you first sign in to an app, we make an account that only opens apps. It isn't added to our waitlist or used to contact you.</li>
  <li>When the last app that lists you removes you, or is deleted, that account is deleted too.</li>
  <li>To have your data in an app changed or deleted, ask the app's owner. If you ask us instead, we delete what Formelab holds for itself and pass your request on to the owner of every app that lists you. We don't tell anyone else which apps those are.</li>
</ul>

<h2>Who else handles it</h2>
<ul>
  <li><strong>Cloudflare</strong> runs Formelab and stores its data and files, and sends our emails.</li>
  <li><strong>WorkOS</strong> handles signing in, including the emails with sign-in codes, and Google sign-in.</li>
  <li><strong>Google Fonts:</strong> our pages load their fonts from Google, which sees your browser's IP address when they do.</li>
  <li><strong>Services an app owner connects</strong>, such as Google Sheets, Supabase or another API, receive what the app sends them, through Formelab, using the owner's own account or key.</li>
  <li><strong>AI providers you choose:</strong> if you build or update an app in Formelab with your own Anthropic, OpenAI or Google Gemini key, what you write is sent to that provider under your key. AI tools you connect to Formelab, such as Claude or ChatGPT, see what you ask them to read or change.</li>
</ul>
<p>We don't sell personal information, show ads, or use it to market to the people who use apps on Formelab.</p>

<h2>Google user data</h2>
<p>When you connect Google Sheets, Formelab uses that access only so the apps you choose can read and write the spreadsheets you allow, and for nothing else. Formelab's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Cookies</h2>
<p>Formelab only sets cookies it needs to work: to keep you signed in, to finish signing in safely, to remember your last sign-in method, and to let a public link open an app. We don't use advertising or tracking cookies.</p>

<h2>Keeping and deleting</h2>
<ul>
  <li>Your apps and their data stay until you delete them. Deleting an app deletes its files, saved data, keys and form answers.</li>
  <li>To delete your account, email us at <a href="mailto:${CONTACT}">${CONTACT}</a>. We delete it with your spaces and apps, take you off other people's sharing lists, and disconnect your AI tools. The activity log can keep a record of changes you made in other people's apps, so their owners can still see what happened.</li>
</ul>

<h2>Keeping it safe</h2>
<p>Everything travels over HTTPS. Saved keys and connections are encrypted. Each app runs at its own address, so apps can't read each other's data or your Formelab sign-in.</p>

<h2>Changes</h2>
<p>If we change this page, we'll update the date at the top, and tell account holders by email about anything that matters.</p>

<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
`;

/** GET /privacy on DOMAIN: public, no sign-in. */
export function privacyPage(): Response {
  return htmlResponse(`<!doctype html>
<html lang="en">
<head>
${homeHead("Privacy · Formelab")}
</head>
<body>
${topNav(false, false)}
<main>
  <div class="container"><article class="legal">${BODY}</article></div>
  <div class="container"><footer><span>© 2026 Formelab</span><a href="/">Home</a></footer></div>
</main>
</body>
</html>`);
}
