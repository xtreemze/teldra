import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Storybook's a11y addon runs axe on render; retry if our run collides with it.
async function axeViolations(page: Page) {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await new AxeBuilder({page}).include("#storybook-root").analyze()).violations;
    } catch (error) {
      if (attempt >= 10 || !String(error).includes("Axe is already running")) throw error;
      await page.waitForTimeout(200);
    }
  }
}

const story = (id: string) => `/iframe.html?id=studio-transformtoolbar--${id}&viewMode=story`;

test("idle toolbar exposes Move, Rotate and Scale with no active mode", async ({page}) => {
  await page.goto(story("idle"));
  const tools = page.getByRole("toolbar", {name: "Transform tools"});
  for (const name of ["Move", "Rotate", "Scale"]) {
    await expect(tools.getByRole("button", {name, exact: true})).toBeEnabled();
    await expect(tools.getByRole("button", {name, exact: true})).toHaveAttribute("aria-pressed", "false");
  }
  expect(await axeViolations(page)).toEqual([]);
});

test("active mode is announced via aria-pressed and unsupported scale is disabled with its reason", async ({page}) => {
  await page.goto(story("move-active"));
  await expect(page.getByRole("button", {name: "Move", exact: true})).toHaveAttribute("aria-pressed", "true");
  await page.goto(story("scale-unsupported"));
  const scale = page.getByRole("button", {name: "Scale", exact: true});
  await expect(scale).toBeDisabled();
  await expect(scale).toHaveAttribute("title", /cannot be scaled safely/);
});

test("unsupported selection disables every tool and states reason and workaround", async ({page}) => {
  await page.goto(story("unsupported-wall"));
  for (const name of ["Move", "Rotate", "Scale"]) await expect(page.getByRole("button", {name, exact: true})).toBeDisabled();
  const why = page.getByTestId("transform-unavailable-reason");
  await expect(why).toContainText("not yet supported");
  await expect(why).toContainText("Workaround");
  expect(await axeViolations(page)).toEqual([]);
});
