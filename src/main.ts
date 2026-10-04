// Wires the pieces together: the Rust/WASM engine (quiz logic), the WebRTC network
// (transport), the relay (one-click joining), local storage and the page.
// Every node runs exactly this code. No node has a special role.

import init, { QuizEngine, quizName } from "../wasm/pkg/p2p_quiz_wasm.js";
import { attempt } from "./dom";
import { PeerNetwork } from "./peer";
import {
  codeLink,
  createMessage,
  decodeCode,
  type BootstrapCode,
  type EventLogPayload,
  type Message,
  type PeerInfo,
  type QuizEvent,
} from "./protocol";
import { Doorman, Knock, RELAY_URL, joinLink, newRoom, parseJoinLink, type Room } from "./relay";
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
  bindUi,
  prefillRejoin,
  renderUi,
  showHandoff,
  showInvitation,
  showJoinStatus,
  showTab,
  type PendingResponse,
  type QuizState,
} from "./ui";

/** This browser tab's node in one quiz. */
class QuizNode {
  readonly network: PeerNetwork;
  private door: Doorman | null = null;
  private closed = false;

  constructor(
    readonly session: Session,
    readonly engine: QuizEngine,
  ) {
    this.network = new PeerNetwork({ nodeId: session.nodeId, username: session.username }, session.quizId, {
      onPeerOpen: (peer) => {
        // Every new link starts with an event log exchange, so both sides catch up.
        this.network.sendTo(peer.nodeId, createMessage("EVENT_LOG_REQUEST", session.nodeId, {}));
        stopKnocking();
      },
      onMessage: (message, from) => this.onMessage(message, from),
      onChange: () => {
        this.updateDoor();
        renderUi();
      },
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

  /** The two online nodes with the lowest nodeIds keep the relay door for newcomers. */
  updateDoor(): void {
    const room = this.state().quiz.relay;
    const rank = this.network.onlineNodeIds().sort().indexOf(this.session.nodeId);
    if (this.closed || !RELAY_URL || !room || rank > 1) {
      this.door?.close();
      this.door = null;
      return;
    }
    this.door ??= new Doorman(room, this.network, { nodeId: this.session.nodeId, username: this.session.username });
    this.door.rank = rank;
  }

  doorStatus(): string {
    if (this.door) return `door keeper #${this.door.rank + 1} on ${RELAY_URL}`;
    return RELAY_URL ? "not needed" : "relay off";
  }

  close(): void {
    this.closed = true;
    this.door?.close();
    this.door = null;
    this.network.close();
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
    const { quiz } = this.state();
    if (quiz.createdAt && !quiz.participants.some((p) => p.nodeId === this.session.nodeId)) this.act("PEER_JOINED");
    this.updateDoor();
    renderUi();
  }
}

let node: QuizNode | null = null;
let knock: Knock | null = null;

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
  const room = RELAY_URL ? newRoom() : null;
  engine.create(window.location.hostname, new Date().toISOString(), JSON.stringify(room), crypto.randomUUID());
  activate(new QuizNode({ quizId: engine.quizId, nodeId, username }, engine));
  current().act("PEER_JOINED"); // the creator is in the quiz like everybody else
  current().updateDoor();
  showTab("manage");
}

// --- Joining -----------------------------------------------------------------------

/** A one-click join link (through the relay), or a manual invite link or code. */
async function join(username: string, link: string): Promise<PendingResponse | null> {
  const parsed = parseJoinLink(link);
  if (!parsed) return joinWithInvite(username, link);
  if (!RELAY_URL) throw new Error("The relay is switched off (?relay=off): ask for a manual invite link.");
  startKnocking(parsed.room, { nodeId: crypto.randomUUID(), username }, parsed.quizPrefix);
  return null;
}

/** Knock on the relay until an online node of the quiz offers a link. */
function startKnocking(room: Room, self: PeerInfo, quizPrefix?: string): void {
  stopKnocking();
  showJoinStatus(node ? null : "🔎 Looking for someone in the quiz…");
  const problem = (text: string) => !node && showJoinStatus(`⚠️ ${text} Still trying…`);
  const attemptKnock = new Knock(room, self, (offer) => answerOffer(self, offer, quizPrefix), problem);
  knock = attemptKnock;
  attemptKnock.start().catch((error: Error) => {
    if (knock !== attemptKnock) return; // cancelled meanwhile
    stopKnocking();
    void attempt(() => {
      throw error;
    });
  });
}

function stopKnocking(): void {
  knock?.close();
  knock = null;
  showJoinStatus(null);
}

/** An online node sent an offer through the relay: join its quiz (or link up our own node again). */
async function answerOffer(self: PeerInfo, offer: BootstrapCode, quizPrefix?: string): Promise<string> {
  if (quizPrefix && !offer.quizId.startsWith(quizPrefix)) throw new Error("This offer is for another quiz.");
  if (node?.session.quizId === offer.quizId) return node.network.acceptInvite(offer);
  showJoinStatus(`🤝 Connecting to ${offer.username}…`);
  const engine = new QuizEngine(self.nodeId, self.username);
  engine.join(offer.quizId);
  const joining = new QuizNode({ quizId: offer.quizId, ...self }, engine);
  const code = await joining.network.acceptInvite(offer);
  activate(joining);
  showTab("play");
  return code;
}

/** The manual way: an invite link or code made by a node of the quiz. */
async function joinWithInvite(username: string, invitation: string): Promise<PendingResponse> {
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
  showTab("play");
  return { link: codeLink(code), inviter: { nodeId: invite.nodeId, username: invite.username } };
}

/** After a reload: link up again with a manual invite link from any connected node. */
async function rejoin(invitation: string): Promise<PendingResponse> {
  const invite = await decodeCode(invitation, "offer");
  if (invite.quizId !== current().session.quizId) throw new Error("That invite belongs to another quiz.");
  const code = await current().network.acceptInvite(invite);
  return { link: codeLink(code), inviter: { nodeId: invite.nodeId, username: invite.username } };
}

/** After a reload: knock on the relay with our own identity. */
async function reconnect(): Promise<void> {
  const { session } = current();
  const room = current().state().quiz.relay;
  if (!RELAY_URL || !room) throw new Error("This quiz has no relay: ask a connected player for an invite link.");
  startKnocking(room, { nodeId: session.nodeId, username: session.username });
}

function leave(): void {
  stopKnocking();
  node?.close();
  node = null;
  clearSession();
}

/** A reload keeps this tab's identity and rebuilds the state from the stored event log. */
function restore(session: Session): void {
  const engine = new QuizEngine(session.nodeId, session.username);
  engine.join(session.quizId);
  engine.merge_events(JSON.stringify(loadEvents(session.quizId)));
  if (!JSON.parse(engine.get_state()).quiz.createdAt) return clearSession(); // the join never completed
  node = new QuizNode(session, engine);
  node.updateDoor();
  const { quiz } = node.state();
  if (RELAY_URL && quiz.relay && quiz.participants.length > 1) void reconnect();
}

// --- Links ------------------------------------------------------------------------
// Codes travel after the "#" of a link, which the browser never sends to the web
// server. A manual response link opens a new tab, so that tab hands the code over to
// the quiz tab that made the invite, over a BroadcastChannel (tabs of one browser).

const tabs = new BroadcastChannel("p2pquiz");

/** Takes a code out of the address bar, so that a reload does not use it again. */
function takeLinkedCode(): string | null {
  if (!/p2pq1:|join=/.test(location.hash)) return null;
  const text = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname + location.search);
  return text;
}

async function openLink(text: string): Promise<void> {
  const parsed = parseJoinLink(text);
  if (parsed) {
    if (!node) {
      const name = quizName(parsed.quizPrefix);
      return showInvitation(text, `🎉 You are invited to the quiz “${name}”. Type your name and press JOIN QUIZ.`);
    }
    if (node.session.quizId.startsWith(parsed.quizPrefix)) return;
    throw new Error("This tab is already in another quiz. Leave it first, or open the link in a new tab.");
  }
  const code = await decodeCode(text);
  if (code.type === "offer") {
    if (!node) {
      const name = quizName(code.quizId);
      return showInvitation(
        text,
        `🎉 ${code.username} invites you to the quiz “${name}”. Type your name and press JOIN QUIZ.`,
      );
    }
    if (node.session.quizId === code.quizId) return prefillRejoin(text);
    throw new Error("This tab is already in another quiz. Leave it first, or open the link in a new tab.");
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
  bindUi(
    {
      view: () => {
        if (!node) return null;
        const state = node.state();
        const room = state.quiz.relay;
        return {
          session: node.session,
          state,
          peers: node.network.peerStatuses(),
          openInvites: node.network.openInvites(),
          relayedSignals: node.network.relayedSignals,
          events: node.events(),
          joinLink: RELAY_URL && room ? joinLink(room, state.quiz.quizId) : null,
          door: node.doorStatus(),
          reconnecting: knock !== null,
        };
      },
      createQuiz,
      join,
      cancelJoin: stopKnocking,
      rejoin,
      reconnect,
      invite: async () => {
        const { inviteId, code } = await current().network.createInvite();
        return { inviteId, link: codeLink(code) };
      },
      connect: async (text) => current().network.acceptResponse(await decodeCode(text, "answer")),
      answer: (questionId, key) => {
        const { round } = current().state().quiz;
        current().act("ANSWER_SUBMITTED", { round, questionId, answer: key });
      },
      finish: () => current().act("QUIZ_FINISHED", { round: current().state().quiz.round }),
      restart: () => current().act("QUIZ_RESTARTED", { round: current().state().quiz.round + 1 }),
      leave,
    },
    loadUsername(),
  );
  if (saved) restore(saved);
  window.addEventListener("pagehide", () => {
    knock?.close();
    node?.close();
  });
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
