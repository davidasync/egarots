import { buildService } from "./container";
import { newRouter, type Env } from "./app/http/router";

const app = newRouter(buildService);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
