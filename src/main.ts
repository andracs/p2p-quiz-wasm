// Wires the pieces together: the Rust/WASM engine (quiz logic), the WebRTC
// network (transport), local storage (persistence) and the page (ui.ts).
// Every node runs exactly this code. No node has a special role.

import init, { QuizEngine } from "../wasm/pkg/p2p_quiz_wasm.js";
import { PeerNetwork } from "./peer";
import { codeLink, createMessage, decodeCode, type EventLogPayload, type Message, type QuizEvent } from "./protocol";
import {
  clearSession,
  loadEvents,
  loadSession,
  loadUsername,
  saveEvents,
  saveSession,
  saveUsername,
  type Session,
} from "./storage";
import {
  attempt,
  bindUi,
  prefillRejoin,
  renderUi,
  showHandoff,
  showInvitation,
  type PendingResponse,
  type QuizState,
} from "./ui";

/** This browser tab's node in one quiz. */
class QuizNode {
  readonly network: PeerNetwork;

  constructor(
    readonly session: Session,
    readonly engine: QuizEngine,
  ) {
    this.network = new PeerNetwork({ nodeId: session.nodeId, username: session.username }, session.quizId, {
      // Every new link starts with an event log exchange, so both sides catch up.
      onPeerOpen: (peer) => this.network.sendTo(peer.nodeId, createMessage("EVENT_LOG_REQUEST", session.nodeId, {})),
      onMessage: (message, from) => this.onMessage(message, from),
      onChange: renderUi,
    });
  }

  state(): QuizState {
    return JSON.parse(this.engine.get_state());
  }

  events(): QuizEvent[] {
    return JSON.parse(this.engine.get_events());
  }

  /** Create a local event, store it and send it to all peers. */
  act(type: string, payload: object = {}): void {
    const event: QuizEvent = JSON.parse(this.engine.create_event(type, JSON.stringify(payload), crypto.randomUUID()));
    this.persist();
    this.network.broadcast(createMessage("EVENT", this.session.nodeId, event));
    renderUi();
  }

  persist(): void {
    saveEvents(this.session.quizId, this.events());
  }

  private onMessage(message: Message, from: string): void {
    try {
      switch (message.type) {
        case "EVENT":
          return this.onEvent(message, from);
        case "EVENT_LOG_REQUEST": {
          const response = createMessage<EventLogPayload>("EVENT_LOG_RESPONSE", this.session.nodeId, {
            events: this.events(),
          });
          return this.network.sendTo(from, response);
        }
        case "EVENT_LOG_RESPONSE":
          return this.onEventLog(message.payload as EventLogPayload, from);
      }
    } catch (error) {
      console.warn(`ignored ${message.type} from ${from}:`, error);
    }
  }

  /** Gossip: 1. ignore known events, 2. apply new ones in WASM, 3. store them, 4. pass them on. */
  private onEvent(message: Message, from: string): void {
    if (!this.engine.apply_event(JSON.stringify(message.payload))) return;
    this.persist();
    this.network.broadcast(message, from);
    renderUi();
  }

  private onEventLog({ events }: EventLogPayload, from: string): void {
    const added: QuizEvent[] = JSON.parse(this.engine.merge_events(JSON.stringify(events)));
    if (added.length > 0) this.persist();
    for (const event of added) this.network.broadcast(createMessage("EVENT", this.session.nodeId, event), from);
    // A joining node announces itself as soon as it has the log.
    const state = this.state();
    if (state.createdAt && !state.participants.some((p) => p.nodeId === this.session.nodeId)) {
      this.act("PEER_JOINED");
    }
    renderUi();
  }
}

let node: QuizNode | null = null;

function current(): QuizNode {
  if (!node) throw new Error("Not in a quiz.");
  return node;
}

function activate(next: QuizNode): void {
  node = next;
  saveSession(next.session);
  saveUsername(next.session.username);
  next.persist();
}

function createQuiz(username: string): void {
  const nodeId = crypto.randomUUID();
  const engine = new QuizEngine(nodeId, username);
  // The engine computes quizId = SHA256(domain|username|timestamp).
  engine.create(window.location.hostname, new Date().toISOString(), crypto.randomUUID());
  activate(new QuizNode({ quizId: engine.quizId, nodeId, username }, engine));
  current().act("PEER_JOINED"); // the creator joins exactly like everybody else
}

async function joinQuiz(username: string, invitation: string): Promise<PendingResponse> {
  const invite = await decodeCode(invitation, "offer");
  const nodeId = crypto.randomUUID();
  const engine = new QuizEngine(nodeId, username);
  engine.join(invite.quizId);
  const joining = new QuizNode({ quizId: invite.quizId, nodeId, username }, engine);
  const code = await joining.network.acceptInvite(invite).catch((error) => {
    joining.network.close();
    throw error;
  });
  activate(joining);
  return { link: codeLink(code), inviter: { nodeId: invite.nodeId, username: invite.username } };
}

/** After a reload: link up again with an invite from any connected peer. */
async function rejoinQuiz(invitation: string): Promise<PendingResponse> {
  const invite = await decodeCode(invitation, "offer");
  if (invite.quizId !== current().session.quizId) throw new Error("That invite belongs to another quiz.");
  const code = await current().network.acceptInvite(invite);
  return { link: codeLink(code), inviter: { nodeId: invite.nodeId, username: invite.username } };
}

/** A reload keeps this tab's identity and rebuilds the state from the stored event log. */
function restore(session: Session): void {
  const engine = new QuizEngine(session.nodeId, session.username);
  engine.join(session.quizId);
  engine.merge_events(JSON.stringify(loadEvents(session.quizId)));
  if (JSON.parse(engine.get_state()).createdAt) node = new QuizNode(session, engine);
  else clearSession(); // the join never completed: start over
}

// --- Links ------------------------------------------------------------------------
// An invite or response can travel as a link: the code sits after the "#", which the
// browser never sends to the web server. Opening a response link starts a new tab, so
// that tab hands the code over to the quiz tab that made the invite. Tabs of the same
// browser can talk over a BroadcastChannel: still no server involved.

const tabs = new BroadcastChannel("p2pquiz");

/** Takes a code out of the address bar, so that a reload does not use it again. */
function takeLinkedCode(): string | null {
  if (!location.hash.includes("p2pq1:")) return null;
  const text = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  return text;
}

async function openLink(text: string): Promise<void> {
  const code = await decodeCode(text);
  if (code.type === "offer") {
    if (!node) return showInvitation({ code: text, inviter: code.username, quizId: code.quizId });
    if (node.session.quizId === code.quizId) return prefillRejoin(text);
    throw new Error("This tab is already in another quiz. Open the invite link in a new tab.");
  }
  // A response: for an invite made in this very tab, or in another tab of this browser?
  if (node?.network.openInvites().includes(code.inviteId)) return node.network.acceptResponse(code);
  if (node) {
    const problem = await handOver(text, code.inviteId);
    if (problem) throw new Error(problem);
    return;
  }
  const link = codeLink(text);
  showHandoff({ state: "sending", link });
  const problem = await handOver(text, code.inviteId);
  showHandoff({ state: problem === null ? "delivered" : "failed", link, problem });
}

/** Offers a response to the other tabs. Resolves with null once the right tab took it. */
function handOver(code: string, inviteId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const finish = (problem: string | null) => {
      clearTimeout(timer);
      tabs.removeEventListener("message", onReply);
      resolve(problem);
    };
    const onReply = ({ data }: MessageEvent) => {
      if (data?.inviteId === inviteId) finish(data.kind === "accepted" ? null : String(data.problem));
    };
    const timer = setTimeout(() => finish("No quiz tab in this browser is waiting for this response."), 3000);
    tabs.addEventListener("message", onReply);
    tabs.postMessage({ kind: "response", code });
  });
}

/** In the quiz tab: take a response that a link opened in another tab handed over. */
tabs.addEventListener("message", async ({ data }: MessageEvent) => {
  if (data?.kind !== "response" || !node) return;
  const response = await decodeCode(data.code, "answer").catch(() => null);
  if (!response || !node.network.openInvites().includes(response.inviteId)) return; // another tab's invite
  try {
    await node.network.acceptResponse(response);
    tabs.postMessage({ kind: "accepted", inviteId: response.inviteId });
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    tabs.postMessage({ kind: "rejected", inviteId: response.inviteId, problem });
  }
  renderUi();
});

async function main(): Promise<void> {
  await init();
  const linked = takeLinkedCode();
  const response = linked !== null && (await decodeCode(linked).catch(() => null))?.type === "answer";
  // A tab opened from a response link only delivers it; it does not resume a quiz itself.
  const saved = response ? null : loadSession();
  if (saved) restore(saved);
  bindUi(
    {
      view: () =>
        node && {
          session: node.session,
          state: node.state(),
          peers: node.network.peerStatuses(),
          openInvites: node.network.openInvites(),
          relayedSignals: node.network.relayedSignals,
          events: node.events(),
        },
      createQuiz,
      joinQuiz,
      rejoinQuiz,
      invite: async () => {
        const { inviteId, code } = await current().network.createInvite();
        return { inviteId, link: codeLink(code) };
      },
      connect: async (text) => current().network.acceptResponse(await decodeCode(text, "answer")),
      start: () => current().act("QUIZ_STARTED"),
      answer: (key) => current().act("ANSWER_SUBMITTED", { questionId: current().state().question.id, answer: key }),
      showScoreboard: () => current().act("SHOW_SCOREBOARD"),
    },
    loadUsername(),
  );
  window.addEventListener("pagehide", () => node?.network.close());
  // A link pasted into the address bar of an open quiz tab only changes the "#" part.
  window.addEventListener("hashchange", () => {
    const text = takeLinkedCode();
    if (text) void attempt(() => openLink(text));
  });
  renderUi();
  if (linked) await attempt(() => openLink(linked));
}

main().catch((error) => {
  document.body.textContent = `P2P Quiz Wasm failed to start: ${error}`;
});
