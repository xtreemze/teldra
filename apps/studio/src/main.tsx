import { render } from "solid-js/web";
import { StudioApp } from "./StudioApp";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Teldra Studio root element is missing.");
}

render(() => <StudioApp />, root);
