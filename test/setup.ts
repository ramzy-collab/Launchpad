import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { installFetchMock } from "./helpers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
installFetchMock();
