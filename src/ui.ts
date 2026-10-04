// Plain DOM rendering. Usernames are arbitrary strings typed by other people,
// so text only ever reaches the page through textContent, never innerHTML.

import { encode } from "uqr";
import type { PeerStatus } from "./peer";
import type { PeerInfo, QuizEvent } from "./protocol";
import type { Session } from "./storage";

/** The state derived by the Rust/WASM engine (see QuizState in wasm/src/lib.rs). */
export interface QuizState {
  quizId: string;
  createdAt: string | null;
  phase: "LOBBY" | "QUESTION" | "SCOREBOARD";
  question: { id: string; text: string; options: { key: string; label: string }[] };
  participants: PeerInfo[];
  answers: (PeerInfo & { answer: string | null })[];
  scores: (PeerInfo & { rank: number; answer: string | null; answerLabel: string | null; score: number })[];
  lamport: number;
  eventCount: number;
}

export interface View {
  session: Session;
  state: QuizState;
  peers: PeerStatus[];
  /** Invites of this tab that are still waiting for their response. */
  openInvites: string[];
  relayedSignals: number;
  events: QuizEvent[];
}

/** A response link waiting to be opened by the node that sent the invite. */
export interface PendingResponse {
  link: string;
  inviter: PeerInfo;
}

/** The invite link this tab was opened with. */
export interface Invitation {
  code: string;
  inviter: string;
  quizId: string;
}

/** This tab was opened from a response link and hands it over to the quiz tab. */
export interface Handoff {
  state: "sending" | "delivered" | "failed";
  link: string;
  problem?: string | null;
}

export interface Actions {
  view(): View | null;
  createQuiz(username: string): void;
  joinQuiz(username: string, invitation: string): Promise<PendingResponse>;
  rejoinQuiz(invitation: string): Promise<PendingResponse>;
  invite(): Promise<{ inviteId: string; link: string }>;
  connect(response: string): Promise<void>;
  start(): void;
  answer(key: string): void;
  showScoreboard(): void;
}

let actions: Actions | null = null;

// Local UI state. It is not part of the quiz and is never replicated.
let invitation: Invitation | null = null;
let pendingResponse: PendingResponse | null = null;
let invite: { inviteId: string; link: string } | null = null;
let handoff: Handoff | null = null;
const expandedRows = new Set<string>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => $<HTMLInputElement | HTMLTextAreaElement>(id);

export function bindUi(a: Actions, rememberedUsername: string): void {
  actions = a;
  field("username").value = rememberedUsername;
  const creatingResponse = "CREATING RESPONSE…";
  onClick("create", () => a.createQuiz(username()));
  onClick(
    "join",
    async () => {
      pendingResponse = await a.joinQuiz(username(), invitation?.code ?? field("invite-code").value);
      invitation = null;
    },
    creatingResponse,
  );
  onClick(
    "rejoin",
    async () => {
      pendingResponse = await a.rejoinQuiz(field("rejoin-code").value);
      field("rejoin-code").value = "";
    },
    creatingResponse,
  );
  onClick(
    "invite",
    async () => {
      invite = await a.invite();
      field("response-input").value = "";
    },
    "CREATING INVITE…",
  );
  onClick("connect", async () => {
    await a.connect(field("response-input").value);
    field("response-input").value = "";
  });
  onClick("start-question", () => a.start());
  onClick("show-scoreboard", () => a.showScoreboard());
  for (const kind of ["invite", "response", "handoff"]) {
    onClick(`copy-${kind}`, () => copy(`${kind}-link`, `copy-${kind}`));
    onClick(`share-${kind}`, () => share(field(`${kind}-link`).value));
    $(`share-${kind}`).hidden = typeof navigator.share !== "function";
  }
}

/** This tab was opened with an invite link: joining only needs a name and one click. */
export function showInvitation(next: Invitation): void {
  invitation = next;
}

/** A reloaded node was given a new invite link to link up again. */
export function prefillRejoin(code: string): void {
  field("rejoin-code").value = code;
}

export function showHandoff(next: Handoff): void {
  handoff = next;
  renderUi();
}

export function renderUi(): void {
  const view = actions?.view() ?? null;
  // A response disappears as soon as the inviting node has used it, an invite once it is answered.
  const inviter = pendingResponse?.inviter.nodeId;
  if (view?.peers.some((p) => p.nodeId === inviter && p.state === "OPEN")) pendingResponse = null;
  if (invite && !view?.openInvites.includes(invite.inviteId)) invite = null;

  const screen = handoff ? "handoff" : !view ? "start" : view.state.createdAt ? "quiz" : "joining";
  $("start").hidden = screen !== "start";
  $("handoff").hidden = screen !== "handoff";
  $("quiz").hidden = screen !== "quiz";
  $("syncing").hidden = screen !== "joining" || pendingResponse !== null;
  $("response").hidden = pendingResponse === null;

  $("invited").hidden = invitation === null;
  $("create-section").hidden = invitation !== null;
  if (invitation) {
    const quiz = el("code", invitation.quizId.slice(0, 12));
    const by = el("strong", invitation.inviter);
    $("invited").replaceChildren("Invited by ", by, " to quiz ", quiz, ". Enter your name and press JOIN QUIZ.");
  }
  if (pendingResponse) {
    showLink("response", pendingResponse.link);
    $("response-to").textContent = pendingResponse.inviter.username;
  }
  if (handoff) {
    showLink("handoff", handoff.link);
    $("handoff-status").textContent = {
      sending: "Handing the response over to your quiz tab…",
      delivered: "Done: your quiz tab is connecting now. You can close this tab.",
      failed: `${handoff.problem} Open the link in the browser where your quiz is running, or copy it and paste it under “Response” in your quiz tab.`,
    }[handoff.state];
    $("handoff-copy").hidden = handoff.state !== "failed";
  }
  if (view && screen === "quiz") renderQuiz(view);
  renderDebug(view);
}

function renderQuiz({ session, state, peers }: View): void {
  $("quiz-id").textContent = state.quizId.slice(0, 12);
  $("quiz-id").title = state.quizId;
  $("me").textContent = session.username;
  $("question").hidden = state.phase !== "QUESTION";
  $("scoreboard").hidden = state.phase !== "SCOREBOARD";
  $("start-question").hidden = state.phase !== "LOBBY";

  const answered = state.answers.some((a) => a.nodeId === session.nodeId);
  $("question-text").textContent = state.question.text;
  update("options", [answered], () =>
    state.question.options.map((option) => {
      const button = el("button", option.label);
      button.disabled = answered;
      button.addEventListener("click", () => attempt(() => actions?.answer(option.key)));
      return button;
    }),
  );
  $("answer-status").textContent = answered ? "Answer submitted." : "";
  $("answer-count").textContent = `Answers received: ${state.answers.length} / ${state.participants.length}`;

  update("scores", [state.scores, [...expandedRows]], () =>
    state.scores.map((row) => {
      const expanded = expandedRows.has(row.nodeId);
      const button = el("button", el("span", `${row.rank}. ${row.username}`), el("span", String(row.score)));
      button.className = "score-row";
      button.setAttribute("aria-expanded", String(expanded));
      button.addEventListener("click", () => {
        if (!expandedRows.delete(row.nodeId)) expandedRows.add(row.nodeId);
        renderUi();
      });
      const item = el("li", button);
      if (expanded) {
        const answer = row.answerLabel ?? "(no answer)";
        const details = el(
          "div",
          el("div", `Username: ${row.username}`),
          el("div", `Answer: ${answer}`),
          el("div", `Score: ${row.score}`),
        );
        details.className = "details";
        item.append(details);
      }
      return item;
    }),
  );

  const linkState = new Map(peers.map((p) => [p.nodeId, p.state]));
  const participants = state.participants.map((p) => {
    const status = p.nodeId === session.nodeId ? "you" : describeLink(linkState.get(p.nodeId));
    return { name: p.username, status };
  });
  update("participants", participants, () =>
    participants.map(({ name, status }) => el("li", el("span", name), el("span", status))),
  );

  $("invite-panel").hidden = invite === null;
  if (invite) showLink("invite", invite.link);
  // No open link, but other participants exist: typically right after a reload.
  const linked = peers.some((p) => p.state === "OPEN");
  $("rejoin-panel").hidden = linked || state.participants.length < 2 || pendingResponse !== null;
}

function describeLink(state: string | undefined): string {
  if (state === "OPEN") return "connected";
  if (state === "CONNECTING") return "connecting…";
  return "not connected";
}

function renderDebug(view: View | null): void {
  if (!view) {
    $("debug-output").textContent = "Not in a quiz yet.";
    return;
  }
  const { session, state, peers, relayedSignals, events } = view;
  $("debug-output").textContent = [
    `Node:     ${session.nodeId}`,
    `Username: ${session.username}`,
    `Quiz:     ${state.quizId}`,
    `Lamport:  ${state.lamport}`,
    `Events:   ${state.eventCount}`,
    `Open DataChannels: ${peers.filter((p) => p.state === "OPEN").length}`,
    `Relayed signals:   ${relayedSignals}`,
    "",
    "Peers:",
    ...(peers.length > 0 ? peers.map((p) => `  ${p.username}  ${p.state}`) : ["  (none)"]),
    "",
    "Event log (lamport, username, type):",
    ...events.map((e) => `  ${e.lamport}  ${e.username}  ${e.type}`),
  ].join("\n");
}

// --- Links and QR codes ----------------------------------------------------

/** Show a link as text and as a QR code (in the elements "<prefix>-link" and "<prefix>-qr"). */
function showLink(prefix: string, link: string): void {
  setValue(`${prefix}-link`, link);
  update(`${prefix}-qr`, link, () => [qrCode(link)]);
}

/** A QR code as SVG, one path with a rectangle per run of dark modules. */
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

async function copy(fieldId: string, buttonId: string): Promise<void> {
  const text = field(fieldId);
  text.select();
  try {
    await navigator.clipboard.writeText(text.value);
  } catch {
    throw new Error("Could not copy automatically. The link is selected: press Ctrl+C (or ⌘+C).");
  }
  const button = $(buttonId);
  const label = button.textContent;
  button.textContent = "COPIED";
  setTimeout(() => (button.textContent = label), 1500);
}

/** The phone's or computer's own share sheet, e.g. straight into the class chat. */
async function share(url: string): Promise<void> {
  try {
    await navigator.share({ title: "P2P Quiz Wasm", url });
  } catch (error) {
    if ((error as Error).name !== "AbortError") throw error; // closing the share sheet is fine
  }
}

// --- Helpers ---------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.append(...children);
  return element;
}

/** Rebuild a list only when its data changed, so a click is never lost to a re-render. */
const lastRendered = new Map<string, string>();
function update(id: string, data: unknown, build: () => Node[]): void {
  const key = JSON.stringify(data);
  if (lastRendered.get(id) === key) return;
  lastRendered.set(id, key);
  $(id).replaceChildren(...build());
}

/** Only touch a field when its text changes, so a selection made for copying survives. */
function setValue(id: string, value: string): void {
  if (field(id).value !== value) field(id).value = value;
}

function username(): string {
  const name = field("username").value.trim();
  if (!name) throw new Error("Username is required.");
  return name;
}

/** Run a click handler; slow ones (ICE gathering takes a moment) show a busy label meanwhile. */
function onClick(id: string, handler: () => unknown, busyLabel?: string): void {
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

/** Run an action, show its error (if any) and re-render. */
export async function attempt(handler: () => unknown): Promise<void> {
  showError("");
  try {
    await handler();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
  renderUi();
}

function showError(message: string): void {
  $("error").textContent = message;
  $("error").hidden = !message;
}
