import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const A = "0TeldraWallAAAAAAAAAA1", B = "0TeldraWallBBBBBBBBBB1", C = "0TeldraWallCCCCCCCCCC1", D = "0TeldraWallDDDDDDDDDD1";
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
/** Pixels per metre from the two handles of the selected wall (A is 4 m long, horizontal). */
async function pixelsPerMetre(page: Page): Promise<number> {
  const s = await centre(page.getByTestId("plan-handle-start")), e = await centre(page.getByTestId("plan-handle-end"));
  return Math.hypot(e.x - s.x, e.y - s.y) / 4;
}

test("dragging a joined endpoint previews the connected wall, applies as one undo unit and undoes", async ({ page }) => {
  await openStory(page, "connected");
  await page.getByLabel("Angle snap").selectOption("0");
  await wall(page, A).click();
  await expect(page.getByTestId("selected-wall")).toHaveText(A);
  const ppm = await pixelsPerMetre(page);
  const end = await centre(page.getByTestId("plan-handle-end"));

  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y - ppm * 0.5, { steps: 4 });
  await page.mouse.move(end.x, end.y - ppm, { steps: 4 });
  // Live preview comes from editor.preview(): the connected wall B follows, canonical IFC is untouched.
  await expect(wall(page, A)).toHaveAttribute("data-preview", "true");
  await expect(wall(page, B)).toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,0");
  await expect(page.getByTestId("commit-count")).toHaveText("0");
  await page.mouse.up();

  await expect(page.getByTestId("commit-count")).toHaveText("1");
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,1");
  await expect(wall(page, B)).toHaveAttribute("data-preview", "false");
  await expect(page.getByTestId("plan-message")).toContainText("1 connected wall followed");
  await expect(page.getByTestId("plan-history")).toHaveText("1 undo / 0 redo");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,0");
  await expect(page.getByTestId("commit-count")).toHaveText("2");
  await expect(page.getByTestId("plan-history")).toHaveText("0 undo / 1 redo");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,1");
});

test("Escape cancels a drag without touching IFC or history", async ({ page }) => {
  await openStory(page, "connected");
  await page.getByLabel("Angle snap").selectOption("0");
  await wall(page, A).click();
  const ppm = await pixelsPerMetre(page);
  const end = await centre(page.getByTestId("plan-handle-end"));
  await page.mouse.move(end.x, end.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y - ppm, { steps: 5 });
  await expect(wall(page, B)).toHaveAttribute("data-preview", "true");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(wall(page, B)).toHaveAttribute("data-preview", "false");
  await expect(page.getByTestId("plan-message")).toContainText("cancelled");
  await expect(page.getByTestId("commit-count")).toHaveText("0");
  await expect(page.getByTestId("plan-history")).toHaveText("0 undo / 0 redo");
  await expect(page.getByTestId("canonical-b-start")).toHaveText("4,0");
});

test("whole-wall drag translates a free wall", async ({ page }) => {
  await openStory(page, "connected");
  await wall(page, C).click();
  await expect(page.getByTestId("selected-wall")).toHaveText(C);
  const before = await centre(wall(page, C));
  const ppm = (await centre(page.getByTestId("plan-handle-end"))).x - (await centre(page.getByTestId("plan-handle-start"))).x;
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x, before.y + (ppm / 2) * 1, { steps: 5 }); // 2 m wide wall: ppm/2 px per metre, move 1 m down
  await expect(wall(page, C)).toHaveAttribute("data-preview", "true");
  await page.mouse.up();
  await expect(page.getByTestId("commit-count")).toHaveText("1");
  await expect(page.getByTestId("plan-message")).toContainText("Moved");
});

test("keyboard numeric entry resizes a wall and shows explicit refusal for invalid values", async ({ page }) => {
  await openStory(page, "connected");
  await wall(page, C).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("selected-wall")).toHaveText(C);
  const length = page.getByLabel("Length (m)", { exact: true });
  await length.fill("3.5");
  await length.press("Enter");
  await expect(page.getByTestId("commit-count")).toHaveText("1");
  await expect(page.getByTestId("plan-message")).toContainText("length to 3.5 m");
  await expect(length).toHaveValue("3.5");
  const thickness = page.getByLabel("Thickness (m)", { exact: true });
  await thickness.fill("0.3");
  await thickness.press("Tab");
  await expect(page.getByTestId("commit-count")).toHaveText("2");
  await page.getByLabel("Height (m)", { exact: true }).fill("-1");
  await page.getByLabel("Height (m)", { exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Refused");
  await expect(page.getByTestId("commit-count")).toHaveText("2");
  await expect(page.getByLabel("Height (m)", { exact: true })).toHaveValue("2.4");
  await expect(page.getByTestId("plan-history")).toHaveText("2 undo / 0 redo");
  // Arrow keys nudge a focused endpoint handle by one grid step.
  await page.getByTestId("plan-handle-end").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("commit-count")).toHaveText("3");
});

test("walls hosting openings are refused with an explicit message", async ({ page }) => {
  await openStory(page, "connected");
  await wall(page, D).click();
  await expect(page.getByText(/hosts a door or window opening/).first()).toBeVisible();
  const length = page.getByLabel("Length (m)", { exact: true });
  await length.fill("2");
  await expect(page.getByTestId("plan-refusal")).toContainText("hosts a door or window opening");
  await length.press("Enter");
  await expect(page.getByTestId("plan-refusal")).toContainText("nothing was changed");
  await expect(length).toHaveValue("3");
  await page.getByRole("button", { name: "Delete wall", exact: true }).click();
  await expect(page.getByTestId("plan-refusal")).toContainText("hosts a door or window opening");
  await expect(page.getByTestId("commit-count")).toHaveText("0");
  await expect(page.getByTestId("plan-history")).toHaveText("0 undo / 0 redo");
  await expect(wall(page, D)).toBeVisible();
});

test("draws a new wall and deletes it; refuses deleting a joined wall", async ({ page }) => {
  await openStory(page, "connected");
  await page.getByLabel("Angle snap").selectOption("0");
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(4);
  await page.getByRole("button", { name: "Draw wall", exact: true }).click();
  const svg = await page.getByRole("group", { name: /^Plan of / }).boundingBox();
  if (!svg) throw new Error("no plan");
  await page.mouse.click(svg.x + 120, svg.y + 60);
  await page.mouse.move(svg.x + 260, svg.y + 60, { steps: 3 });
  await expect(page.locator(".teldra-plan-view__wall[data-preview='true']")).toHaveCount(1);
  await page.mouse.click(svg.x + 260, svg.y + 60);
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(5);
  await expect(page.getByTestId("commit-count")).toHaveText("1");
  await page.getByRole("button", { name: "Delete wall", exact: true }).click();
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(4);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await wall(page, A).click();
  await page.getByRole("button", { name: "Delete wall", exact: true }).click();
  await expect(page.getByTestId("plan-refusal")).toBeVisible();
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(4);
});

test("draw mode Escape discards the pending wall", async ({ page }) => {
  await openStory(page, "connected");
  await page.getByRole("button", { name: "Draw wall", exact: true }).click();
  const svg = await page.getByRole("group", { name: /^Plan of / }).boundingBox();
  if (!svg) throw new Error("no plan");
  await page.mouse.click(svg.x + 120, svg.y + 60);
  await page.mouse.move(svg.x + 300, svg.y + 60, { steps: 3 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".teldra-plan-view__wall[data-preview='true']")).toHaveCount(0);
  await expect(page.getByTestId("commit-count")).toHaveText("0");
});

test("renders spaces and hosted opening outlines read-only from imported BIM", async ({ page }) => {
  await openStory(page, "golden");
  await expect(page.locator(".teldra-plan-view__space")).toHaveCount(1);
  await expect(page.locator(".teldra-plan-view__opening[data-opening-kind='door']")).toHaveCount(1);
  await expect(page.locator(".teldra-plan-view__wall")).toHaveCount(4);
  await expect(page.locator(".teldra-plan-view__wall[data-hosted='true']")).toHaveCount(1);
  await page.locator(".teldra-plan-view__space").click({ force: true, position: { x: 5, y: 5 } }).catch(() => undefined);
  await expect(page.getByTestId("commit-count")).toHaveText("0");
});

test("plan view has no accessibility violations with a selection", async ({ page }) => {
  await openStory(page, "connected");
  await wall(page, A).click();
  await page.getByRole("button", { name: "Draw wall", exact: true }).click();
  const accessibility = await new AxeBuilder({ page }).include("#storybook-root")
    .disableRules(["landmark-one-main", "page-has-heading-one"]).analyze();
  expect(accessibility.violations).toEqual([]);
  await openStory(page, "golden");
  const golden = await new AxeBuilder({ page }).include("#storybook-root")
    .disableRules(["landmark-one-main", "page-has-heading-one"]).analyze();
  expect(golden.violations).toEqual([]);
});
