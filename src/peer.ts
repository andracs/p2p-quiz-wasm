// The WebRTC transport. It knows nothing about quizzes: it moves JSON messages
// between nodes. The first link is bootstrapped by hand with copy/paste codes.
// Every later link is negotiated by relaying the WebRTC signaling messages
// through links that already exist, until every node is linked to every other.

import {
  CHANNEL_LABEL,
  createMessage,
  parseMessage,
  slimSdp,
  type BootstrapCode,
  type HelloPayload,
  type Message,
  type PeerInfo,
  type PeerListPayload,
  type Signal,
  type SignalPayload,
} from "./protocol";

// A public STUN server lets nodes behind NAT discover their public address.
// It is optional: on one machine or one LAN, local addresses are enough.
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
// Codes are created once ICE gathering is complete, but we never wait longer
// than this (for example when the STUN server cannot be reached).
const ICE_GATHERING_TIMEOUT_MS = 3000;
// Give up on a relayed negotiation that never completes.
const MESH_CONNECT_TIMEOUT_MS = 20000;

interface Peer {
  info: PeerInfo;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

export interface PeerStatus extends PeerInfo {
  /** State of the DataChannel to this peer: CONNECTING, OPEN, CLOSING or CLOSED. */
  state: string;
  /** How far ICE got in finding a network path, for the debug panel. */
  ice: RTCIceConnectionState;
}

export interface NetworkHandlers {
  /** A DataChannel to a peer has opened. */
  onPeerOpen(peer: PeerInfo): void;
  /** An EVENT, EVENT_LOG_REQUEST or EVENT_LOG_RESPONSE arrived (duplicates are dropped). */
  onMessage(message: Message, fromNodeId: string): void;
  /** Something the UI shows has changed. */
  onChange(): void;
}

export class PeerNetwork {
  /** Signaling messages this node forwarded on behalf of other nodes. */
  relayedSignals = 0;
  private closed = false;
  private readonly peers = new Map<string, Peer>();
  private readonly invites = new Map<string, { pc: RTCPeerConnection; channel: RTCDataChannel }>();
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly self: PeerInfo,
    private readonly quizId: string,
    private readonly handlers: NetworkHandlers,
  ) {}

  // --- Manual bootstrap: invite code, then response code ----------------------

  /** Any node in the quiz: create an offer for one new node. */
  async createInvite(): Promise<{ inviteId: string; invite: BootstrapCode }> {
    if (this.closed) throw new Error("This node has left the quiz.");
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const channel = pc.createDataChannel(CHANNEL_LABEL);
    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc);
    const inviteId = crypto.randomUUID();
    this.invites.set(inviteId, { pc, channel });
    const sdp = slimSdp(pc.localDescription!.sdp);
    return { inviteId, invite: { version: 1, type: "offer", inviteId, quizId: this.quizId, ...this.self, sdp } };
  }

  /** Invites of this node that are still waiting for their response. */
  openInvites(): string[] {
    return [...this.invites.keys()];
  }

  /** New node: accept an invite and create the response. */
  async acceptInvite(invite: BootstrapCode): Promise<BootstrapCode> {
    const peer = this.addPeer({ nodeId: invite.nodeId, username: invite.username }, new RTCPeerConnection(RTC_CONFIG));
    await peer.pc.setRemoteDescription({ type: "offer", sdp: invite.sdp });
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    await iceGatheringComplete(peer.pc);
    const sdp = slimSdp(peer.pc.localDescription!.sdp);
    return { version: 1, type: "answer", inviteId: invite.inviteId, quizId: this.quizId, ...this.self, sdp };
  }

  /** Inviting node: apply the response code. The DataChannel opens shortly after. */
  async acceptResponse(response: BootstrapCode): Promise<void> {
    const invite = this.invites.get(response.inviteId);
    if (!invite) throw new Error("No open invite in this tab matches this response. Each invite works once.");
    if (response.quizId !== this.quizId) throw new Error("This response belongs to another quiz.");
    this.invites.delete(response.inviteId);
    const peer = this.addPeer({ nodeId: response.nodeId, username: response.username }, invite.pc);
    this.attachChannel(peer, invite.channel);
    await invite.pc.setRemoteDescription({ type: "answer", sdp: response.sdp });
  }

  // --- Sending ------------------------------------------------------------------

  /** Send to one directly linked peer. */
  sendTo(nodeId: string, message: Message): void {
    const peer = this.peers.get(nodeId);
    if (peer) this.sendRaw(peer, message);
  }

  /** Send to every directly linked peer, except the one the message came from. */
  broadcast(message: Message, exceptNodeId?: string): void {
    this.seenMessageIds.add(message.messageId);
    for (const peer of this.peers.values()) {
      if (peer.info.nodeId !== exceptNodeId) this.sendRaw(peer, message);
    }
  }

  private sendRaw(peer: Peer, message: Message): void {
    if (channelState(peer) !== "open") return;
    try {
      peer.channel!.send(JSON.stringify(message));
    } catch (error) {
      console.warn("send failed", error);
    }
  }

  // --- Status -------------------------------------------------------------------

  peerStatuses(): PeerStatus[] {
    return [...this.peers.values()].map((peer) => ({
      ...peer.info,
      state: channelState(peer).toUpperCase(),
      ice: peer.pc.iceConnectionState,
    }));
  }

  isOpen(nodeId: string): boolean {
    const peer = this.peers.get(nodeId);
    return peer !== undefined && channelState(peer) === "open";
  }

  /** This node and every node it has an open DataChannel to. */
  onlineNodeIds(): string[] {
    const linked = [...this.peers.values()].filter((p) => channelState(p) === "open").map((p) => p.info.nodeId);
    return [this.self.nodeId, ...linked];
  }

  /** Close every link, e.g. when the page is closed. */
  /** Close every link for good, e.g. when leaving the quiz or closing the page. */
  close(): void {
    this.closed = true;
    for (const peer of this.peers.values()) peer.pc.close();
    for (const invite of this.invites.values()) invite.pc.close();
    this.invites.clear();
  }

  // --- Receiving ------------------------------------------------------------------

  private receive(data: unknown, fromNodeId: string): void {
    if (this.closed) return;
    const message = parseMessage(data);
    // Unknown message types and messages seen before (loops, floods) are dropped.
    if (!message || this.seenMessageIds.has(message.messageId)) return;
    this.seenMessageIds.add(message.messageId);
    switch (message.type) {
      case "HELLO":
        return this.onHello(message.payload as HelloPayload, fromNodeId);
      case "PEER_LIST":
        return this.onPeerList(message.payload as PeerListPayload);
      case "SIGNAL":
        return this.onSignal(message as Message<SignalPayload>, fromNodeId);
      default:
        return this.handlers.onMessage(message, fromNodeId);
    }
  }

  private onHello(hello: HelloPayload, fromNodeId: string): void {
    const peer = this.peers.get(fromNodeId);
    if (!peer) return;
    if (hello.quizId === this.quizId && hello.nodeId === fromNodeId) {
      peer.info.username = hello.username;
    } else {
      peer.pc.close(); // a node from another quiz
    }
    this.handlers.onChange();
  }

  // --- Mesh: link every node to every other node ----------------------------------

  /** Tell every linked peer which peers this node is linked to. */
  private sendPeerList(): void {
    const peers = [...this.peers.values()].filter((p) => channelState(p) === "open").map((p) => p.info);
    this.broadcast(createMessage<PeerListPayload>("PEER_LIST", this.self.nodeId, { peers }));
  }

  /** Link to the peers of our peers. In each pair, the node with the smaller nodeId makes the offer. */
  private onPeerList({ peers }: PeerListPayload): void {
    for (const info of peers) {
      const known = this.peers.get(info.nodeId);
      const linked = known !== undefined && ["connecting", "open"].includes(channelState(known));
      if (info.nodeId !== this.self.nodeId && !linked && this.self.nodeId < info.nodeId) {
        this.connectViaMesh({ nodeId: info.nodeId, username: info.username }).catch((error) =>
          console.warn("mesh connect failed", error),
        );
      }
    }
  }

  private async connectViaMesh(info: PeerInfo): Promise<void> {
    const peer = this.addPeer(info, new RTCPeerConnection(RTC_CONFIG), true);
    this.attachChannel(peer, peer.pc.createDataChannel(CHANNEL_LABEL));
    setTimeout(() => {
      if (channelState(peer) === "open") return;
      peer.pc.close();
      this.handlers.onChange();
    }, MESH_CONNECT_TIMEOUT_MS);
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    this.sendSignal(info.nodeId, { type: "offer", sdp: peer.pc.localDescription!.sdp });
  }

  // --- Signaling relayed through existing links -----------------------------------

  private sendSignal(destinationNodeId: string, signal: Signal): void {
    const message = createMessage<SignalPayload>("SIGNAL", this.self.nodeId, {
      sourceNodeId: this.self.nodeId,
      sourceUsername: this.self.username,
      destinationNodeId,
      payload: signal,
    });
    this.seenMessageIds.add(message.messageId);
    this.route(message);
  }

  /** Send straight to the destination if linked to it, otherwise flood all other links. */
  private route(message: Message<SignalPayload>, fromNodeId?: string): void {
    const destination = this.peers.get(message.payload.destinationNodeId);
    if (destination && channelState(destination) === "open") this.sendRaw(destination, message);
    else this.broadcast(message, fromNodeId);
  }

  private onSignal(message: Message<SignalPayload>, fromNodeId: string): void {
    if (message.payload.destinationNodeId !== this.self.nodeId) {
      this.relayedSignals++;
      this.route(message, fromNodeId);
      this.handlers.onChange();
      return;
    }
    this.handleSignal(message.payload).catch((error) => console.warn("signaling failed", error));
  }

  private async handleSignal({ sourceNodeId, sourceUsername, payload }: SignalPayload): Promise<void> {
    if (payload.type === "offer") {
      const info = { nodeId: sourceNodeId, username: sourceUsername };
      const peer = this.addPeer(info, new RTCPeerConnection(RTC_CONFIG), true);
      await peer.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      await this.flushCandidates(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      this.sendSignal(sourceNodeId, { type: "answer", sdp: peer.pc.localDescription!.sdp });
    } else if (payload.type === "answer") {
      const peer = this.peers.get(sourceNodeId);
      if (peer?.pc.signalingState !== "have-local-offer") return;
      await peer.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      await this.flushCandidates(peer);
    } else {
      // A candidate can overtake its offer or answer; keep it until it can be used.
      const queue = this.pendingCandidates.get(sourceNodeId) ?? [];
      queue.push(payload.candidate);
      this.pendingCandidates.set(sourceNodeId, queue);
      const peer = this.peers.get(sourceNodeId);
      if (peer?.pc.remoteDescription) await this.flushCandidates(peer);
    }
  }

  private async flushCandidates(peer: Peer): Promise<void> {
    const queue = this.pendingCandidates.get(peer.info.nodeId) ?? [];
    this.pendingCandidates.delete(peer.info.nodeId);
    for (const candidate of queue) await peer.pc.addIceCandidate(candidate).catch(() => {});
  }

  // --- Links ------------------------------------------------------------------------

  /** Register the link to a node. A newer link to the same node replaces the old one. */
  private addPeer(info: PeerInfo, pc: RTCPeerConnection, trickleIce = false): Peer {
    this.peers.get(info.nodeId)?.pc.close();
    const peer: Peer = { info, pc, channel: null };
    this.peers.set(info.nodeId, peer);
    pc.ondatachannel = (event) => this.attachChannel(peer, event.channel);
    // Never close on "failed": Chrome reports it for a moment when a response is applied long
    // after it was made (e.g. sent back through a chat), and then recovers on its own.
    pc.onconnectionstatechange = () => this.handlers.onChange();
    if (trickleIce) {
      pc.onicecandidate = (event) => {
        if (event.candidate) this.sendSignal(info.nodeId, { type: "ice", candidate: event.candidate.toJSON() });
      };
    }
    this.handlers.onChange();
    return peer;
  }

  private attachChannel(peer: Peer, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.onopen = () => {
      const hello = createMessage<HelloPayload>("HELLO", this.self.nodeId, { ...this.self, quizId: this.quizId });
      this.sendRaw(peer, hello);
      this.handlers.onPeerOpen(peer.info);
      this.sendPeerList();
      this.handlers.onChange();
    };
    channel.onclose = () => this.handlers.onChange();
    channel.onmessage = (event) => this.receive(event.data, peer.info.nodeId);
  }
}

function channelState(peer: Peer): RTCDataChannelState {
  if (peer.pc.connectionState === "failed" || peer.pc.connectionState === "closed") return "closed";
  return peer.channel?.readyState ?? "connecting";
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    pc.addEventListener("icegatheringstatechange", check);
    check();
  });
}
