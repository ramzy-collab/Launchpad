import type { D1Migration } from "cloudflare:test";
import type { Env as LaunchpadEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends LaunchpadEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
