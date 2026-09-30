import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.MIGRATIONS);

beforeEach(async () => {
  const { objects } = await env.BUCKET.list();

  await env.DB.exec("DELETE FROM emails");
  await env.BUCKET.delete(objects.map((object) => object.key));
});
