import { expect, test } from "bun:test";
import { docsRoutes } from "./docs.routes";

test("catalog adds searchable guide text while keeping document links", async () => {
  const response = await docsRoutes.request("/catalog");
  expect(response.status).toBe(200);
  const catalog = await response.json() as Array<{ path: string; title: string; searchText: string }>;
  const home = catalog.find((entry) => entry.path === "index.md");
  expect(home?.title).toBeTruthy();
  expect(home?.searchText).toContain("creative roleplay");
  expect(home?.searchText).not.toContain("](getting-started/");

  const key = Buffer.from("index.md").toString("base64url");
  const document = await docsRoutes.request("/file/" + key);
  expect(document.status).toBe(200);
  expect(await document.text()).toContain("creative roleplay");
});
