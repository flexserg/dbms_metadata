import { test, expect } from "@playwright/test";
import { mssqlFixture } from "../fixtures/mssql.js";
test("SQL Server connection and metadata use the shared workspace", async ({
  page,
}) => {
  test.skip(
    !process.env.MSSQL_INTEGRATION,
    "Enable SQL Server integration to run this browser test",
  );
  const fixture = await mssqlFixture();
  let id;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto("/");
    await page.getByLabel("Workspace password").fill("integration-password");
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page
      .getByRole("button", { name: "New connection", exact: true })
      .click();
    const form = page.getByRole("dialog");
    await form
      .getByRole("combobox", { name: "Database type", exact: true })
      .selectOption("mssql");
    await expect(form.getByLabel("Port", { exact: true })).toHaveValue("1433");
    await form.getByLabel("Connection name").fill("MSSQL browser");
    await form
      .getByLabel("Host", { exact: true })
      .fill(fixture.connection.host);
    await form
      .getByLabel("Port", { exact: true })
      .fill(String(fixture.connection.port));
    await form.getByLabel("Database", { exact: true }).fill(fixture.name);
    await form
      .getByLabel("Username", { exact: true })
      .fill(fixture.connection.username);
    await form
      .getByLabel("Password", { exact: true })
      .fill(fixture.connection.password);
    await form.getByLabel("TLS mode").selectOption("trust-server-certificate");
    await form.getByRole("button", { name: "Test connection" }).click();
    await expect(form.getByRole("status")).toContainText("SQL Server");
    const saved = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/connections") && r.request().method() === "POST",
    );
    await form.getByRole("button", { name: "Save connection" }).click();
    id = (await (await saved).json()).id;
    await expect(form).not.toBeVisible();
    await page.locator('[data-schema="app"]').click();
    await expect(page.locator("#engine-badge")).toHaveText("SQL Server");
    await page
      .getByRole("cell", { name: "Items", exact: false })
      .first()
      .click();
    await expect(page.locator("#content")).toContainText("IDENTITY(10, 5)");
    await expect(page.locator("#content")).toContainText("PERSISTED");
    await expect(page.locator("#content")).toContainText("[app].[Code]");
    await page.getByRole("button", { name: "Keys", exact: true }).click();
    await expect(page.locator("#content")).toContainText("[app].[Parent]");
    await expect(page.locator("#content")).toContainText("CASCADE");
    await page
      .getByRole("button", { name: "Constraints", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "Disabled", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Data preview", exact: true })
      .click();
    await expect(
      page.getByRole("cell", { name: "Preview sample", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back", exact: false }).click();
    await page
      .getByRole("cell", { name: "Events", exact: false })
      .first()
      .click();
    await page.getByRole("button", { name: "Partitions", exact: true }).click();
    await expect(page.locator("#content tbody tr")).toHaveCount(3);
    await expect(page.locator("#content")).toContainText("RANGE RIGHT");
    await expect(page.locator("#content")).toContainText("RangeScheme");
    await page.screenshot({
      path: "test-results/mssql-partitions.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Back", exact: false }).click();
    await page
      .getByRole("cell", { name: "Items", exact: false })
      .first()
      .click();
    await fixture.db
      .request()
      .batch("ALTER TABLE app.Items ADD browser_column int NULL");
    await page
      .getByRole("button", { name: "Refresh metadata", exact: false })
      .click();
    await expect(page.locator("#notice")).toContainText("Refresh complete");
    await expect(
      page.getByRole("cell", { name: "browser_column", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Change history", exact: true })
      .click();
    await expect(page.locator("#content")).not.toContainText("browser_column");
    await page.locator(".history-job summary").first().click();
    await expect(page.locator("#content")).toContainText("browser_column");
    expect(errors).toEqual([]);
  } finally {
    if (id) await page.request.delete(`/api/connections/${id}`, { data: {} });
    await fixture.cleanup();
  }
});
