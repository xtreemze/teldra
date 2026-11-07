import {expect, test} from "@playwright/test";

test("mobile sheets support keyboard and touch detents without losing IFC edit state", async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto("./?demo=sample");
  await page.getByRole("button",{name:"Try demo",exact:true}).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");

  await page.getByRole("button",{name:"Scene",exact:true}).click();
  const scene = page.locator("#teldra-scene-panel");
  await expect(scene).toHaveAttribute("data-mobile-detent","half");
  await page.getByRole("button",{name:"Expand Scene sheet"}).click();
  await expect(scene).toHaveAttribute("data-mobile-detent","full");

  const grip = page.getByRole("button",{name:"Collapse Scene sheet"});
  await grip.dispatchEvent("pointerdown",{pointerId:42,pointerType:"touch",isPrimary:true,clientY:220});
  await grip.dispatchEvent("pointerup",{pointerId:42,pointerType:"touch",isPrimary:true,clientY:310});
  await expect(scene).toHaveAttribute("data-mobile-detent","half");

  const closeGrip = page.getByRole("button",{name:"Expand Scene sheet"});
  await closeGrip.dispatchEvent("pointerdown",{pointerId:43,pointerType:"touch",isPrimary:true,clientY:220});
  await closeGrip.dispatchEvent("pointerup",{pointerId:43,pointerType:"touch",isPrimary:true,clientY:310});
  await expect(scene).toBeHidden();

  await page.getByRole("button",{name:"Scene",exact:true}).click();
  const chair=page.getByRole("list",{name:"Building objects",exact:true}).getByRole("button",{name:/^Chair/});
  await chair.click();
  await page.getByRole("button",{name:"Details",exact:true}).click();
  const inspector=page.locator("#teldra-object-panel");
  await expect(inspector).toHaveAttribute("data-mobile-detent","half");
  await page.getByRole("button",{name:"Expand Inspector sheet"}).click();
  await expect(inspector).toHaveAttribute("data-mobile-detent","full");
  await page.getByRole("button",{name:"Close Inspector sheet"}).click();
  await expect(inspector).toBeHidden();

  await page.getByRole("button",{name:"Move",exact:true}).click();
  await expect(page.getByRole("group",{name:"Touch editing mode"})).toBeVisible();
  await page.getByRole("button",{name:"Numbers",exact:true}).click();
  await expect(inspector).toBeVisible();
  await page.getByRole("button",{name:"Close Inspector sheet"}).click();
  await expect(page.getByRole("group",{name:"Touch editing mode"})).toBeVisible();
  await page.getByRole("group",{name:"Touch transform actions"})
    .getByRole("button",{name:"Cancel",exact:true}).click();

  await page.getByRole("button",{name:"Scene",exact:true}).click();
  await page.keyboard.press("Escape");
  await expect(scene).toBeHidden();
  await expect(page.getByTestId("mobile-scene-trigger")).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
