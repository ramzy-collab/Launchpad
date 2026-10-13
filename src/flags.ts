// Feature flags: new features ship turned off and are switched on in the admin panel (Features),
// first for admins only to try them, then for everyone. A flag with no row in feature_flags is off.
import { audit } from "./audit";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err } from "./errors";
import { getUser } from "./auth";

export const FLAGS = {
  connected_apps: {
    label: "Connected apps",
    description:
      "The Connected apps page and every service on it (Google Gemini so far): people connect a service once and their apps use it through the SDK. Off: the page only says \"Coming soon\" and apps can't use connected services.",
  },
} as const;

export type FlagName = keyof typeof FLAGS;
export type FlagState = "off" | "admins" | "on";
const STATES: FlagState[] = ["off", "admins", "on"];
export const STATE_LABEL: Record<FlagState, string> = { off: "Off", admins: "Admins only", on: "Everyone" };

export async function flagState(env: Env, name: FlagName): Promise<FlagState> {
  const row = await env.DB.prepare("SELECT state FROM feature_flags WHERE name = ?").bind(name).first<{ state: FlagState }>();
  return row?.state ?? "off";
}

const allows = (state: FlagState, user: Pick<User, "isAdmin"> | null) => state === "on" || (state === "admins" && !!user?.isAdmin);

/** Whether `user` gets the feature. */
export async function flagOn(env: Env, name: FlagName, user: Pick<User, "isAdmin"> | null): Promise<boolean> {
  return allows(await flagState(env, name), user);
}

/** Whether an app gets the feature: it follows the app's owner (it's their feature, and their key). */
export async function flagOnForOwner(env: Env, name: FlagName, ownerEmail: string): Promise<boolean> {
  const state = await flagState(env, name);
  if (state !== "admins") return state === "on";
  return allows(state, await getUser(env, ownerEmail));
}

export async function listFlags(env: Env) {
  const { results } = await env.DB.prepare("SELECT name, state, updated_at, updated_by FROM feature_flags").all<{
    name: string; state: FlagState; updated_at: number; updated_by: string | null;
  }>();
  const byName = new Map(results.map((r) => [r.name, r]));
  return (Object.keys(FLAGS) as FlagName[]).map((name) => {
    const r = byName.get(name);
    return { name, ...FLAGS[name], state: r?.state ?? ("off" as FlagState), updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  });
}

export async function setFlag(env: Env, admin: User, rawName: string, rawState: unknown) {
  if (!admin.isAdmin) throw err(403, "admin_only", "Only an admin can change features.", "Ask the Formelab owner.");
  if (!(rawName in FLAGS)) throw err(404, "not_found", `There's no feature called "${rawName}".`, "Pick one from the Features tab.");
  const state = String(rawState ?? "") as FlagState;
  if (!STATES.includes(state)) throw badRequest("state must be off, admins or on.", "Choose Off, Admins only or Everyone.");
  const name = rawName as FlagName;
  await env.DB.prepare(
    `INSERT INTO feature_flags (name, state, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(name, state, now(), admin.email)
    .run();
  await audit(env, admin.email, "feature_flag", name, { feature: FLAGS[name].label, state });
  return { name, state };
}

/**
 * Text with <!-- flag:NAME --> ... <!-- /flag:NAME --> blocks: kept (without the markers) for
 * features the person has, removed otherwise. Used for the build guide.
 */
export function withFlags(text: string, enabled: Set<string>): string {
  return text.replace(/<!-- flag:([a-z0-9_-]+) -->\n?([\s\S]*?)<!-- \/flag:\1 -->\n?/g, (_, name: string, body: string) => (enabled.has(name) ? body : ""));
}

export async function enabledFlags(env: Env, user: Pick<User, "isAdmin"> | null): Promise<Set<string>> {
  const states = await Promise.all((Object.keys(FLAGS) as FlagName[]).map(async (n) => [n, await flagState(env, n)] as const));
  return new Set(states.filter(([, s]) => allows(s, user)).map(([n]) => n));
}
