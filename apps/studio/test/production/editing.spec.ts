import {expect,test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("Pages demo edits IFC furniture, saves atomically, and reopens with the same pose",async({page},testInfo)=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 await page.goto("./?demo=sample");await page.getByRole("button",{name:"Try demo",exact:true}).click();
 await expect(page.getByTestId("viewport-status")).toHaveText("ready");
 const chair=()=>page.getByRole("list",{name:"Building objects",exact:true}).getByRole("button",{name:/^Chair/});
 await chair().click();await page.getByRole("button",{name:"Edit transform",exact:true}).click();
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
 await expect(page.getByText("Save downloads a copy",{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 const a11y=await new AxeBuilder({page}).analyze();expect(a11y.violations).toEqual([]);
});
