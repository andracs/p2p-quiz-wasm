// Everything that travels between nodes: DataChannel messages and the
// copy/paste codes used to bootstrap the very first connection.

export const PROTOCOL = "p2pquiz";
export const PROTOCOL_VERSION = 1;
export const CHANNEL_LABEL = "p2p-quiz";
const CODE_PREFIX = "p2pq1:";

const MESSAGE_TYPES = ["HELLO", "EVENT", "EVENT_LOG_REQUEST", "EVENT_LOG_RESPONSE", "SIGNAL", "PEER_LIST"] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** One JSON message on the "p2p-quiz" DataChannel. */
export interface Message<P = unknown> {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  type: MessageType;
  /** nodeId of the node that created the message (not of the peer that forwarded it). */
  sender: string;
  /** Unique per message; used to drop duplicates and stop routing loops. */
  messageId: string;
  payload: P;
}

export interface PeerInfo {
  nodeId: string;
  username: string;
}

/** A quiz event, exactly as created by the Rust/WASM engine. */
export interface QuizEvent {
  eventId: string;
  quizId: string;
  nodeId: string;
  username: string;
  lamport: number;
  type: string;
  payload: unknown;
}

export interface HelloPayload extends PeerInfo {
  quizId: string;
}

export interface PeerListPayload {
  peers: PeerInfo[];
}

export interface EventLogPayload {
  events: QuizEvent[];
}

export type Signal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "ice"; candidate: RTCIceCandidateInit };

/** WebRTC signaling between two nodes, relayed by the nodes in between. */
export interface SignalPayload {
  sourceNodeId: string;
  sourceUsername: string;
  destinationNodeId: string;
  payload: Signal;
}

export function createMessage<P>(type: MessageType, sender: string, payload: P): Message<P> {
  return {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    type,
    sender,
    messageId: crypto.randomUUID(),
    payload,
  };
}

/** Returns null for anything that is not a known p2pquiz message (unknown types are ignored). */
export function parseMessage(data: unknown): Message | null {
  if (typeof data !== "string") return null;
  let message: Partial<Message>;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (message?.protocol !== PROTOCOL || message.version !== PROTOCOL_VERSION) return null;
  if (typeof message.messageId !== "string" || typeof message.sender !== "string") return null;
  if (!MESSAGE_TYPES.includes(message.type as MessageType)) return null;
  return message as Message;
}

// --- Bootstrap codes -------------------------------------------------------

/** The content of an invite code ("offer") or a response code ("answer"). */
export interface BootstrapCode {
  version: 1;
  type: "offer" | "answer";
  /** Pairs a response with the invite it answers. */
  inviteId: string;
  quizId: string;
  nodeId: string;
  username: string;
  sdp: string;
}

/** JSON -> deflate -> base64url, prefixed with "p2pq1:". */
export async function encodeCode(code: BootstrapCode): Promise<string> {
  return CODE_PREFIX + toBase64Url(await compress(JSON.stringify(code)));
}

/**
 * Leaves out what a link between two browsers practically never needs: TCP candidates
 * (browsers connect over UDP; without a TURN server TCP hardly ever helps) and optional
 * attributes. A laptop with many network interfaces otherwise makes codes of several KB.
 */
export function slimSdp(sdp: string): string {
  return sdp
    .split("\r\n")
    .filter((line) => !/^a=candidate:\S+ \d+ tcp /i.test(line))
    .filter((line) => !line.startsWith("a=extmap-allow-mixed") && !line.startsWith("a=msid-semantic"))
    .map((line) =>
      line.startsWith("a=candidate:") ? line.replace(/ (generation|network-id|network-cost) \S+/g, "") : line,
    )
    .join("\r\n");
}

/** A link to this page that carries a code after the "#". That part never leaves the browser. */
export function codeLink(code: string): string {
  return `${location.origin}${location.pathname}${location.search}#${code}`;
}

/** Accepts a bare code or any text that contains one, such as a link. */
export async function decodeCode(text: string, expected?: BootstrapCode["type"]): Promise<BootstrapCode> {
  const data = new RegExp(`${CODE_PREFIX}([A-Za-z0-9_-]+)`).exec(text.replace(/\s+/g, ""))?.[1];
  if (!data) throw new Error(`Paste a link or a code (it contains "${CODE_PREFIX}").`);
  let code: unknown;
  try {
    code = JSON.parse(await decompress(fromBase64Url(data)));
  } catch {
    throw new Error("This link or code is damaged or incomplete. Copy it again.");
  }
  return checkCode(code, expected);
}

/** Makes sure an invite or response (from a link or from the relay) looks right. */
export function checkCode(code: unknown, expected?: BootstrapCode["type"]): BootstrapCode {
  const c = code as Partial<BootstrapCode> | null;
  if (c?.version !== 1 || (c.type !== "offer" && c.type !== "answer") || typeof c.sdp !== "string") {
    throw new Error("This is not a P2P Quiz Wasm link.");
  }
  if (expected && c.type !== expected) {
    throw new Error(expected === "offer" ? "That is a response, not an invite." : "That is an invite, not a response.");
  }
  return c as BootstrapCode;
}

/** Text -> deflate-raw bytes. */
export async function compress(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return pipe(new TextEncoder().encode(text), new CompressionStream("deflate-raw"));
}

/** deflate-raw bytes -> text. */
export async function decompress(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
