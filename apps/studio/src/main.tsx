import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { openDemoProject, openPortableProject } from "./PortableProject";
import { BrowserProjectStudio } from "./BrowserProjectStudio";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Teldra Studio root element is missing.");
}

const sample = new URLSearchParams(location.search).get("demo") === "sample";
const [downloadProgress, setDownloadProgress] = createSignal("");
render(() => <BrowserProjectStudio openProject={openPortableProject}
  autoOpenDemo={!sample} downloadProgress={downloadProgress()}
  openDemoProject={() => openDemoProject(`${import.meta.env.BASE_URL}${sample ? "demo.teldra" : "21D.teldra"}`, {
    fileName: sample ? "teldra-demo.teldra" : "21D - Sweet Home 3D.teldra",
    onProgress: (loaded, total) => setDownloadProgress(total > 0 ? `Downloading 21D home: ${Math.min(100,Math.round(loaded/total*100))}%` : `Downloading 21D home: ${(loaded/1048576).toFixed(1)} MB`),
  })} />, root);
