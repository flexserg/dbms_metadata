import { test, expect } from "@playwright/test";
import pg from "pg";

test("nested types, partition subtrees, and immediate compact preview", async ({
  page,
}) => {
  const database =
    process.env.TEST_DATABASE_URL ||
    "postgresql://metadata:integration-password@127.0.0.1:55432/metadata";
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  const schema = "trees_" + Date.now();
  let id;
  const pending = [];
  let failPreview = false;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TYPE ${schema}.geo AS (latitude numeric,longitude numeric);
      CREATE TYPE ${schema}.address AS (city text,point ${schema}.geo);
      CREATE TYPE ${schema}.contact AS (home ${schema}.address,previous ${schema}.address[]);
      CREATE DOMAIN ${schema}.address_domain AS ${schema}.address;
      CREATE TABLE ${schema}.items(id integer,customer ${schema}.contact,domain_address ${schema}.address_domain);
      INSERT INTO ${schema}.items(id) VALUES(42);
      CREATE TABLE ${schema}.events(id integer,month integer) PARTITION BY RANGE(month);
      CREATE TABLE ${schema}.events_early PARTITION OF ${schema}.events FOR VALUES FROM (1) TO (7) PARTITION BY HASH(id);
      CREATE TABLE ${schema}.events_early_0 PARTITION OF ${schema}.events_early FOR VALUES WITH (MODULUS 2,REMAINDER 0);
      CREATE TABLE ${schema}.events_late PARTITION OF ${schema}.events FOR VALUES FROM (7) TO (13);`);
    await page.request.post("/api/login", {
      data: { password: "integration-password" },
    });
    const parsed = new URL(database);
    const created = await page.request.post("/api/connections", {
      data: {
        name: schema,
        host: parsed.hostname,
        port: Number(parsed.port),
        database: parsed.pathname.slice(1),
        username: parsed.username,
        password: parsed.password,
        sslMode: "disable",
      },
    });
    const body = await created.json();
    expect(created.status()).toBe(201);
    id = body.id;
    await expect
      .poll(async () => {
        const jobs = await page.request.get(`/api/connections/${id}/jobs`);
        return (await jobs.json()).find((j) => j.id === body.job.id).status;
      })
      .toBe("succeeded");
    const objects = await (
      await page.request.get(`/api/connections/${id}/objects?schema=${schema}`)
    ).json();
    const object = (name) => objects.find((o) => o.name === name);
    const objectRow = (name) =>
      page.locator(`tr[data-object="${object(name).id}"]`);
    await page.goto("/");
    await page.locator(`[data-connect="${id}"]`).click();
    await page.locator(`[data-schema="${schema}"]`).click();
    await expect(
      page.getByRole("button", { name: "Types", exact: true }),
    ).toHaveCount(0);
    await objectRow("items").locator("td").nth(1).click();
    await page
      .getByRole("button", { name: "Expand customer", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Expand home", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Expand point", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "latitude", exact: true }),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Expand previous", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "city", exact: true }),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "Expand domain_address", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "city", exact: true }),
    ).toHaveCount(3);
    await page
      .getByRole("button", { name: "Collapse customer", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "latitude", exact: true }),
    ).toHaveCount(0);
    const metadataPadding = await page
      .locator("#content tbody td")
      .first()
      .evaluate((e) => parseFloat(getComputedStyle(e).paddingTop));
    await page.route("**/preview?*", async (route) => {
      await new Promise((resolve) => pending.push(resolve));
      if (failPreview)
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "Test source unavailable" }),
        });
      else await route.continue();
    });
    await page
      .getByRole("button", { name: "Data preview", exact: true })
      .click();
    await expect(page.locator('[data-tab="Data preview"]')).toHaveClass(
      /active/,
    );
    await expect(page.locator("#content")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#content").getByRole("status")).toContainText(
      "Retrieving data",
    );
    await expect.poll(() => pending.length).toBe(1);
    // A late preview response must not reopen the tab after navigation away.
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    const late = page.waitForResponse((r) => r.url().includes("/preview?"));
    pending.shift()();
    await late;
    await expect(page.locator('[data-tab="Columns"]')).toHaveClass(/active/);
    failPreview = true;
    await page
      .getByRole("button", { name: "Data preview", exact: true })
      .click();
    await expect.poll(() => pending.length).toBe(1);
    pending.shift()();
    await expect(page.locator("#content").getByRole("alert")).toContainText(
      "Test source unavailable",
    );
    failPreview = false;
    await page
      .getByRole("button", { name: "Retry data preview", exact: true })
      .click();
    await expect(page.locator("#content").getByRole("status")).toBeVisible();
    await expect.poll(() => pending.length).toBe(1);
    pending.shift()();
    await expect(
      page.getByRole("cell", { name: "42", exact: true }),
    ).toBeVisible();
    expect(
      await page
        .locator("#content tbody td")
        .first()
        .evaluate((e) => parseFloat(getComputedStyle(e).paddingTop)),
    ).toBeLessThan(metadataPadding);
    await page.screenshot({
      path: "test-results/compact-preview.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    expect(
      await page
        .locator("#content tbody td")
        .first()
        .evaluate((e) => parseFloat(getComputedStyle(e).paddingTop)),
    ).toBe(metadataPadding);
    await page.getByRole("button", { name: "Back", exact: false }).click();
    await expect(objectRow("events_early")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Expand table events", exact: true })
      .click();
    await expect(objectRow("events_early")).toBeVisible();
    await expect(objectRow("events_early_0")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Expand table events_early", exact: true })
      .click();
    await expect(objectRow("events_early_0")).toBeVisible();
    await objectRow("events_early").locator("td").nth(1).click();
    await page.getByRole("button", { name: "Partitions", exact: true }).click();
    await expect(page.locator("#content tbody tr")).toHaveCount(2);
    const early = page.locator("#content tbody tr").first(),
      leaf = page.locator("#content tbody tr").nth(1);
    await expect(early.locator("td").nth(2)).toHaveText("0");
    await expect(early.locator("td").nth(3)).toHaveText("HASH");
    await expect(early.locator("td").nth(4)).toHaveText("HASH (id)");
    await expect(early.locator("td").nth(5)).toContainText("FROM (1) TO (7)");
    await expect(leaf.locator("td").nth(3)).toHaveText("—");
    await expect(leaf.locator("td").nth(4)).toHaveText("—");
    await expect(leaf.locator("td").nth(5)).toContainText("modulus 2");
    await page
      .getByRole("button", {
        name: "Collapse partition events_early",
        exact: true,
      })
      .click();
    await expect(page.locator("#content tbody tr")).toHaveCount(1);
    await page.getByRole("button", { name: "Back", exact: false }).click();
    await objectRow("events_early_0").locator("td").nth(1).click();
    await page.getByRole("button", { name: "Partitions", exact: true }).click();
    await expect(page.locator("#content tbody tr")).toHaveCount(1);
    await expect(page.locator("#content tbody tr td").nth(2)).toHaveText("0");
    await expect(page.locator("#content tbody tr td").nth(3)).toHaveText("—");
    expect(errors).toEqual([]);
  } finally {
    for (const resolve of pending) resolve();
    await page.unrouteAll({ behavior: "wait" });
    if (id)
      await admin.query("DELETE FROM metadata_connections WHERE id=$1", [id]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("operator connects, browses metadata, filters, and signs out", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("integration-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page
    .getByRole("button", { name: "New connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Connection name").fill("Browser fixture");
  await dialog.getByLabel("Host", { exact: true }).fill("127.0.0.1");
  await dialog.getByLabel("Port", { exact: true }).fill("55432");
  await dialog.getByLabel("Database", { exact: true }).fill("metadata");
  await dialog.getByLabel("Username", { exact: true }).fill("metadata");
  await dialog
    .getByLabel("Password", { exact: true })
    .fill("integration-password");
  await dialog.getByLabel("TLS mode").selectOption("disable");
  await dialog.getByRole("button", { name: "Test connection" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "Connected to metadata",
  );
  await dialog.getByRole("button", { name: "Save connection" }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator('[data-schema="fixture"]').click();
  await page.getByRole("cell", { name: "child", exact: false }).first().click();
  await expect(
    page.getByRole("heading", { name: "child", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "parent_id", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keys", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Foreign key", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Indexes", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "child_note_idx", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/explorer.png", fullPage: true });
  await page.getByRole("button", { name: "Back", exact: false }).click();
  await page.getByRole("searchbox").fill("labels");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("cell", { name: "labels", exact: false }).click();
  await page.getByRole("button", { name: "Definition", exact: true }).click();
  await expect(page.locator("pre")).toContainText("SELECT");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "labels", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete Browser fixture", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Delete Browser fixture", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: false }).click();
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  expect(errors).toEqual([]);
});

test("snapshot refresh, logical keys, preview, scheduling and table history work in the browser", async ({
  page,
}) => {
  const database =
    process.env.TEST_DATABASE_URL ||
    "postgresql://metadata:integration-password@127.0.0.1:55432/metadata";
  const admin = new pg.Client({ connectionString: database });
  await admin.connect();
  const schema =
    "browser_" + Date.now() + "_long_schema_name_for_mobile_layout";
  let id;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await admin.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.items(id integer PRIMARY KEY,note text);
      INSERT INTO ${schema}.items VALUES(1,'Preview example');`);
    await page.request.post("/api/login", {
      data: { password: "integration-password" },
    });
    const parsed = new URL(database);
    const created = await page.request.post("/api/connections", {
      data: {
        name: schema,
        host: parsed.hostname,
        port: Number(parsed.port),
        database: parsed.pathname.slice(1),
        username: parsed.username,
        password: parsed.password,
        sslMode: "disable",
      },
    });
    const body = await created.json();
    expect(created.status()).toBe(201);
    id = body.id;
    await expect
      .poll(async () => {
        const jobs = await page.request.get(`/api/connections/${id}/jobs`);
        return (await jobs.json()).find((j) => j.id === body.job.id).status;
      })
      .toBe("succeeded");
    await page.goto("/");
    await page.locator(`[data-connect="${id}"]`).click();
    await page.locator(`[data-schema="${schema}"]`).click();
    await page
      .getByRole("cell", { name: "items", exact: false })
      .first()
      .click();
    await page.getByRole("button", { name: "Keys", exact: true }).click();
    await page
      .getByRole("button", { name: "Define logical primary key" })
      .click();
    await page.getByLabel("Key name", { exact: true }).fill("business_key");
    await page.getByRole("dialog").getByLabel("id", { exact: true }).check();
    await page
      .getByRole("button", { name: "Save logical key", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "business_key", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Data preview", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "Preview example", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Auto-refresh interval").fill("5");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByRole("status").first()).toContainText(
      "every 5 minutes",
    );
    await admin.query(
      `ALTER TABLE ${schema}.items ADD COLUMN fresh_column integer DEFAULT 7`,
    );
    await page
      .getByRole("button", { name: "Refresh metadata", exact: false })
      .click();
    await expect(page.getByRole("status").first()).toContainText(
      "Refresh complete",
    );
    await expect(
      page.getByRole("cell", { name: "fresh_column", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Change history", exact: true })
      .click();
    await expect(page.locator("#content")).not.toContainText("fresh_column");
    for (const summary of await page.locator(".history-job summary").all())
      await summary.click();
    await expect(page.locator("#content")).toContainText("fresh_column");
    await expect(page.locator("#content")).toContainText("business_key");
    await expect(page.locator("#content")).toContainText("added");
    await page.screenshot({
      path: "test-results/table-history.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "History settings", exact: true })
      .click();
    await page.getByLabel("Retention (days)", { exact: true }).fill("14");
    await page
      .getByRole("button", { name: "Save retention", exact: true })
      .click();
    await expect(page.locator("#history-feedback")).toContainText(
      "Retention saved",
    );
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "Delete historical changes", exact: true })
      .click();
    await expect(page.locator("#history-feedback")).toContainText("Deleted");
    await page
      .getByRole("button", { name: "Close history settings", exact: true })
      .click();
    await expect(page.locator(".history-job")).toHaveCount(0);
    await page.getByRole("button", { name: "Back", exact: false }).click();
    await page
      .getByRole("button", { name: "Refresh jobs", exact: true })
      .click();
    await expect(page.locator("#content")).toContainText("succeeded");
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(
          () =>
            page.evaluate(
              (expectedWidth) =>
                innerWidth === expectedWidth &&
                document.documentElement.scrollWidth <= expectedWidth,
              width,
            ),
          {
            message: `Refresh jobs must fit a ${width}px viewport with a long schema name`,
          },
        )
        .toBe(true);
      await expect(
        page.getByRole("heading", { name: schema, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Refresh metadata", exact: false }),
      ).toBeVisible();
    }
    expect(errors).toEqual([]);
  } finally {
    if (id)
      await admin.query("DELETE FROM metadata_connections WHERE id=$1", [id]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
