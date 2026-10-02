export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  PROXY_LIMITER?: RateLimit;
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
