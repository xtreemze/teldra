import { createSignal, onCleanup } from "solid-js";

import { mobileSheetSwipe, type MobileSheetDetent } from "./MobileSheetDetent";
export type { MobileSheetDetent } from "./MobileSheetDetent";

export interface MobileSheetHandleProps {
  readonly label: "Scene" | "Inspector";
  readonly detent: MobileSheetDetent;
  readonly onDetentChange: (detent: MobileSheetDetent) => void;
  readonly onClose: () => void;
}

/** Keyboard buttons and touch handle expose identical actions and state. */
export function MobileSheetHandle(props: MobileSheetHandleProps) {
  let start: {id: number; y: number} | null = null;
  let ignoreClickUntil = 0;
  const [dragging, setDragging] = createSignal(false);

  const down = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    if (!event.isPrimary || start) { start = null; setDragging(false); return; }
    start = {id: event.pointerId, y: event.clientY};
    setDragging(true);
    try { (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId); }
    catch { /* Pointer simulation and capture restrictions do not affect buttons. */ }
  };
  const up = (event: PointerEvent) => {
    if (!start || start.id !== event.pointerId) return;
    const action = mobileSheetSwipe(props.detent, event.clientY - start.y);
    start = null;
    setDragging(false);
    if (action) {
      ignoreClickUntil = performance.now() + 400;
      event.preventDefault();
      if (action === "close") props.onClose();
      else props.onDetentChange(action);
    }
  };
  const cancel = () => { start = null; setDragging(false); };
  onCleanup(cancel);
  return (
    <div class="teldra-mobile-sheet-handle" role="group" aria-label={props.label + " sheet controls"}>
      <button type="button" class="teldra-mobile-sheet-handle__grip"
        aria-label={(props.detent === "half" ? "Expand " : "Collapse ") + props.label + " sheet"}
        aria-expanded={props.detent === "full"} data-dragging={dragging()}
        onPointerDown={down} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onClick={() => {
          if (performance.now() < ignoreClickUntil) return;
          props.onDetentChange(props.detent === "half" ? "full" : "half");
        }}>
        <span class="teldra-mobile-sheet-handle__indicator" aria-hidden="true"/>
        <span>{props.detent === "half" ? "Expand" : "Collapse"}</span>
      </button>
      <button type="button" class="teldra-mobile-sheet-handle__close"
        aria-label={"Close " + props.label + " sheet"} onClick={props.onClose}>Close</button>
    </div>
  );
}
