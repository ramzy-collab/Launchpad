# Changelog

Everything that has changed in Formelab, newest first. Shown in the admin panel under Changelog.

## 2026-10-13

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
