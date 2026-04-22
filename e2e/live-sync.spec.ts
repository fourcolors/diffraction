import { test, expect } from "@playwright/test";
import { makeTmpRepo, writeInRepo, cleanup, appUrl } from "./helpers";

/**
 * Scenario 5: Live sync
 *   Given working-tree mode open on a repo
 *   When a file changes on disk
 *   Then the diff updates within ~1s without manual refresh
 */
test.describe("Live sync", () => {
  let repo: string;

  test.beforeEach(async ({ page }) => {
    repo = makeTmpRepo({
      name: "live",
      files: { "README.md": "# Hello\nline two\n" },
    });
    // Clear any lingering state from prior runs
    await page.addInitScript(() => localStorage.clear());
  });

  test.afterEach(() => {
    cleanup(repo);
  });

  test("diff updates when file is modified on disk", async ({ page }) => {
    await page.goto(appUrl());

    // Open the repo via the input
    await page.getByTestId("repo-input").fill(repo);
    await page.getByTestId("open-btn").click();

    // Wait for the WS subscription to go live
    await expect(page.getByTestId("status")).toHaveAttribute("data-status", "live", { timeout: 10_000 });

    // Initial state: no changes → "No changes." empty state
    await expect(page.getByText("No changes.")).toBeVisible();

    // Modify the file externally — watcher should fire, WS should push new diff
    writeInRepo(repo, "README.md", "# Hello\nline two\nline three added\n");

    // Assert the diff for README.md appears within 5s (covers 1.5s poll + debounce + render)
    const fileDiff = page.getByTestId("file-diff").filter({ has: page.locator('[data-file="README.md"]') });
    await expect(page.getByTestId("file-diff")).toHaveCount(1, { timeout: 5_000 });
    await expect(page.getByTestId("file-diff").first()).toContainText("line three added", { timeout: 5_000 });
  });
});
