// Feature flags: new features ship turned off and are switched on in the admin panel (Features),
// first for admins only to try them, then for everyone. A flag with no row in feature_flags is off.
// A feature can also be turned on for specific people (feature_flag_users), whatever its state.
import { audit } from "./audit";
import type { Env, User } from "./env";
import { now } from "./env";
import { badRequest, err } from "./errors";
import { getUser } from "./auth";
import { isEmail, normEmail } from "./util";

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

type FlagUser = Pick<User, "isAdmin" | "email">;

const allows = (state: FlagState, user: Pick<User, "isAdmin"> | null) => state === "on" || (state === "admins" && !!user?.isAdmin);

async function onForPerson(env: Env, name: FlagName, email: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM feature_flag_users WHERE name = ? AND email = ?").bind(name, email).first());
}

/** Whether `user` gets the feature: by the flag's state, or because it's on for them by name. */
export async function flagOn(env: Env, name: FlagName, user: FlagUser | null): Promise<boolean> {
  if (allows(await flagState(env, name), user)) return true;
  return !!user && onForPerson(env, name, user.email);
}

/** Whether an app gets the feature: it follows the app's owner (it's their feature, and their key). */
export async function flagOnForOwner(env: Env, name: FlagName, ownerEmail: string): Promise<boolean> {
  const state = await flagState(env, name);
  if (state === "on") return true;
  if (await onForPerson(env, name, ownerEmail)) return true;
  return state === "admins" && allows(state, await getUser(env, ownerEmail));
}

export async function listFlags(env: Env) {
  const [{ results }, { results: people }] = await Promise.all([
    env.DB.prepare("SELECT name, state, updated_at, updated_by FROM feature_flags").all<{
      name: string; state: FlagState; updated_at: number; updated_by: string | null;
    }>(),
    env.DB.prepare("SELECT name, email, added_at, added_by FROM feature_flag_users ORDER BY email").all<{
      name: string; email: string; added_at: number; added_by: string | null;
    }>(),
  ]);
  const byName = new Map(results.map((r) => [r.name, r]));
  return (Object.keys(FLAGS) as FlagName[]).map((name) => {
    const r = byName.get(name);
    const users = people.filter((p) => p.name === name).map((p) => ({ email: p.email, addedAt: p.added_at, addedBy: p.added_by }));
    return { name, ...FLAGS[name], state: r?.state ?? ("off" as FlagState), updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null, users };
  });
}

function flagName(admin: User, rawName: string): FlagName {
  if (!admin.isAdmin) throw err(403, "admin_only", "Only an admin can change features.", "Ask the Formelab owner.");
  if (!(rawName in FLAGS)) throw err(404, "not_found", `There's no feature called "${rawName}".`, "Pick one from the Features tab.");
  return rawName as FlagName;
}

/** Turns a feature on for one person, whatever the flag's state. */
export async function addFlagUser(env: Env, admin: User, rawName: string, rawEmail: unknown) {
  const name = flagName(admin, rawName);
  const email = normEmail(String(rawEmail ?? ""));
  if (!isEmail(email)) throw badRequest("That email address is not valid.", "Check the address and try again.");
  await env.DB.prepare("INSERT OR IGNORE INTO feature_flag_users (name, email, added_at, added_by) VALUES (?, ?, ?, ?)")
    .bind(name, email, now(), admin.email)
    .run();
  await audit(env, admin.email, "feature_flag_user_add", name, { feature: FLAGS[name].label, email });
  return { name, email };
}

/** Takes a feature back from one person (they keep it if the flag's state still gives it to them). */
export async function removeFlagUser(env: Env, admin: User, rawName: string, rawEmail: string) {
  const name = flagName(admin, rawName);
  const email = normEmail(rawEmail);
  const r = await env.DB.prepare("DELETE FROM feature_flag_users WHERE name = ? AND email = ?").bind(name, email).run();
  if (!r.meta.changes) throw err(404, "not_found", `${FLAGS[name].label} isn't turned on for ${email} by name.`, "Reload the Features tab.");
  await audit(env, admin.email, "feature_flag_user_remove", name, { feature: FLAGS[name].label, email });
  return { name, email };
}

export async function setFlag(env: Env, admin: User, rawName: string, rawState: unknown) {
  const name = flagName(admin, rawName);
  const state = String(rawState ?? "") as FlagState;
  if (!STATES.includes(state)) throw badRequest("state must be off, admins or on.", "Choose Off, Admins only or Everyone.");
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

export async function enabledFlags(env: Env, user: FlagUser | null): Promise<Set<string>> {
  const [states, mine] = await Promise.all([
    Promise.all((Object.keys(FLAGS) as FlagName[]).map(async (n) => [n, await flagState(env, n)] as const)),
    user ? env.DB.prepare("SELECT name FROM feature_flag_users WHERE email = ?").bind(user.email).all<{ name: string }>() : null,
  ]);
  const byName = new Set(mine?.results.map((r) => r.name));
  return new Set(states.filter(([n, s]) => allows(s, user) || byName.has(n)).map(([n]) => n));
}
