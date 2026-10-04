// Small DOM helpers shared by the views. Usernames are arbitrary strings typed by
// other people, so text only ever reaches the page through textContent, never innerHTML.

import { encode } from "uqr";

let rerender = () => {};

/** The function that redraws the page after an action. */
export function setRenderer(render: () => void): void {
  rerender = render;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const field = (id: string) => $<HTMLInputElement | HTMLTextAreaElement>(id);

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.append(...children);
  return element;
}

/** Quiz text, where *words in stars* are in italics (as on the cyber-quizzer pages). */
export function rich(text: string): Node[] {
  return text
    .split(/(\*[^*]+\*)/g)
    .filter((part) => part !== "")
    .map((part) => (/^\*[^*]+\*$/.test(part) ? el("em", part.slice(1, -1)) : document.createTextNode(part)));
}

/** Rebuild an element's children only when their data changed, so a click is never lost to a re-render. */
const lastRendered = new Map<string, string>();
export function update(id: string, data: unknown, build: () => Node[]): void {
  const key = JSON.stringify(data);
  if (lastRendered.get(id) === key) return;
  lastRendered.set(id, key);
  $(id).replaceChildren(...build());
}

/** Only touch a field when its text changes, so a selection made for copying survives. */
export function setValue(id: string, value: string): void {
  if (field(id).value !== value) field(id).value = value;
}

/** Run a click handler; slow ones (ICE gathering takes a moment) show a busy label meanwhile. */
export function onClick(id: string, handler: () => unknown, busyLabel?: string): void {
  const button = $<HTMLButtonElement>(id);
  const label = button.textContent;
  button.addEventListener("click", async () => {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
    await attempt(handler);
    button.disabled = false;
    if (busyLabel) button.textContent = label;
  });
}

/** Run an action, show its error (if any) and redraw. */
export async function attempt(handler: () => unknown): Promise<void> {
  showError("");
  try {
    await handler();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
  rerender();
}

export function showError(message: string): void {
  $("error").textContent = message ? `⚠️ ${message}` : "";
  $("error").hidden = !message;
}

/** Show a link as text and as a QR code (in the elements "<prefix>-link" and "<prefix>-qr"). */
export function showLink(prefix: string, link: string): void {
  setValue(`${prefix}-link`, link);
  update(`${prefix}-qr`, link, () => [qrCode(link)]);
}

/** A QR code as SVG: one path with a rectangle per run of dark modules. */
function qrCode(text: string): SVGSVGElement {
  const { data, size } = encode(text, { ecc: "L", border: 4 });
  let path = "";
  data.forEach((row, y) => {
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue;
      const start = x;
      while (row[x + 1]) x++;
      path += `M${start} ${y}h${x - start + 1}v1H${start}z`;
    }
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code of the link");
  const modules = document.createElementNS("http://www.w3.org/2000/svg", "path");
  modules.setAttribute("d", path);
  svg.append(modules);
  return svg;
}

export async function copyField(fieldId: string, buttonId: string): Promise<void> {
  const text = field(fieldId);
  text.select();
  try {
    await navigator.clipboard.writeText(text.value);
  } catch {
    throw new Error("Could not copy automatically. The link is selected: press Ctrl+C (or ⌘+C).");
  }
  const button = $(buttonId);
  const label = button.textContent;
  button.textContent = "✅ COPIED";
  setTimeout(() => (button.textContent = label), 1500);
}

/** The phone's or computer's own share sheet, e.g. straight into the class chat. */
export async function share(url: string): Promise<void> {
  try {
    await navigator.share({ title: "P2P Quiz Wasm", url });
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error; // closing the share sheet is fine
  }
}

/** Share buttons only where the browser has a share sheet. */
export function hideShareIfUnsupported(...ids: string[]): void {
  for (const id of ids) $(id).hidden = typeof navigator.share !== "function";
}
