// Each person's identity sent to Supabase (docs/specs/2026-11-22-agent-access.md, step 6b). Formelab
// is an OIDC issuer that a Supabase project trusts (Authentication → Third-Party Auth → Custom OIDC):
// each connector with identity on has its own issuer, <aiOrigin>/oidc/c/<id>, and its own ES256 key
// pair, so a token made for one project is never accepted by another. With every call through the
// connector, Formelab signs a 60-second token naming the signed-in person, and the project's
// row-level security policies decide what they see. Formelab only ever sets role "authenticated".
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import type { Context } from "hono";
import type { AppEnv, Env } from "./env";
import { err } from "./errors";
import { aiOrigin } from "./hosts";
import { decryptSecret, encryptSecret } from "./secrets";
import { normEmail, randomId } from "./util";

/** The only hosts a connector sending identities may call: a Supabase project's own address. */
const SUPABASE_HOST = /^[a-z0-9-]{1,63}\.supabase\.co$/;
export const supabaseHostsOnly = (hosts: string[]) => hosts.length > 0 && hosts.every((h) => SUPABASE_HOST.test(h));

/** A Supabase key that skips row-level security: a secret key, or a legacy JWT key with role service_role. */
export function isSupabaseServiceKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  try {
    return decodeJwt(key).role === "service_role";
  } catch {
    return false;
  }
}

export const issuerOf = (env: Env, connectorId: string) => `${aiOrigin(env)}/oidc/c/${connectorId}`;

// The private key is encrypted like the connector's own key, bound to it: AAD "connector:<id>:signing".
const scope = (id: string) => `connector:${id}`;

/** A new key pair for a connector, as the columns that store it. */
export async function newSigningKey(env: Env, connectorId: string) {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = randomId("k_", 16);
  const pub = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const { iv, ciphertext } = await encryptSecret(env, scope(connectorId), "signing", JSON.stringify(await exportJWK(privateKey)));
  return { kid, publicJwk: JSON.stringify(pub), iv, ciphertext };
}

export interface SigningRow {
  id: string;
  signing_kid: string | null;
  signing_iv: string | null;
  signing_private: string | null;
}

/** Who the token names: the signed-in person, their role in the app's rules, and whether they manage it. */
export interface Identity {
  email: string;
  role: string | null;
  manages: boolean;
  siteId: string;
}

/** A fresh 60-second token for one call. */
export async function identityToken(env: Env, row: SigningRow, who: Identity): Promise<string> {
  if (!row.signing_kid || !row.signing_iv || !row.signing_private) {
    throw err(500, "identity_key_missing", "This connector has no signing key.", "Its owner can turn \"Send each person's identity\" off and on again in Formelab.");
  }
  const jwk = JSON.parse(await decryptSecret(env, scope(row.id), "signing", row.signing_iv, row.signing_private)) as JWK;
  const email = normEmail(who.email);
  return new SignJWT({ email, role: "authenticated", formelab_role: who.role, formelab_manages: who.manages, formelab_app: who.siteId })
    .setProtectedHeader({ alg: "ES256", kid: row.signing_kid, typ: "JWT" })
    .setIssuer(issuerOf(env, row.id))
    .setSubject(email)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(await importJWK(jwk, "ES256"));
}

/** The public half, for the issuer's JWKS. */
const publicKeyOf = async (env: Env, id: string) =>
  env.DB.prepare("SELECT signing_public FROM connectors WHERE id = ? AND identity = 'supabase' AND signing_public IS NOT NULL").bind(id).first<{ signing_public: string }>();

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });

/** GET /oidc/c/:id/.well-known/openid-configuration: the issuer's discovery document, public. */
export async function oidcDiscovery(c: Context<AppEnv>): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!(await publicKeyOf(c.env, id))) return new Response("Not found", { status: 404 });
  // Exactly the issuer the tokens carry (identityToken), which Supabase compares.
  const issuer = issuerOf(c.env, id);
  return json({
    issuer,
    jwks_uri: `${issuer}/jwks.json`,
    id_token_signing_alg_values_supported: ["ES256"],
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    claims_supported: ["sub", "email", "role", "formelab_role", "formelab_manages", "formelab_app"],
  });
}

/** GET /oidc/c/:id/jwks.json: the connector's public key, public. */
export async function oidcJwks(c: Context<AppEnv>): Promise<Response> {
  const row = await publicKeyOf(c.env, c.req.param("id") ?? "");
  if (!row) return new Response("Not found", { status: 404 });
  return json({ keys: [JSON.parse(row.signing_public)] });
}
