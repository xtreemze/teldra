import {expect,test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("Pages demo edits IFC furniture, saves atomically, and reopens with the same pose",async({page},testInfo)=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("./?demo=sample");await page.getByRole("button",{name:"Try demo",exact:true}).click();
 await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 const chair=()=>page.getByRole("list",{name:"Building objects",exact:true}).getByRole("button",{name:/^Chair/});
 await chair().click();await page.getByRole("group",{name:"Start IFC furniture transform"}).getByRole("button",{name:"Move",exact:true}).click();
 await expect(page.getByRole("group",{name:"Furniture manipulation mode"}).getByRole("button",{name:"Move"})).toHaveAttribute("aria-pressed","true");
 await page.getByRole("group",{name:"Furniture manipulation mode"}).getByRole("button",{name:"Rotate"}).click();
 await expect(page.getByRole("group",{name:"Furniture manipulation mode"}).getByRole("button",{name:"Rotate"})).toHaveAttribute("aria-pressed","true");
 await page.getByRole("group",{name:"Furniture manipulation mode"}).getByRole("button",{name:"Move"}).click();
 const x=page.getByLabel("Position X (m)",{exact:true});await expect(x).toHaveValue("1");
 await page.getByLabel("Position snap (m, 0 off)",{exact:true}).fill("0.25");await x.fill("1.76");await page.getByLabel("Rotation (degrees)",{exact:true}).fill("45");
 await page.getByRole("button",{name:"Apply placement",exact:true}).click();
 await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"Undo",exact:true}).click();
 await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeDisabled();
 await page.getByRole("button",{name:"Redo",exact:true}).click();
 const pending=page.waitForEvent("download");await page.getByRole("button",{name:"Save project",exact:true}).click();
 const download=await pending;const path=testInfo.outputPath("edited-demo.teldra");await download.saveAs(path);
 await page.addInitScript(()=>Object.defineProperty(window,"showOpenFilePicker",{value:undefined,configurable:true}));
 await page.reload();const picker=page.waitForEvent("filechooser");await page.getByRole("button",{name:"Open .teldra",exact:true}).click();
 await(await picker).setFiles(path);await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 await chair().click();await page.getByRole("button",{name:"Edit placement",exact:true}).click();
 await expect(x).toHaveValue("1.75");expect(Number(await page.getByLabel("Rotation (degrees)",{exact:true}).inputValue())).toBeCloseTo(45);
 await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Edit placement",exact:true})).toBeVisible();
 expect(errors).toEqual([]);
 const a11y=await new AxeBuilder({page}).analyze();expect(a11y.violations).toEqual([]);
});

test("Pages routes and compact onboarding remain usable without direct file access",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.addInitScript(()=>Object.defineProperty(window,"showOpenFilePicker",{value:undefined,configurable:true}));
 await page.goto("./?demo=sample");await expect(page.getByRole("button",{name:"Open .teldra",exact:true})).toBeEnabled();
 await page.getByRole("button",{name:"Try demo",exact:true}).click();await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 await expect(page.getByText("Save downloads a copy",{exact:true})).toBeHidden();
 await page.getByRole("button",{name:"Project",exact:true}).click();
 await expect(page.getByRole("group",{name:"Mobile project menu"}).getByText("Saving downloads a project copy; it does not overwrite the opened file.",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Project",exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 const a11y=await new AxeBuilder({page}).analyze();expect(a11y.violations).toEqual([]);
});

test("Blender G/R modal keys create canonical IFC edits; S cannot apply a mesh-only scale", async ({page}) => {
 await page.goto("./?demo=sample");
 await page.getByRole("button",{name:"Try demo",exact:true}).click();
 await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 await page.getByRole("list",{name:"Building objects",exact:true}).getByRole("button",{name:/^Chair/}).click();
 const canvas=page.getByTestId("twin-canvas");
 await canvas.focus();
 await page.keyboard.press("g");
 await page.keyboard.press("x");
 await page.keyboard.type("0.75");
 await expect(page.getByLabel("Position X (m)",{exact:true})).toHaveValue("1.75");
 await page.keyboard.press("Enter");
 await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeEnabled();
 await canvas.focus();
 await page.keyboard.press("r");
 await page.keyboard.press("x");
 await expect(page.getByTestId("transform-shortcut-status")).toContainText("world Z");
 await page.keyboard.press("z");
 await page.keyboard.type("45");
 await expect(page.getByLabel("Rotation (degrees)",{exact:true})).toHaveValue("45");
 await page.keyboard.press("Enter");
 await canvas.focus();
 await page.keyboard.press("s");
 await expect(page.getByTestId("transform-shortcut-status")).toContainText("not available");
 await page.keyboard.press("ControlOrMeta+z");
 await page.keyboard.press("ControlOrMeta+z");
 await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeDisabled();
 await page.keyboard.press("g");
 await page.keyboard.press("z");
 await page.keyboard.press("1");
 await page.keyboard.press("Escape");
 await expect(page.getByTestId("transform-shortcut-status")).toContainText("cancelled");
 await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeDisabled();
});

test("CAD wall draft previews dimensions and exports an intent without mutating the canonical project", async ({page}) => {
  await page.goto("./?demo=sample");
  await page.getByRole("button", {name:"Try demo",exact:true}).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByRole("button",{name:"Wall draft (2D)"}).click();
  const panel = page.getByRole("region",{name:"Wall plan draft"});
  await expect(panel).toBeVisible();
  await panel.getByLabel("Start X (m)").fill("0");
  await panel.getByLabel("End X (m)").fill("4");
  await expect(panel.getByText("Length: 4.000 m")).toBeVisible();
  await expect(panel.getByRole("button",{name:"Apply to IFC (not yet supported)"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeDisabled();
  const pending = page.waitForEvent("download");
  await panel.getByRole("button",{name:"Export wall draft JSON"}).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("teldra-wall-draft.json");
  await expect(page.getByRole("button",{name:"Save project",exact:true})).toBeDisabled();
});

test("human review accepts a proposal into an isolated draft without IFC mutation", async ({page}) => {
  await page.goto("./?demo=sample");
  await page.getByRole("button", {name:"Try demo",exact:true}).click();
  await expect(page.getByTestId("viewport-status")).toHaveText("ready");
  await page.getByRole("button", {name:"Wall draft (2D)"}).click();
  const panel = page.getByRole("region", {name:"Wall plan draft"});
  const review = panel.getByText("Review imported or agent-proposed wall draft");
  await review.click();
  const input = panel.getByRole("textbox", {name:"Wall draft JSON proposal"});
  const proposal = JSON.stringify({
    format:"teldra-wall-draft-v1",operation:"CreateWall",coordinateFrame:"ifc-world-metres-z-up",
    wall:{start:[1,2],end:[5,2],thicknessMetres:0.2,heightMetres:2.8}
  });
  await input.fill(proposal);
  await panel.getByRole("button", {name:"Preview proposal"}).click();
  await expect(panel.getByTestId("wall-proposal-footprint")).toBeVisible();
  await expect(panel.getByRole("status", {name:"Proposed wall dimensions"})).toContainText("4.000 m");
  await expect(page.getByRole("button", {name:"Save project",exact:true})).toBeDisabled();
  await panel.getByRole("button", {name:"Reject proposal"}).click();
  await expect(panel.getByTestId("wall-proposal-footprint")).toHaveCount(0);
  await input.fill(proposal);
  await panel.getByRole("button", {name:"Preview proposal"}).click();
  await panel.getByRole("button", {name:"Accept into draft"}).click();
  await expect(panel.getByText("Length: 4.000 m")).toBeVisible();
  await expect(panel.getByLabel("Start X (m)")).toHaveValue("1");
  await expect(panel.getByLabel("End X (m)")).toHaveValue("5");
  await expect(page.getByRole("button", {name:"Save project",exact:true})).toBeDisabled();
});
