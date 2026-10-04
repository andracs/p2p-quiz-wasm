// The page around the two halves of the quiz: the start screen, joining, the header
// with the quiz name and the 🎮 Play / 🛠️ Manage tabs, and the debug panel.
// play.ts and manage.ts draw the two halves.

import { quizTitle, quizzes } from "./catalog";
import { $, copyField, el, field, hideShareIfUnsupported, onClick, setRenderer, share, showLink } from "./dom";
import { bindManage, renderManage } from "./manage";
import type { PeerStatus } from "./peer";
import { bindPlay, renderPlay } from "./play";
import type { PeerInfo, QuizEvent } from "./protocol";
import type { Room } from "./relay";
import type { Session } from "./storage";

/** A question to answer (see wasm/src/play.rs). */
export interface QuestionView {
  /** What the answer refers to: the position of the question in the quiz. */
  index: number;
  number: number;
  section: string | null;
  emoji: string | null;
  text: string;
  kind: "choice" | "truefalse" | "order" | "estimate";
  /** Choice: the options. Order: the items, shuffled. `id` is what the answer carries. */
  options: { id: number; label: string }[];
  estimate: { min: number; max: number; step: number; start: number; unit: string; year: boolean } | null;
}

/** One answered question, with the right answer and the explanation. */
export interface ResultView {
  index: number;
  number: number;
  section: string | null;
  emoji: string | null;
  title: string;
  text: string;
  kind: QuestionView["kind"];
  correct: boolean;
  answer: string;
  rightAnswer: string;
  detail: string | null;
  explanation: string | null;
}

export interface ScoreRow extends PeerInfo {
  rank: number;
  answered: number;
  finished: boolean;
  score: number;
  /** One mark per question: ✅ right, ❌ wrong, ➖ not answered. */
  marks: string;
}

/** The state derived by the Rust/WASM engine (see wasm/src/lib.rs). */
export interface QuizState {
  quiz: {
    quizId: string;
    name: string;
    createdAt: string | null;
    relay: Room | null;
    round: number;
    status: "OPEN" | "FINISHED";
    changedBy: string | null;
    participants: PeerInfo[];
    /** The quiz of the current round. */
    title: string | null;
    emoji: string | null;
    subject: string | null;
    contentId: string | null;
    questionCount: number;
  };
  manage: {
    players: ScoreRow[];
    answerCount: number;
    questions: { number: number; emoji: string | null; title: string; answered: number; correct: number }[];
  };
  play: {
    answered: number;
    finished: boolean;
    question: QuestionView | null;
    score: number;
    results: ResultView[];
    leaderboard: ScoreRow[];
  };
  lamport: number;
  eventCount: number;
}

export interface View {
  session: Session;
  state: QuizState;
  peers: PeerStatus[];
  /** Manual invites of this tab that still wait for their response. */
  openInvites: string[];
  relayedSignals: number;
  /** The whole event log, for the debug panel. */
  events(): QuizEvent[];
  /** The one-click join link, or null when the relay is off. */
  joinLink: string | null;
  /** For the debug panel: whether this node keeps the relay door. */
  door: string;
  /** Knocking on the relay to link up again. */
  reconnecting: boolean;
}

/** A manual response link waiting to be opened by the node that sent the invite. */
export interface PendingResponse {
  link: string;
  inviter: PeerInfo;
}

/** A tab opened from a response link hands it over to the quiz tab. */
export interface Handoff {
  state: "sending" | "delivered" | "failed";
  link: string;
  problem?: string | null;
}

export interface Actions {
  view(): View | null;
  /** `slug` names the quiz: its file in quizzes/. */
  createQuiz(username: string, slug: string): void;
  /** A one-click join link, or a manual invite link/code (which returns the response to send back). */
  join(username: string, link: string): Promise<PendingResponse | null>;
  cancelJoin(): void;
  rejoin(link: string): Promise<PendingResponse>;
  reconnect(): Promise<void>;
  invite(): Promise<{ inviteId: string; link: string }>;
  connect(response: string): Promise<void>;
  /** The answer to question `index`: an option id, true/false, item ids in order, or a number. */
  answer(index: number, answer: unknown): void;
  finish(): void;
  /** A new round, with another quiz (`slug`) or with the same questions (null). */
  restart(slug: string | null): void;
  leave(): void;
}

let actions: Actions | null = null;

// Local UI state. It is not part of the quiz and is never replicated.
let tab: "play" | "manage" = "play";
let invitation: { link: string; text: string } | null = null;
let joinStatus: string | null = null;
let pendingResponse: PendingResponse | null = null;
let handoff: Handoff | null = null;

export function bindUi(a: Actions, remembered: { username: string; quiz: string }): void {
  actions = a;
  setRenderer(renderUi);
  field("username").value = remembered.username;
  const choice = $<HTMLSelectElement>("quiz-choice");
  choice.replaceChildren(
    ...quizzes().map((q) => {
      const option = el("option", quizTitle(q));
      option.value = q.slug;
      return option;
    }),
  );
  if (quizzes().some((q) => q.slug === remembered.quiz)) choice.value = remembered.quiz;
  const describe = () => {
    const q = quizzes().find((q) => q.slug === choice.value);
    $("quiz-info").textContent = q
      ? `📖 ${[q.subject, `${q.questionCount} questions`].filter(Boolean).join(" · ")}`
      : "";
  };
  choice.addEventListener("change", describe);
  describe();
  onClick("create", () => a.createQuiz(username(), choice.value));
  onClick(
    "join",
    async () => {
      const response = await a.join(username(), invitation?.link ?? field("invite-code").value);
      if (response) pendingResponse = response;
      invitation = null;
    },
    "⏳ JOINING…",
  );
  onClick("cancel-join", () => a.cancelJoin());
  onClick("copy-response", () => copyField("response-link", "copy-response"));
  onClick("share-response", () => share(field("response-link").value));
  onClick("copy-handoff", () => copyField("handoff-link", "copy-handoff"));
  onClick("reconnect", () => a.reconnect(), "⏳ RECONNECTING…");
  onClick(
    "rejoin",
    async () => {
      pendingResponse = await a.rejoin(field("rejoin-code").value);
      field("rejoin-code").value = "";
    },
    "⏳ CREATING RESPONSE…",
  );
  onClick("tab-play", () => (tab = "play"));
  onClick("tab-manage", () => (tab = "manage"));
  onClick("leave", () => {
    if (confirm("🚪 Leave this quiz on this device? You can join again with a link.")) a.leave();
  });
  hideShareIfUnsupported("share-response");
  $("debug").addEventListener("toggle", renderUi);
  bindPlay(a);
  bindManage(a);
}

/** Opened with an invite or join link: joining only needs a name and one click. */
export function showInvitation(link: string, text: string): void {
  invitation = { link, text };
}

export function prefillRejoin(link: string): void {
  field("rejoin-code").value = link;
}

export function showJoinStatus(status: string | null): void {
  joinStatus = status;
  renderUi();
}

export function showTab(next: "play" | "manage"): void {
  tab = next;
}

export function showHandoff(next: Handoff): void {
  handoff = next;
  renderUi();
}

export function renderUi(): void {
  const view = actions?.view() ?? null;
  // A response disappears as soon as the inviting node has used it.
  const inviter = pendingResponse?.inviter.nodeId;
  if (view?.peers.some((p) => p.nodeId === inviter && p.state === "OPEN")) pendingResponse = null;
  if (!view && !joinStatus) pendingResponse = null; // left the quiz

  const screen = handoff
    ? "handoff"
    : !view
      ? joinStatus
        ? "joining"
        : "start"
      : view.state.quiz.createdAt
        ? "quiz"
        : "joining";
  $("start").hidden = screen !== "start";
  $("joining").hidden = screen !== "joining" || pendingResponse !== null;
  $("response").hidden = pendingResponse === null;
  $("handoff").hidden = screen !== "handoff";
  $("quiz").hidden = screen !== "quiz";

  $("invited").hidden = invitation === null;
  $("create-section").hidden = invitation !== null;
  if (invitation) $("invited").textContent = invitation.text;
  $("joining-status").textContent = joinStatus ?? "📥 Connected! Receiving the quiz…";
  if (pendingResponse) {
    showLink("response", pendingResponse.link);
    $("response-to").textContent = pendingResponse.inviter.username;
  }
  if (handoff) {
    showLink("handoff", handoff.link);
    $("handoff-status").textContent = {
      sending: "📨 Handing the response over to your quiz tab…",
      delivered: "✅ Done: your quiz tab is connecting now. You can close this tab.",
      failed: `⚠️ ${handoff.problem} Open the link in the browser where your quiz is running, or copy it and paste it under “Response” in your quiz tab.`,
    }[handoff.state];
    $("handoff-copy").hidden = handoff.state !== "failed";
  }
  if (view && screen === "quiz") renderQuiz(view);
  renderDebug(view);
}

function renderQuiz(view: View): void {
  const { session, state, peers } = view;
  const { quiz } = state;
  $("quiz-name").textContent = quiz.name;
  $("quiz-name").title = quiz.quizId;
  $("quiz-title").textContent = quizTitle(quiz);
  const status = quiz.status === "OPEN" ? "🟢 open" : "🏁 finished";
  $("quiz-meta").textContent = `👤 ${session.username} · 🔁 round ${quiz.round} · ${status}`;

  // Not linked to anybody, though others are in the quiz: typically right after a reload.
  const linked = peers.some((p) => p.state === "OPEN");
  $("rejoin-panel").hidden = linked || quiz.participants.length < 2 || pendingResponse !== null;
  $("reconnect").hidden = !quiz.relay;
  // Someone in the quiz must be online to answer the knock.
  $("reconnect-status").textContent = view.reconnecting ? (joinStatus ?? "🔎 Knocking on the relay…") : "";

  $("tab-play").setAttribute("aria-pressed", String(tab === "play"));
  $("tab-manage").setAttribute("aria-pressed", String(tab === "manage"));
  $("play-view").hidden = tab !== "play";
  $("manage-view").hidden = tab !== "manage";
  if (tab === "play") renderPlay(view);
  else renderManage(view);
}

function renderDebug(view: View | null): void {
  if (!view) {
    $("debug-output").textContent = "Not in a quiz yet.";
    return;
  }
  const { session, state, peers, relayedSignals, door } = view;
  // The log can be long: only while the panel is open.
  const events = $<HTMLDetailsElement>("debug").open ? view.events() : [];
  $("debug-output").textContent = [
    `Node:     ${session.nodeId}`,
    `Username: ${session.username}`,
    `Quiz:     ${state.quiz.quizId}`,
    `Name:     ${state.quiz.name}`,
    `Lamport:  ${state.lamport}`,
    `Events:   ${state.eventCount}`,
    `Open DataChannels: ${peers.filter((p) => p.state === "OPEN").length}`,
    `Relayed signals:   ${relayedSignals}`,
    `Relay door:        ${door}`,
    "",
    "Peers:",
    ...(peers.length > 0 ? peers.map((p) => `  ${p.username}  ${p.state}  (ICE ${p.ice})`) : ["  (none)"]),
    "",
    "Event log (lamport, username, type):",
    ...events.map((e) => `  ${e.lamport}  ${e.username}  ${e.type}`),
  ].join("\n");
}

function username(): string {
  const name = field("username").value.trim();
  if (!name) throw new Error("Please type your name first.");
  return name;
}
