import { test, expect } from "@playwright/test";
import { makeTmpRepo, cleanup, appUrl } from "./helpers";

/**
 * Scenario 6: Repo switching
 *   Given I have opened repo A
 *   When I switch to repo B
 *   Then Diffraction shows repo B's branches/diffs
 *   And repo A appears in the "recent repos" list
 */
test.describe("Repo switching", () => {
  let repoA: string;
  let repoB: string;

  test.beforeEach(async ({ page }) => {
    repoA = makeTmpRepo({ name: "A", files: { "a.txt": "alpha\n" } });
    repoB = makeTmpRepo({ name: "B", files: { "b.txt": "bravo\n" } });
    await page.addInitScript(() => localStorage.clear());
  });

  test.afterEach(() => {
    cleanup(repoA);
    cleanup(repoB);
  });

  test("switching repos populates recent list and shows new repo's data", async ({ page }) => {
    await page.goto(appUrl());

    // Open repo A
    await page.getByTestId("repo-input").fill(repoA);
    await page.getByTestId("open-btn").click();
    await expect(page.getByTestId("status")).toHaveAttribute("data-status", "live", { timeout: 10_000 });

    // Switch to repo B
    await page.getByTestId("repo-input").fill(repoB);
    await page.getByTestId("open-btn").click();
    await expect(page.getByTestId("status")).toHaveAttribute("data-status", "live", { timeout: 10_000 });

    // Recent list should now contain BOTH paths, with A present (B is current)
    const recent = page.getByTestId("recent-item");
    await expect(recent).toHaveCount(2, { timeout: 5_000 });

    // Repo A must appear in recent list with its data-path attribute
    await expect(page.locator(`[data-testid="recent-item"][data-path="${repoA}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="recent-item"][data-path="${repoB}"]`)).toBeVisible();

    // Clicking repo A in the recent list switches back
    await page.locator(`[data-testid="recent-item"][data-path="${repoA}"]`).click();
    await expect(page.getByTestId("status")).toHaveAttribute("data-status", "live", { timeout: 10_000 });

    // The repo-input should now reflect repo A's path
    await expect(page.getByTestId("repo-input")).toHaveValue(repoA);
  });
});
