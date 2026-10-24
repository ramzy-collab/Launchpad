export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  PROXY_LIMITER?: RateLimit;
  /** Public waitlist sign-ups per client IP. */
  WAITLIST_LIMITER?: RateLimit;
  /** Sign-in attempts (password, code, reset) per client IP. */
  LOGIN_LIMITER?: RateLimit;
  /** Responses each public-link guest may send an app (see responses.ts). */
  RESPONSES_LIMITER?: RateLimit;
  /** Gemini and Sheets calls from each person using someone else's app (see gemini.ts). */
  VIEWER_LIMITER?: RateLimit;
  /** OAuth grants, clients and tokens for the Claude chat connector (workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into requests it hands to the default handler. */
  OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  /** Home page, sign-in, waitlist, MCP connector, admin.DOMAIN (e.g. formelab.ai). */
  DOMAIN: string;
  /** Published apps, one host each: <host_label>.APP_DOMAIN (e.g. hoops-7kq2.formelab.app). See src/hosts.ts. */
  APP_DOMAIN: string;
  ENVIRONMENT: string;
  DEV_USER?: string;
  SECRETS_KEK: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  /** WorkOS AuthKit (Formelab's own login). When both are set, sign-in goes through WorkOS. */
  WORKOS_CLIENT_ID?: string;
  /** Formelab's Google OAuth client, for the Google Sheets connected app (README 1.9). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WORKOS_API_KEY?: string;
  /** Notification emails: Cloudflare Email Service's send_email binding, and the sender, e.g. "Formelab <hello@formelab.ai>". */
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  /** Where admin notifications (new waitlist sign-ups) go. Defaults to OWNER_EMAIL. */
  ADMIN_EMAIL?: string;
}

export interface User {
  email: string;
  name: string | null;
  isAdmin: boolean;
  /** False for accounts still on the waitlist: they can open apps shared with them, not create. */
  active: boolean;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: User;
    /**
     * On an app's host: the visitor came in through the app's public link and isn't someone who
     * may open it by name. `user` is not set; the runtime API only lets guests read.
     */
    guest: boolean | undefined;
    /** On an app's host: whether the signed-in person is one of the app's owners or editors (never a guest). */
    manages: boolean;
    site: import("./sites").SiteRow;
    /** The browser session behind the request, when it came from Formelab's own login. */
    sessionId: string | undefined;
    /** Feature flags this person has (web app and admin pages; see flags.ts). */
    features: Set<string>;
  };
};

export const isDev = (env: Env) => env.ENVIRONMENT === "dev";

export const now = () => Date.now();
