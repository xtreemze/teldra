import {defineConfig} from "@playwright/test";
// The real 21D project (64 MB IFC, 61 MB GLB) is edited by web-ifc on the main thread. CI evidence (run 44646421213,
// 2-vCPU runner, shared with another worker): open 14 s, duplicate 27 s, delete/undo/redo 125 s, save 30 s,
// reopen 124 s = 363 s of phases, which exceeded 420 s with the remaining steps. Running it alone avoids CPU contention
// with the other production specs; assertions and timings are unchanged.
export default defineConfig({testDir:"./test/production",testMatch:/furniture-lifecycle-21d/,timeout:900000,workers:1,
  use:{baseURL:"http://127.0.0.1:4175/teldra/studio/",browserName:"chromium",viewport:{width:1440,height:1000}},
  webServer:{command:"node ../../tools/site/serve-pages.mjs 4175",port:4175,reuseExistingServer:false},
});
