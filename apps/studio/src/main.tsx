import { render } from "solid-js/web";
import { openDemoProject, openPortableProject } from "./PortableProject";
import { BrowserProjectStudio } from "./BrowserProjectStudio";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Teldra Studio root element is missing.");
}

render(() => <BrowserProjectStudio openProject={openPortableProject} openDemoProject={() => openDemoProject(`${import.meta.env.BASE_URL}demo.teldra`)} />, root);
