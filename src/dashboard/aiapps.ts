// Which AI apps a person has connected: OAuth sign-ins (Claude, ChatGPT, Gemini, Grok, Cursor) and access keys
// an AI app has used over MCP (Claude Code), matched by the app's name.
import { listTokens } from "../auth";
import type { Env, User } from "../env";
import { listConnections } from "../oauth";

export type AiApp = "claude" | "chatgpt" | "gemini" | "grok" | "cursor" | "claude-code";

/** Which AI app a client belongs to, from the name it registered or introduced itself with. */
export function tileFor(clientName: string): AiApp | null {
  const n = clientName.toLowerCase();
  if (n.includes("claude code") || n.includes("claude-code")) return "claude-code";
  if (n.includes("claude")) return "claude";
  if (n.includes("chatgpt") || n.includes("openai")) return "chatgpt";
  if (n.includes("gemini") || n.includes("antigravity")) return "gemini";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("grok") || n.includes("xai")) return "grok";
  return null;
}

export async function connectedAiApps(env: Env, user: User): Promise<Set<AiApp>> {
  const [grants, tokens] = await Promise.all([listConnections(env, user.email).catch(() => []), listTokens(env, user)]);
  const t = Date.now();
  const names = [
    ...grants.map((g) => g.clientName),
    ...tokens.filter((k) => k.clientName && !k.revoked && k.expiresAt > t).map((k) => k.clientName!),
  ];
  return new Set(names.map(tileFor).filter((x): x is AiApp => x !== null));
}
