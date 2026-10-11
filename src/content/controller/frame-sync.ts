// Frames used to relay commands and state to each other with
// window.postMessage(..., "*"). Page scripts can forge those messages, so an
// embedding page could make a frame translate with any configured (paid)
// service and read the results from a same-origin frame. Commands now arrive
// from the background via tabs.sendMessage to every frame, and every frame
// reports its own state to the background, which merges them per tab.

export function frameHasEnoughText(doc: Document, minimum = 50): boolean {
  const length = (doc.body?.textContent ?? "")
    .replace(/\s+/g, " ")
    .trim().length;
  return length >= Math.max(0, minimum);
}
