import { expect, test, type Page } from "@playwright/test";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1";
const wall = (page: Page, id: string) => page.getByTestId(`plan-wall-${id}`);

async function openStory(page: Page, fragment: string): Promise<void> {
  const response = await page.request.get("/index.json");
  expect(response.ok()).toBe(true);
  const data = await response.json() as { entries: Record<string, { title: string; name: string }> };
  const matching = Object.entries(data.entries).find(([id, entry]) => entry.title === "Studio/PlanView" && id.includes(fragment));
  if (!matching) throw new Error("Missing Storybook plan view story: " + fragment);
  await page.goto("/iframe.html?id=" + matching[0] + "&viewMode=story");
  await expect(page.getByRole("group", { name: /^Plan of / })).toBeVisible();
}
const centre = async (locator: ReturnType<Page["getByTestId"]>) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error("element has no box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test("typed numeric entry with axis constraint while dragging an endpoint (Blender G style)", async ({ page }) => {
  await openStory(page, "connected");
  await wall(page, A).click();
  const end = await centre(page.getByTestId("plan-handle-end"));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(end.x + 3, end.y - 3, { steps: 2 });
  await page.keyboard.press("y");
  await page.keyboard.type("1.5");
  await expect(page.getByTestId("plan-numeric-hud")).toContainText("Length 1.5 m");
  await expect(page.getByTestId("plan-numeric-hud")).toContainText("Axis Y");
  await expect(wall(page, B)).toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,0");
  await page.keyboard.press("Enter");
  await page.mouse.up();
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,1.5");
  await expect(page.getByTestId("commit-count")).toHaveText("1");
  await expect(page.getByTestId("plan-history")).toHaveText("1 undo / 0 redo");
});

test("draw with typed length, Tab to angle, Enter commits; Escape cancels", async ({ page }) => {
  await openStory(page, "connected");
  await page.getByRole("button", { name: "Draw wall", exact: true }).click();
  const svg = await page.getByRole("group", { name: /^Plan of / }).boundingBox();
  if (!svg) throw new Error("no plan");
  await page.mouse.click(svg.x + 120, svg.y + 60);
  await page.mouse.move(svg.x + 200, svg.y + 62, { steps: 2 });
  await page.keyboard.type("3");
  await page.keyboard.press("Tab");
  await page.keyboard.type("90");
  await expect(page.getByTestId("plan-numeric-hud")).toContainText("Length 3 m");
  await expect(page.getByTestId("plan-numeric-hud")).toContainText("Angle 90°");
  await page.keyboard.press("Enter");
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(5);
  await expect(page.getByTestId("commit-count")).toHaveText("1");
  await expect(page.getByLabel("Length (m)", { exact: true })).toHaveValue("3");
  await page.mouse.click(svg.x + 400, svg.y + 300);
  await page.mouse.move(svg.x + 450, svg.y + 300, { steps: 2 });
  await page.keyboard.type("2");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("plan-numeric-hud")).toHaveCount(0);
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(5);
  await expect(page.getByTestId("commit-count")).toHaveText("1");
});

test("shows snap indicators, selection annotations, joints and grid size control", async ({ page }) => {
  await openStory(page, "connected");
  await expect(page.locator(".teldra-plan-view__joint").first()).toBeAttached();
  await wall(page, A).click();
  await expect(page.getByTestId("plan-thickness-label")).toHaveText("t 0.2 m");
  await expect(page.locator(".teldra-plan-view__dimension", { hasText: "4 m" })).toBeVisible();
  await page.getByLabel("Grid size").selectOption("0.5");
  await page.getByRole("button", { name: "Draw wall", exact: true }).click();
  const mid = await centre(wall(page, A));
  await page.mouse.move(mid.x, mid.y - 2);
  await expect(page.getByTestId("plan-snap")).toHaveAttribute("data-snap", "midpoint");
  await expect(page.getByTestId("plan-snap")).toContainText("Midpoint");
  const start = await centre(page.getByTestId("plan-handle-start"));
  await page.mouse.move(start.x + 1, start.y + 1);
  await expect(page.getByTestId("plan-snap")).toHaveAttribute("data-snap", "endpoint");
});
