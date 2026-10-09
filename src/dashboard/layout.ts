// Shared page chrome: <head>, nav and security headers for the home page, login, dashboard and
// consent page. Styles and scripts are served files so every page keeps a strict CSP.
import { escapeHtml as e } from "../util";

const FONTS = "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=Inter:wght@400;500;600&family=Permanent+Marker&display=swap";

/** Google Fonts is the only third party: its stylesheet and font files. */
export const FONT_CSP = "style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com";

// The mark: a tilted accent square with a yellow dot.
const ICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="3" y="5" width="24" height="24" rx="8" fill="#5B4CF5" transform="rotate(-6 15 17)"/><circle cx="26" cy="6" r="4.5" fill="#FFC93C"/></svg>`,
);

export const PAGE_CSP = `default-src 'self'; script-src 'self'; ${FONT_CSP}; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;

export function head(title: string, scripts: string[] = []): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/_assets/formelab.css">
<script src="/_assets/theme.js"></script>
${scripts.map((s) => `<script src="/_assets/${s}" defer></script>`).join("\n")}`;
}

const SUN = `<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const MOON = `<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>`;

/** Top bar: the Formelab mark linking to `home`, the theme toggle, then `right` (already-escaped HTML). */
export function nav(home: string, right = ""): string {
  return `<nav class="nav">
  <a class="brand" href="${e(home)}" aria-label="Formelab home"><span class="mark"></span>Formelab</a>
  <div class="nav-right">
    <button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch light or dark mode">${SUN}${MOON}</button>
    ${right}
  </div>
</nav>`;
}

export function htmlResponse(html: string, csp = PAGE_CSP, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      "x-frame-options": "DENY",
    },
  });
}
