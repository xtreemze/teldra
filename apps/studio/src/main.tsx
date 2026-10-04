import { render } from "solid-js/web";
import { BrowserProjectStudio } from "./BrowserProjectStudio";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Teldra Studio root element is missing.");
}

render(() => <BrowserProjectStudio />, root);
