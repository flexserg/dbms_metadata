import { test, expect } from "@playwright/test";

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
  await page.getByRole("button", { name: "Constraints", exact: true }).click();
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
