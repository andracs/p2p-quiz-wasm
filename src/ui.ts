// Plain DOM rendering. Usernames are arbitrary strings typed by other people,
// so text only ever reaches the page through textContent, never innerHTML.

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
  relayedSignals: number;
  events: QuizEvent[];
}

/** A response code waiting to be pasted by the node that sent the invite. */
export interface PendingResponse {
  code: string;
  inviter: PeerInfo;
}

export interface Actions {
  view(): View | null;
  createQuiz(username: string): void;
  joinQuiz(username: string, inviteCode: string): Promise<PendingResponse>;
  rejoinQuiz(inviteCode: string): Promise<PendingResponse>;
  invite(): Promise<string>;
  connect(responseCode: string): Promise<void>;
  start(): void;
  answer(key: string): void;
  showScoreboard(): void;
}

let actions: Actions | null = null;

// Local UI state. It is not part of the quiz and is never replicated.
let pendingResponse: PendingResponse | null = null;
let inviteCode: string | null = null;
const expandedRows = new Set<string>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => $<HTMLInputElement | HTMLTextAreaElement>(id);

export function bindUi(a: Actions): void {
  actions = a;
  const creatingResponse = "CREATING RESPONSE CODE…";
  onClick("create", () => a.createQuiz(username()));
  onClick(
    "join",
    async () => {
      pendingResponse = await a.joinQuiz(username(), field("invite-code").value);
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
      inviteCode = await a.invite();
      field("response-input").value = "";
    },
    "CREATING INVITE CODE…",
  );
  onClick("connect", async () => {
    await a.connect(field("response-input").value);
    inviteCode = null;
  });
  onClick("start-question", () => a.start());
  onClick("show-scoreboard", () => a.showScoreboard());
  onClick("copy-invite", () => copy("invite-output", "copy-invite"));
  onClick("copy-response", () => copy("response-output", "copy-response"));
}

export function renderUi(): void {
  const view = actions?.view() ?? null;
  // A response code disappears as soon as the inviting node has used it.
  const inviter = pendingResponse?.inviter.nodeId;
  if (view?.peers.some((p) => p.nodeId === inviter && p.state === "OPEN")) pendingResponse = null;

  const screen = !view ? "start" : view.state.createdAt ? "quiz" : "joining";
  $("start").hidden = screen !== "start";
  $("quiz").hidden = screen !== "quiz";
  $("syncing").hidden = screen !== "joining" || pendingResponse !== null;
  $("response").hidden = pendingResponse === null;
  if (pendingResponse) {
    setValue("response-output", pendingResponse.code);
    $("response-to").textContent = pendingResponse.inviter.username;
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

  $("invite-panel").hidden = inviteCode === null;
  setValue("invite-output", inviteCode ?? "");
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

async function attempt(handler: () => unknown): Promise<void> {
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

async function copy(fieldId: string, buttonId: string): Promise<void> {
  const text = field(fieldId);
  text.select();
  try {
    await navigator.clipboard.writeText(text.value);
  } catch {
    throw new Error("Could not copy automatically. The code is selected: press Ctrl+C (or ⌘+C).");
  }
  const button = $(buttonId);
  button.textContent = "COPIED";
  setTimeout(() => (button.textContent = "COPY"), 1500);
}
