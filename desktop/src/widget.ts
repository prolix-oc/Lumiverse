import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const currentWindow = getCurrentWindow();
const dragHandle = document.querySelector<HTMLElement>("#drag-handle")!;
const closeButton = document.querySelector<HTMLButtonElement>("#close")!;
const clickThroughButton = document.querySelector<HTMLButtonElement>("#click-through")!;

dragHandle.addEventListener("mousedown", (event) => {
  if (event.button === 0 && !(event.target instanceof Element && event.target.closest("button"))) {
    void currentWindow.startDragging();
  }
});

for (const handle of document.querySelectorAll<HTMLButtonElement>("[data-direction]")) {
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void currentWindow.startResizeDragging(handle.dataset.direction as ResizeDirection);
  });
}

closeButton.addEventListener("click", () => {
  void invoke("hide_widget_poc");
});

clickThroughButton.addEventListener("click", () => {
  // A click-through native window cannot receive the next click to turn this
  // off, so the tray command deliberately owns restoration for this POC.
  void invoke("set_widget_poc_click_through", { enabled: true });
});
