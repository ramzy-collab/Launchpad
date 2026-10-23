# Changelog

Everything that has changed in Formelab, newest first. Shown in the admin panel under Changelog.

## 2026-10-23

- **A simpler My apps.** Apps are cards now: the app's icon, its name, its space and when it last changed, plus a chip that says who can open it (Only you, Shared with 3, or Public). Click a card to open the app; the gear opens its settings, the star keeps it at the top under **Starred**, and the link button copies the link that works for how it's shared (the public link when it has one). Search, a space filter and three sorts (Recently changed, Newest first, Name A to Z) sit above. Stars are kept in your browser for now. Shared with me uses the same cards.
- **A simpler app page.** The app's name is edited right in its header, next to a star, a pill that says who can open it (click it to change, or copy the link from it), **Open app** and a **...** menu with **Add to your phone or computer** and **Delete app** (type the app's name to confirm). Below are three tabs. **Sharing**: **Invited only** or **Public** (with a warning, the public link, Copy link and Reset link), two switches (viewers can change the app's data; anyone with the link can send answers, shown only when it's Public), a preview of what the link looks like in a chat, and **People**, where you invite by email as a Viewer, Editor or Admin and change or remove anyone's role. **Update**: describe a change and your AI makes it, or upload a new version. **Activity**: what happened, in plain sentences. Everything saves as you change it; there are no Save buttons.
- **Test plan:** [Settings redesign, phase 1](/test-plans/2026-10-23-settings-redesign-phase-1), 152 browser test cases to hand to Claude Cowork.
- **Test plans in the admin panel.** A new **Test plans** page lists the browser test plan for each feature, with how many cases passed, failed, were blocked or haven't been run. Open a plan to mark each case Pass, Fail or Blocked with a note, copy it for Claude with instructions for reporting back, and paste Claude's reply into **Import results** to record everything at once. **Clear results** starts a fresh run.
- Link previews now follow who can open the app whenever you change that. The SPA fallback, Hidden from listings and the daily cap on answers from the public link aren't on the page any more; they keep working as set, and AI apps can still change them.

## 2026-10-19

- **Forms anyone can fill in (behind the new Responses feature).** Apps can now collect form answers, sign-ups, RSVPs and feedback with `formelab.responses.submit()`. Only the app's owner and editors can see what was sent: on the app's page (with a spreadsheet download) or by asking their AI (the new `get_responses` tool). Owners can let people who open the app through its public link send responses without a Formelab account (**Let people with the link send responses** under Public link, or `update_site` with `guest_responses`). Before this, anyone without an account who filled in a shared form was asked to sign in to Formelab. Guests still can't read anything, and each one can send at most 5 responses a minute. Turn it on in the admin panel under Features.

## 2026-10-17

- **Metrics in the admin panel.** A new **Metrics** page shows how Formelab is growing and being used, ready to put in front of an investor: weekly active people (building apps, or using apps someone else built), stickiness, activation and time to first app up top; then growth (accounts, apps, sign-ups, waitlist demand), engagement (daily, weekly and monthly active people, new vs returning builders, retention by signup week), the activation funnel from sign-up to coming back, MCP use (tool calls by AI app, which AI apps people use, each tool, success rate and speed), hosted apps (page views, visitors, builders vs people apps were shared with, shipping pace, what apps do, the top apps) and the most engaged customers. Pick 30 days, 90 days, 12 months or all time; every number shows its change against the period before. Team accounts (admins and the owner) are left out unless you turn them on. Every chart has a hover readout and a table of its numbers, and the page works in dark mode, on a phone and printed.
- **Formelab now counts MCP calls and app visits.** Each MCP tool call (which tool, which AI app, whether it worked and how long it took) and each person opening an app (once a day per app, with how many pages they loaded) is recorded for Metrics. Views by guests who opened an app through its public link count too, without naming anyone. These charts fill in from today; everything else goes back to the start.

## 2026-10-16

- **Updating a big app is much faster.** AI apps connected to Formelab no longer rewrite a whole app to change it. The publish tool now takes just the edits (find this, replace with that) or just the files that changed, and Formelab applies them to the live app. Everything else, plus the app's data, sharing and settings, stays as it is. A one-line fix to a large app takes seconds instead of minutes. If an edit doesn't match, nothing is published and the AI is told which edit and why.
- **AI apps can read every file of an app.** A new read_file tool returns any file of an app in full, in pages for very large files, so edits can be made anywhere instead of only in the first 200 KB of index.html.
- **Deploy only what changed.** `scripts/publish.sh --dir dist --changed-only` compares a folder with the live app and uploads only the files that differ, removing the ones that are gone.
- **Shared links look great.** Send an app's link in iMessage, WhatsApp, Slack, Discord, LinkedIn or anywhere else with link previews and it now shows the app's name, a line about it and a big picture of what it is, instead of "Log in to Formelab". Opening the app still needs a sign-in; only the preview is public.
- **Each app gets its own preview picture.** AI apps (Claude, ChatGPT, Gemini, Grok and Make it in Formelab) now draw a share illustration for every app they make, along with a one-line description. Apps without one, including every app made before today, get a card with their icon, name and description. App makers can also add their own `share.svg` or `share.png` (1200×630), or name one with `og:image`.
- **Formelab's own links too.** formelab.ai, the login page and links into the web app show a Formelab card with "SaaS is dead." instead of a plain grey bubble.

## 2026-10-15

- **Share an app with anyone who has the link.** Each app's page has a new **Public link** section: turn it on and copy a link that opens the app for anyone, no Formelab account needed. People who open it that way can look at the app and read its shared data, but can't change anything unless they sign in (apps can offer a sign-in button with `formelab.signIn()`). **Make a new link** stops the old one working, for everyone who used it; **Turn off** ends it. Owners can also do this from Claude and other AI apps (`update_site` with `public_link`), and changes show in the app's activity.

## 2026-10-14

- **Make and change apps with Grok.** New app has a **Make it with Grok** button next to Claude, ChatGPT and Gemini, and app pages get **Change it with Grok**. It takes an API key from console.x.ai (billed to your own xAI account) and uses the newest Grok model the key can use.
- **Grok on Connect your AI.** A Grok tile with the steps to add Formelab as a custom connector on grok.com, and a Connected badge once Grok has signed in. **Make it with Grok** on New app opens Grok with your idea typed in, like Claude and ChatGPT.
- **Cursor on Connect your AI.** A Cursor tile with an **Add to Cursor** button (or the `mcp.json` to paste), then a Formelab sign-in from Cursor. It shows as Connected once Cursor has signed in.
- Fixed: connecting an AI app could freeze on Formelab's Allow page (seen with Grok's custom MCP connector). After Allow, the browser blocked the hand-off back to the app when its callback redirected on to another site, or used the app's own link scheme. Those hand-offs now go through.

## 2026-10-13

- **Make and change apps with Gemini, for free.** New app has a **Make it with Gemini** button next to Claude and ChatGPT, and app pages get **Change it with Gemini**. It takes a free key from Google AI Studio (no credit card) and uses the newest Gemini Flash model on Google's free tier. It's the same key as Google Gemini under Connected apps: add it in either place and it's there in both, and removing it removes it from both. Behind the same feature flag.
- **Change an app by describing it.** With your API key saved, each app's page has a **Change it with AI** box: say what to change ("add a dark mode"), press Change it with Claude or ChatGPT, and the new version is published in place. Its data, sharing, settings and other files stay as they are, and the change shows in the app's activity. Anyone who can update the app can use it, with their own key. Behind the same feature flag.
- **Make an app right here, with your own Claude or OpenAI API key.** On New app, "Make it with Claude" or "Make it with ChatGPT" now asks for an API key once (from console.anthropic.com or platform.openai.com). After that, describing the app and pressing Make it builds it inside Formelab and publishes it to your space, with a progress screen, then opens it. Nothing to set up in the Claude or ChatGPT app, and the tokens are billed to your own API account. Keys are checked when saved, stored encrypted, shown only by their last four characters, and can be changed or removed from the same pop-up. People who already connected Claude or ChatGPT to Formelab can still open it with the idea typed in. Behind the new **Build apps with your own API key** feature flag (admin panel → Features), off until turned on.
- **Get the app: Formelab and every app on it install like native apps.** Add Formelab, or any app made on it, to your phone's home screen (iPhone, iPad, Android) or install it on your computer (Chrome and Edge on Windows, Mac, Linux and Chromebooks, or Add to Dock in Safari). Each opens in its own window with its own icon. A new **Get the app** page in the left menu has an Install button where the browser supports it and step-by-step instructions for each device; each app's page has an "Install on your devices" section. Apps get this without any changes: Formelab adds the manifest and icon for them. App makers can add their own Install button with the SDK (`formelab.app.install()`). With no connection, Formelab shows an offline page instead of a browser error.
- Fixed: logging out of the admin panel could land you in your lab instead of on the admin login page. Logging out now ends your WorkOS sign-in directly and goes straight to the login page you came from.
- **Sign in on Formelab itself.** The login page at formelab.ai/login asks for your email first, then for your password, with "Email me a code instead" if you'd rather (codes are only sent when you ask), with Continue with Google underneath and a "Last used" label on the way you logged in last time. No trip to WorkOS's page; Forgot password and the reset link stay on Formelab too.
- **Set your own password.** A new Password page in the account menu lets people set or change a password, then log in with their email and password instead of waiting for a code. It asks you to log in again first if your last sign-in was more than 15 minutes ago.
- **Logging out really logs you out.** Logging out now also ends your sign-in at WorkOS, so the next Log in asks for a code or password again instead of signing you straight back in.
- Fixed: logging out of the web app showed a browser error page instead of the home page.
- **Logging in and out feel smoother.** A Formelab loading screen shows while you're being logged in or out, logging out takes you to the login page, and there's no plain "Logging you in/out" page in between anymore.
- Fixed: "Sign-in expired" after Forgot password or an emailed sign-in link. Those sign-ins now finish normally.
- **Turn a feature on for one person.** In the admin panel's Features tab, each feature has a "Turn on for this person" box: enter someone's email and they get the feature right away, whether it's Off, Admins only or Everyone. Their apps get it too, since features follow an app's owner. Remove them to take it back. Both show up in Activity.
- **Google Sheets, the first sign-in connected app.** Under Connected apps, people click Connect with Google and allow access to their spreadsheets; their apps can then read, add and update rows and create sheets through the SDK (`formelab.sheets`). No keys to copy: the sign-in is stored encrypted and refreshed automatically. Behind the Connected apps feature flag, and in Google's testing mode for now (test users only).
- **Admin panel gets a left menu.** The Formelab Admin Panel now has the same left menu as the web app: Users (Overview, Users, Waitlist, Activity) and Formelab (Features, Changelog, Vendors), with a Settings menu at the bottom for dark mode and logging out.
- **Changelog and Vendors in the admin panel.** A Changelog tab lists every change since launch, and a Vendors tab keeps track of every service, AI app and open-source project Formelab uses, or used and retired.
- **Connected apps behind a feature flag.** A new Features tab in the admin panel turns features Off, on for Admins only, or on for Everyone. Connected apps start Off: the page only says "Coming soon" and apps can't use connected services until it's on.
- **Google Gemini, the first connected app.** People add their Gemini API key once under Connected apps, and any of their apps can use Gemini 3.5 Flash-Lite through the SDK (`formelab.gemini.generate`). The key is checked with Google, stored encrypted, shown only by its last four characters, and never reaches an app. Apps use their owner's key, are limited to 60 calls a minute, and log every call. Newer `AQ.` style keys from Google AI Studio are accepted.
- **AI-made apps must have an icon.** The connector's publish tool refuses apps without an icon and tells the AI how to add one, so every app gets a proper tile. The build guide says so up front.
- **App icons on tiles.** Each app's favicon or logo is found when it's published and shown on its tile, in the list and on its page. Apps without one keep a colored letter. Icons are only shown to people who can open the app.
- **Browse apps as tiles or a list.** My apps and Shared with me show tiles grouped by space (the default) or a list with sortable columns, plus search, filters and sorting. Your choice of view is remembered.
- **A page for every app.** The gear on an app opens its own page: its details, settings and sharing, publishing a new version, recent activity and Delete.
- **Make an app from a prompt.** New app has a "What do you want to make?" box with example ideas. "Make it with Claude" or "Make it with ChatGPT" opens that AI with the idea typed in; "Copy for Claude Code" copies it.
- **Connect your AI, redesigned.** Logo tiles for Claude, ChatGPT, Gemini and Claude Code, each opening its setup steps in a pop-up, with a Connected badge (and Disconnect) once it's connected. Claude Code shows as connected after it uses an access key.
- **Connected apps page.** A "coming soon" card over a wall of 142 service logos.
- **New left menu.** The web app moved from tabs to a left menu: + New app, then Apps (My apps, Shared with me, Spaces) and Connect (Connect your AI, Connected apps), with an account menu for Access keys, dark mode, the admin panel and Log out. It folds behind a menu button on phones. Namespaces are now called Spaces and deploy tokens Access keys.
- **Activity logs per app.** The shared Recent activity list is gone. Each app has its own activity log in plain language ("Shared it with…", "Published a new version…"), and Formelab-wide events (people let in, admin changes, deleted accounts, spaces) are in the admin panel's Activity tab.
- Fixed: Connected badges didn't show on the web app after the move to formelab.app, and deleting an account from the admin panel didn't disconnect its AI apps.
- Fixed: an occasionally failing automated test.

## 2026-10-12

- **New addresses.** The web app moved to formelab.app and published apps to `<space>.formelab.app`. The home page, sign-in, waitlist and the AI connector stay on formelab.ai. Old app links redirect.
- **Admin panel at admin.formelab.ai.** A separate area for running Formelab (Overview, Users, Waitlist), with its own admins-only sign-in that lasts 8 hours. It opens in a new tab from the web app and has no link back to anyone's lab.
- **Admins can manage people.** Make or remove admins, delete accounts (with everything they own), and see who has been let in but hasn't logged in yet.
- **Email notifications** through Cloudflare Email Service: when someone joins the waitlist, is let in, or has an app shared with them, plus an email to the admin for each new sign-up.
- **Formelab accounts.** Sign in with Google or an email code (WorkOS), behind a waitlist. Apps are private by default; apps shared with you appear under Shared with me.
- **Connect your AI page** with steps for Claude (including the Free plan), ChatGPT, Gemini (CLI, and the Gemini app on Enterprise plans) and Claude Code.
- Publishing a new version of an app keeps its sharing settings.
- Apps open in a new tab from the web app, and its heading reads "My lab".
- New scripts and styles reach browsers right after a deploy.

## 2026-10-11

- Home page: violet buttons and the F logo mark from the updated prototype.

## 2026-10-10

- Home page redesigned after the "wall" prototype: a big hero, a scrolling rail of example apps, the waitlist form and How it works.

## 2026-10-09

- **Public home page** with a waitlist, a login screen, and a restyled web app.
- **ChatGPT support** for the connector: search and fetch tools, and setup steps.

## 2026-10-07

- **Sign in to the connector from Claude chat** (OAuth), so Claude can publish apps without an access key.
- The consent page submits once, and explains when it's been opened again.

## 2026-10-06

- Launchpad is renamed Formelab.

## 2026-10-02

- **Formelab launches.** Publish small web apps to their own address, each with sign-in, its own storage, and secrets kept on the server. Includes the publishing API, the MCP connector for AI apps, a web dashboard, the build guide for AIs, and deploy scripts.
