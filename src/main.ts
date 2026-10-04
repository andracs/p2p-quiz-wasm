// Wires the pieces together: the Rust/WASM engine (quiz logic), the WebRTC
// network (transport), local storage (persistence) and the page (ui.ts).
// Every node runs exactly this code. No node has a special role.

import init, { QuizEngine } from "../wasm/pkg/p2p_quiz_wasm.js";
import { PeerNetwork } from "./peer";
import { createMessage, decodeCode, type EventLogPayload, type Message, type QuizEvent } from "./protocol";
import { clearSession, loadEvents, loadSession, saveEvents, saveSession, type Session } from "./storage";
import { bindUi, renderUi, type PendingResponse, type QuizState } from "./ui";

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

async function joinQuiz(username: string, inviteCode: string): Promise<PendingResponse> {
  const invite = await decodeCode(inviteCode, "offer");
  const nodeId = crypto.randomUUID();
  const engine = new QuizEngine(nodeId, username);
  engine.join(invite.quizId);
  const joining = new QuizNode({ quizId: invite.quizId, nodeId, username }, engine);
  const code = await joining.network.acceptInvite(invite).catch((error) => {
    joining.network.close();
    throw error;
  });
  activate(joining);
  return { code, inviter: { nodeId: invite.nodeId, username: invite.username } };
}

/** After a reload: link up again with an invite from any connected peer. */
async function rejoinQuiz(inviteCode: string): Promise<PendingResponse> {
  const invite = await decodeCode(inviteCode, "offer");
  if (invite.quizId !== current().session.quizId) throw new Error("That invite belongs to another quiz.");
  const code = await current().network.acceptInvite(invite);
  return { code, inviter: { nodeId: invite.nodeId, username: invite.username } };
}

/** A reload keeps this tab's identity and rebuilds the state from the stored event log. */
function restore(session: Session): void {
  const engine = new QuizEngine(session.nodeId, session.username);
  engine.join(session.quizId);
  engine.merge_events(JSON.stringify(loadEvents(session.quizId)));
  if (JSON.parse(engine.get_state()).createdAt) node = new QuizNode(session, engine);
  else clearSession(); // the join never completed: start over
}

async function main(): Promise<void> {
  await init();
  const saved = loadSession();
  if (saved) restore(saved);
  bindUi({
    view: () =>
      node && {
        session: node.session,
        state: node.state(),
        peers: node.network.peerStatuses(),
        relayedSignals: node.network.relayedSignals,
        events: node.events(),
      },
    createQuiz,
    joinQuiz,
    rejoinQuiz,
    invite: () => current().network.createInvite(),
    connect: async (code) => current().network.acceptResponse(await decodeCode(code, "answer")),
    start: () => current().act("QUIZ_STARTED"),
    answer: (key) => current().act("ANSWER_SUBMITTED", { questionId: current().state().question.id, answer: key }),
    showScoreboard: () => current().act("SHOW_SCOREBOARD"),
  });
  window.addEventListener("pagehide", () => node?.network.close());
  renderUi();
}

main().catch((error) => {
  document.body.textContent = `P2P Quiz Wasm failed to start: ${error}`;
});
