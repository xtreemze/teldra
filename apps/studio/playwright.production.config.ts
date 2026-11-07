import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:"./test/production",timeout:90000,workers:2,
  use:{baseURL:"http://127.0.0.1:4174/teldra/studio/",browserName:"chromium",viewport:{width:1440,height:1000}},
  webServer:{command:"node ../../tools/site/serve-pages.mjs 4174",port:4174,reuseExistingServer:false},
});
