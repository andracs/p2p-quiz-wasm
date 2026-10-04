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
import {
  checkCode,
  compress,
  decompress,
  fromBase64Url,
  toBase64Url,
  type BootstrapCode,
  type PeerInfo,
} from "./protocol";

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
  | { kind: "offer" | "answer"; from: string; to: string; code: BootstrapCode };

/** ntfy.sh turns message bodies over 4096 bytes into file attachments: stay well below. */
const MAX_BODY = 3800;

/**
 * Encrypted messages on one ntfy topic: publish with POST, receive with server-sent events.
 * A message is compressed, encrypted and base64url-encoded; a long one goes out in parts.
 */
export class Relay {
  private source: EventSource | null = null;
  private readonly key: Promise<CryptoKey>;
  private readonly parts = new Map<string, string[]>();

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
        if (data.event !== "message" || typeof data.message !== "string") return;
        const sealed = this.reassemble(data.message);
        if (sealed === null) return; // more parts to come
        const message = await this.open(sealed).catch(() => null); // not ours, or damaged
        if (message) this.onMessage(message, Date.now() / 1000 - data.time);
      };
    });
  }

  async send(message: RelayMessage): Promise<void> {
    const sealed = await this.seal(message);
    // A sealed message has no dots, so parts can be "<id>.<index>.<count>.<piece>".
    const size = MAX_BODY - 32;
    const count = Math.ceil(sealed.length / size);
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(6)));
    const piece = (i: number) => sealed.slice(i * size, (i + 1) * size);
    const bodies = count === 1 ? [sealed] : Array.from({ length: count }, (_, i) => `${id}.${i}.${count}.${piece(i)}`);
    for (const body of bodies) {
      const response = await fetch(`${RELAY_URL}/${this.room.topic}`, { method: "POST", body });
      if (response.status === 429) throw new Error("The relay is busy (too many requests). Try again in a minute.");
      if (!response.ok) throw new Error(`The relay answered ${response.status}.`);
    }
  }

  close(): void {
    this.source?.close();
  }

  /** The whole sealed text: right away, or once every part of a split message is in. */
  private reassemble(body: string): string | null {
    const part = /^([-\w]{8})\.(\d+)\.(\d+)\.([-\w]+)$/.exec(body);
    if (!part) return body;
    const [index, count] = [Number(part[2]), Number(part[3])];
    if (count > 20 || index >= count) return null;
    const pieces = this.parts.get(part[1]) ?? new Array<string>(count).fill("");
    pieces[index] = part[4];
    this.parts.set(part[1], pieces);
    if (pieces.some((p) => p === "")) return null;
    this.parts.delete(part[1]);
    return pieces.join("");
  }

  private async seal(message: RelayMessage): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = await compress(JSON.stringify(message));
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
    return JSON.parse(await decompress(new Uint8Array(plain)));
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
    const { invite } = await this.network.createInvite();
    await this.relay.send({ kind: "offer", from: this.self.nodeId, to, code: invite }).catch((e) => console.warn(e));
  }

  private async accept(code: BootstrapCode): Promise<void> {
    try {
      const response = checkCode(code, "answer");
      if (this.network.openInvites().includes(response.inviteId)) await this.network.acceptResponse(response);
    } catch (error) {
      console.warn("doorman:", error);
    }
  }
}

/**
 * A newcomer (or a reloaded node) knocks every 15 seconds until an online node sends an
 * offer. `answer` turns that offer into a response, which goes back over the relay.
 * `onStatus` keeps the person informed, also when something goes wrong.
 */
export class Knock {
  private readonly relay: Relay;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private closed = false;

  constructor(
    room: Room,
    private readonly self: PeerInfo,
    private readonly answer: (offer: BootstrapCode) => Promise<BootstrapCode>,
    private readonly onStatus: (status: string) => void,
  ) {
    this.relay = new Relay(room, (message) => void this.onMessage(message));
  }

  async start(): Promise<void> {
    await this.relay.listen();
    const knock = () =>
      this.relay
        .send({ kind: "knock", from: this.self.nodeId, username: this.self.username })
        .catch((error) => this.report(`⚠️ ${error.message} Still trying…`));
    await knock();
    this.timer = setInterval(() => !this.busy && knock(), 15_000);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.relay.close();
  }

  private report(status: string): void {
    if (!this.closed) this.onStatus(status);
  }

  private async onMessage(message: RelayMessage): Promise<void> {
    if (message.kind !== "offer" || message.to !== this.self.nodeId || this.busy || this.closed) return;
    this.busy = true; // take the first offer only
    let inviter = "";
    try {
      const offer = checkCode(message.code, "offer");
      inviter = offer.username;
      this.report(`🤝 Connecting to ${inviter}…`);
      const response = await this.answer(offer);
      await this.relay.send({ kind: "answer", from: this.self.nodeId, to: message.from, code: response });
    } catch (error) {
      this.report(`⚠️ ${error instanceof Error ? error.message : error} Still trying…`);
    }
    // Still no link after 15 seconds: say so, and knock again (perhaps another node does better).
    setTimeout(() => {
      this.report(`⚠️ No direct connection${inviter ? ` to ${inviter}` : ""} yet. Trying again…`);
      this.busy = false;
    }, 15_000);
  }
}
