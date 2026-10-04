// One-click joining through a public ntfy relay (https://ntfy.sh).
//
// The relay only carries the very first WebRTC handshake of a new node, and only
// encrypted, with a key that sits after the "#" of the join link: browsers never
// send that part to any server. Everything else, including the quiz itself, still
// goes peer-to-peer. Without the relay, the manual invite links still work.
//
//   newcomer                relay topic                  online node ("doorman")
//      │ ── knock {from} ──────► │ ──────────────────────────────► │
//      │ ◄────────────────────── │ ◄── offer {to, invite code} ──── │
//      │ ── answer {to, code} ─► │ ──────────────────────────────► │
//      │ ◄═══════════════ WebRTC DataChannel, then the usual mesh ═══════════► │

import type { PeerNetwork } from "./peer";
import { decodeCode, fromBase64Url, toBase64Url, type BootstrapCode, type PeerInfo } from "./protocol";

/** The ntfy server. Use ?relay=https://… for a self-hosted one, or ?relay=off to switch it off. */
export const RELAY_URL: string | null = (() => {
  const choice = new URLSearchParams(location.search).get("relay");
  return choice === "off" ? null : (choice ?? "https://ntfy.sh").replace(/\/+$/, "");
})();

/** A quiz's meeting point on the relay: a random topic and a random AES key. */
export interface Room {
  topic: string;
  key: string;
}

export function newRoom(): Room {
  const random = (bytes: number) => toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
  return { topic: `p2pquiz-${random(15)}`, key: random(32) };
}

/** The one-click link: page address, then "#join=topic.key.<first 10 hex digits of the quiz id>". */
export function joinLink(room: Room, quizId: string): string {
  const page = `${location.origin}${location.pathname}${location.search}`;
  return `${page}#join=${room.topic}.${room.key}.${quizId.slice(0, 10)}`;
}

export function parseJoinLink(text: string): { room: Room; quizPrefix: string } | null {
  const match = /join=([-\w]+)\.([-\w]+)\.([0-9a-f]{10})/.exec(text);
  return match && { room: { topic: match[1], key: match[2] }, quizPrefix: match[3] };
}

type RelayMessage =
  | { kind: "knock"; from: string; username: string }
  | { kind: "offer" | "answer"; from: string; to: string; code: string };

/** Encrypted messages on one ntfy topic: publish with POST, receive with server-sent events. */
class Relay {
  private source: EventSource | null = null;
  private readonly key: Promise<CryptoKey>;

  constructor(
    private readonly room: Room,
    private readonly onMessage: (message: RelayMessage, ageSeconds: number) => void,
  ) {
    this.key = crypto.subtle.importKey("raw", fromBase64Url(room.key), "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  /** Subscribe to new messages on the topic. */
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const source = new EventSource(`${RELAY_URL}/${this.room.topic}/sse`);
      this.source = source;
      source.onopen = () => resolve();
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) reject(new Error(`The relay ${RELAY_URL} cannot be reached.`));
      };
      source.onmessage = async (event) => {
        const data = JSON.parse(event.data);
        if (data.event !== "message") return;
        const message = await this.open(data.message).catch(() => null); // not ours, or damaged
        if (message) this.onMessage(message, Date.now() / 1000 - data.time);
      };
    });
  }

  async send(message: RelayMessage): Promise<void> {
    const response = await fetch(`${RELAY_URL}/${this.room.topic}`, { method: "POST", body: await this.seal(message) });
    if (response.status === 429) throw new Error("The relay is busy (too many requests). Try again in a minute.");
    if (!response.ok) throw new Error(`The relay answered ${response.status}.`);
  }

  close(): void {
    this.source?.close();
  }

  private async seal(message: RelayMessage): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(message));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key, plain));
    const bytes = new Uint8Array(iv.length + sealed.length);
    bytes.set(iv);
    bytes.set(sealed, iv.length);
    return toBase64Url(bytes);
  }

  private async open(text: string): Promise<RelayMessage> {
    const bytes = fromBase64Url(text);
    const iv = bytes.slice(0, 12);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await this.key, bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  }
}

/**
 * Run by the first two online nodes of a quiz (lowest nodeIds). The first answers a knock
 * at once; the second only if nobody has offered after a few seconds.
 */
export class Doorman {
  rank = 0;
  private closed = false;
  private readonly relay: Relay;
  private readonly offeredAt = new Map<string, number>();

  constructor(
    room: Room,
    private readonly network: PeerNetwork,
    private readonly self: PeerInfo,
  ) {
    this.relay = new Relay(room, (message, age) => this.onMessage(message, age));
    // Live messages only: a newcomer who is still waiting knocks again every 15 seconds.
    this.relay.listen().catch((error) => console.warn("doorman:", error.message));
  }

  close(): void {
    this.closed = true;
    this.relay.close();
  }

  private onMessage(message: RelayMessage, ageSeconds: number): void {
    if (message.kind === "offer") this.offeredAt.set(message.to, Date.now());
    if (message.kind === "answer" && message.to === this.self.nodeId) void this.accept(message.code);
    // Even a node that still looks linked gets an offer: if it knocks, that link is dead (e.g. a reload).
    if (message.kind === "knock" && message.from !== this.self.nodeId && ageSeconds < 10) {
      setTimeout(() => void this.offer(message.from), this.rank * 4000);
    }
  }

  private async offer(to: string): Promise<void> {
    const recently = Date.now() - (this.offeredAt.get(to) ?? 0) < 10_000;
    if (this.closed || recently) return;
    this.offeredAt.set(to, Date.now());
    const { code } = await this.network.createInvite();
    await this.relay.send({ kind: "offer", from: this.self.nodeId, to, code }).catch((e) => console.warn(e));
  }

  private async accept(code: string): Promise<void> {
    const response = await decodeCode(code, "answer").catch(() => null);
    if (response && this.network.openInvites().includes(response.inviteId)) {
      await this.network.acceptResponse(response).catch((e) => console.warn("doorman:", e));
    }
  }
}

/**
 * A newcomer (or a reloaded node) knocks every 15 seconds until an online node sends an
 * offer. `answer` turns that offer into a response code, which goes back over the relay.
 */
export class Knock {
  private readonly relay: Relay;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;

  constructor(
    room: Room,
    private readonly self: PeerInfo,
    private readonly answer: (offer: BootstrapCode) => Promise<string>,
    private readonly onProblem: (problem: string) => void,
  ) {
    this.relay = new Relay(room, (message) => void this.onMessage(message));
  }

  async start(): Promise<void> {
    await this.relay.listen();
    const knock = () =>
      this.relay
        .send({ kind: "knock", from: this.self.nodeId, username: this.self.username })
        .catch((error) => this.onProblem(error.message));
    await knock();
    this.timer = setInterval(() => !this.busy && knock(), 15_000);
  }

  close(): void {
    clearInterval(this.timer);
    this.relay.close();
  }

  private async onMessage(message: RelayMessage): Promise<void> {
    if (message.kind !== "offer" || message.to !== this.self.nodeId || this.busy) return;
    this.busy = true; // take the first offer only
    try {
      const code = await this.answer(await decodeCode(message.code, "offer"));
      await this.relay.send({ kind: "answer", from: this.self.nodeId, to: message.from, code });
    } catch (error) {
      this.onProblem(error instanceof Error ? error.message : String(error));
    }
    // If no link opens within 20 seconds, knock again: some other online node may do better.
    setTimeout(() => (this.busy = false), 20_000);
  }
}
