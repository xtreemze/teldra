// Runs tools/research/ifcopenshell_wall_experiment.py (and optionally a real IFC) inside Pyodide with
// IfcOpenShell's official WASM wheels, to measure whether the SAME Python wall/opening/regeneration code
// works in a browser-class runtime. Node is used as the host; the wheels are the browser ones.
//
// Setup (scratch dir, NOT the repo):  npm i pyodide@0.29.3
// Run:  node pyodide_wall_experiment.mjs [path/to/model.ifc]
//
// Wheel provenance: https://ifcopenshell.github.io/wasm-wheels/ (IfcOpenShell org), modular build
// 0.9.1+a963c38, tag cp313-pyemscripten_2025_0_wasm32. Pyodide 0.29.x expects the older tag
// pyodide_2025_0_wasm32, so the file name is re-tagged before micropip install (content unchanged).
import { loadPyodide } from "pyodide";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const base = "https://ifcopenshell.github.io/wasm-wheels/modular/0.9.1%2Ba963c38/";
const tag = "0.9.1%2Ba963c38-cp313-cp313-pyemscripten_2025_0_wasm32.whl";
const pure = "ifcopenshell_pure_python-0.9.1%2Ba963c38-py3-none-any.whl"; // ifcopenshell.api / express / util extras
const names = [
  "ifcopenshell", "ifcopenshell_parse_schema_ifc4", "ifcopenshell_geometry_mapping_ifc4",
  "ifcopenshell_geometry_kernel_cgal", "ifcopenshell_geometry_kernel_opencascade",
];
const cache = process.env.WHEEL_CACHE ?? "wheels";
fs.mkdirSync(cache, { recursive: true });

let t = performance.now();
const py = await loadPyodide();
const boot = performance.now() - t;
await py.loadPackage(["micropip", "numpy", "shapely", "python-dateutil", "pyparsing", "pytest"],
  { messageCallback: () => {} });
const micropip = py.pyimport("micropip");

let bytes = 0;
const staged = [];
for (const n of names) {
  const file = decodeURIComponent(`${n}-${tag}`);
  const local = path.join(cache, file);
  if (!fs.existsSync(local)) fs.writeFileSync(local, Buffer.from(await (await fetch(base + `${n}-${tag}`)).arrayBuffer()));
  const buf = fs.readFileSync(local);
  bytes += buf.length;
  const target = file.replace("pyemscripten_2025_0", "pyodide_2025_0");
  py.FS.writeFile(`/tmp/${target}`, buf);
  staged.push(`emfs:/tmp/${target}`);
}
{
  const local = path.join(cache, decodeURIComponent(pure));
  if (!fs.existsSync(local)) fs.writeFileSync(local, Buffer.from(await (await fetch(base + pure)).arrayBuffer()));
  const buf = fs.readFileSync(local);
  bytes += buf.length;
  py.FS.writeFile(`/tmp/${decodeURIComponent(pure)}`, buf);
  staged.push(`emfs:/tmp/${decodeURIComponent(pure)}`);
}
t = performance.now();
await micropip.install(staged);
const install = performance.now() - t;
t = performance.now();
const ver = await py.runPythonAsync("import ifcopenshell, ifcopenshell.geom; ifcopenshell.version");
const imp = performance.now() - t;
console.log(JSON.stringify({ pyodide: py.version, bootMs: Math.round(boot), wheelMB: +(bytes / 1e6).toFixed(1),
  installMs: Math.round(install), importMs: Math.round(imp), ifcopenshell: ver }));

const src = fs.readFileSync(path.join(here, "ifcopenshell_wall_experiment.py"), "utf8");
t = performance.now();
let result = "";
try {
result = await py.runPythonAsync(`
import runpy, io, contextlib, sys
sys.argv = ["x"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    exec(compile(${JSON.stringify(src)}, "exp.py", "exec"), {"__name__": "__main__"})
buf.getvalue()
`);
} catch (e) { console.log("EXPERIMENT_ERROR", String(e.message).split("\n").slice(-12).join("\n").slice(0, 1800)); }
console.log("EXPERIMENT_MS", Math.round(performance.now() - t));
console.log(result.trim().slice(0, 6000));

const model = process.argv[2];
if (model) {
  const data = fs.readFileSync(model);
  py.FS.writeFile("/tmp/model.ifc", data);
  t = performance.now();
  const r = await py.runPythonAsync(`
import ifcopenshell, ifcopenshell.geom, time, json
t=time.perf_counter(); f=ifcopenshell.open("/tmp/model.ifc"); o=(time.perf_counter()-t)*1000
s=ifcopenshell.geom.settings(); n=tris=0; t=time.perf_counter()
walls=f.by_type("IfcWall")  # edit-relevant subset: walls incl. their voids (full model: drop include=)
it=ifcopenshell.geom.iterator(s,f,1,include=walls)
if it.initialize():
    while True:
        g=it.get().geometry; n+=1; tris+=len(g.faces)//3
        if not it.next(): break
json.dumps({"open_ms":round(o),"iterate_ms":round((time.perf_counter()-t)*1000),"elements":n,"triangles":tris})
`);
  console.log("MODEL", model, r, "total_ms", Math.round(performance.now() - t));
}
