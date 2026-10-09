export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  PROXY_LIMITER?: RateLimit;
  /** Public waitlist sign-ups per client IP. */
  WAITLIST_LIMITER?: RateLimit;
  /** OAuth grants, clients and tokens for the Claude chat connector (workers-oauth-provider). */
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into requests it hands to the default handler. */
  OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  DOMAIN: string;
  ENVIRONMENT: string;
  DEV_USER?: string;
  SECRETS_KEK: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
}

export interface User {
  email: string;
  name: string | null;
  isAdmin: boolean;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: User;
    namespace: string;
    site: import("./sites").SiteRow;
  };
};

export const isDev = (env: Env) => env.ENVIRONMENT === "dev";

export const now = () => Date.now();
