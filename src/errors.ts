import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error that is safe to show to the caller as `{ error: { code, message, hint } }`. */
export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
    public hint: string,
  ) {
    super(message);
  }
}

export const err = (status: ContentfulStatusCode, code: string, message: string, hint: string) =>
  new ApiError(status, code, message, hint);

export const errorBody = (e: ApiError) => ({ error: { code: e.code, message: e.message, hint: e.hint } });

export function jsonError(e: ApiError): Response {
  return new Response(JSON.stringify(errorBody(e)), {
    status: e.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Hono onError handler: ApiErrors become JSON, anything else a generic 500 without internals. */
export function onError(e: Error, _c: Context): Response {
  if (e instanceof ApiError) return jsonError(e);
  console.error("unhandled error", e instanceof Error ? e.name : "unknown", e instanceof Error ? e.message : "");
  return jsonError(err(500, "internal", "Something went wrong on the server.", "Try again. If it keeps happening, check the Worker logs."));
}

export const unauthorized = () =>
  err(401, "unauthorized", "You are not signed in.", "Open the page in a browser to sign in through Cloudflare Access, or send a valid deploy token.");
export const forbidden = (message = "You do not have permission to do that.") =>
  err(403, "forbidden", message, "Ask the owner of this site or namespace to add you as an editor or to the allow-list.");
export const notFound = (what: string) => err(404, "not_found", `${what} was not found.`, "Check the name or path and try again.");
export const badRequest = (message: string, hint: string) => err(400, "bad_request", message, hint);
