# P2P Quiz Wasm

A very small proof-of-concept: a one-question quiz that runs as static files (for example on GitHub Pages).
Browsers connect directly to each other with WebRTC DataChannels, and the quiz state is computed by Rust compiled
to WebAssembly.

**There is no application backend and no central source of quiz state.** There is no server, database, WebSocket
or signaling service. Every browser (a _node_) keeps a full copy of the quiz's event log and computes the state
itself. The node that created the quiz has no special role: it can leave, and the others can still finish the quiz.

## Architecture

```
  node (browser tab)                       node (browser tab)
 ┌──────────────────────────────┐         ┌──────────────────────┐
 │ ui.ts       page (DOM)       │         │                      │
 │ main.ts     wiring           │         │    the same code     │
 │ storage.ts  localStorage     │         │                      │
 │ wasm/       QuizEngine (Rust)│         │                      │
 │ peer.ts     WebRTC  ◄────────┼─────────┼──► DataChannel       │
 │ protocol.ts messages, codes  │         │    "p2p-quiz" (JSON) │
 └──────────────────────────────┘         └──────────────────────┘
```

| File              | Responsibility                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `wasm/src/lib.rs` | `QuizEngine`: the event log, Lamport clock, validation and derived quiz state. No networking. |
| `src/peer.ts`     | WebRTC: manual bootstrap, relayed signaling, full mesh, deduplication. No quiz logic.         |
| `src/protocol.ts` | DataChannel message format; invite and response codes and links.                              |
| `src/main.ts`     | Connects engine, network, storage and UI; opens links and hands responses between tabs.       |
| `src/ui.ts`       | Plain DOM rendering, including the QR codes.                                                  |
| `src/storage.ts`  | The event log in `localStorage` under `p2pquiz:<quizId>`.                                     |

Each tab is one node with a random `nodeId` (`crypto.randomUUID()`). The username is only a display name. The quiz
ID is `SHA256(window.location.hostname + "|" + username + "|" + ISO-8601 UTC timestamp)`; the page shows the first
12 hex characters.

## The first link: an invite link and a response link

Two WebRTC peers must exchange an _offer_ and an _answer_ before they can connect. These contain each side's network
addresses (ICE candidates) and encryption fingerprint. Normally a signaling server carries them. Here people do, as
two links:

1. **x** clicks _INVITE ANOTHER PEER_. Its browser creates an `RTCPeerConnection` with a DataChannel named
   `p2p-quiz`, creates the offer, waits until ICE gathering is complete (so all addresses are inside) and shows an
   **invite link** with a QR code: `https://…/p2p-quiz-wasm/#p2pq1:…`, where `p2pq1:` +
   base64url(deflate(`{ version, type: "offer", quizId, nodeId, username, sdp, inviteId }`)) is the code.
2. **y** opens the link (clicks it, or scans the QR code), types a name and clicks _JOIN QUIZ_. Its browser applies the
   offer, creates the answer and shows a **response link** in the same format (`type: "answer"`).
3. **y** sends the response link back, for example in the class chat. **x** opens it: it opens in a new tab, which
   hands it to x's quiz tab, and that tab connects (`setRemoteDescription`). The DataChannel opens.

Each invite link works for one person: press _INVITE ANOTHER PEER_ again for the next one. Pasting a link or a bare
`p2pq1:` code into the text fields works too. A response may be opened minutes after it was made.

Two links are needed because WebRTC needs a round trip: each side must learn the other side's addresses and
fingerprint, and the offer cannot contain an answer that does not exist yet. This is only needed once per new node.

### Which channel carries this without a server?

Only people. A browser cannot listen for incoming connections or find other browsers on a network, so the first
offer and answer must be carried by something outside the app: a link in a chat, a QR code on a screen, copy and
paste. Everything else in this design stays server-free:

- The code sits after the `#` of the link. Browsers never send that part to the web server, so GitHub Pages only
  serves the static files and never sees an invite.
- A response link opens in a new tab, which is not the tab holding the invite. The two tabs talk over a
  `BroadcastChannel`, which connects tabs of the same browser on the same device. The quiz tab that made the
  invite takes the response and answers "accepted".
- One-click joining without the return trip would need an automatic channel, that is a server or public relay that
  both browsers can reach (a signaling server, MQTT or Nostr relays, BitTorrent trackers). This proof-of-concept
  deliberately uses none.

## Every later link: signaling through existing links

Once a node is linked to one node of the quiz, it never needs links again. If x–y are linked and z joins through y:

```
 x ────── y ────── z     1. y sends PEER_LIST to x and z: "I am linked to x and z"
 x ─offer─► y ───► z     2. of x and z, the node with the smaller nodeId creates an offer; y relays it
 x ◄answer─ y ◄─── z     3. the answer and the ICE candidates travel back the same way

        x                4. x and z now have their own DataChannel: a full mesh.
       / \                  If x leaves, y ── z keeps working.
      y───z
```

- When a DataChannel opens, the node sends `PEER_LIST` (its open links) to all its peers.
- For every listed node it has no link to, the node with the smaller `nodeId` starts the negotiation, so exactly
  one side makes the offer.
- Offers, answers and ICE candidates travel in `SIGNAL` messages:
  `{ sourceNodeId, destinationNodeId, payload: { type: "offer" | "answer" | "ice", ... } }`. A node that is not the
  destination forwards the message: straight to the destination if linked to it, otherwise to all its other links.
  Every message has a `messageId`, and `seenMessageIds` drops duplicates, so flooding cannot loop.

The _Debug_ section shows _Relayed signals_: in the example it is above 0 on y only.

## The replicated event log

The quiz state is never sent between nodes. Only events are:

```json
{
  "eventId": "6f1c…",
  "quizId": "a83f91bc2301…",
  "nodeId": "83c19…",
  "username": "z",
  "lamport": 9,
  "type": "ANSWER_SUBMITTED",
  "payload": { "questionId": "q1", "answer": "B" }
}
```

Event types: `QUIZ_CREATED`, `PEER_JOINED`, `QUIZ_STARTED`, `ANSWER_SUBMITTED`, `SHOW_SCOREBOARD`.

- **Creating** an event: Lamport counter + 1, add it to the local log, send it to all peers (`EVENT`).
- **Receiving** an event: ignore it if its `eventId` is known; otherwise apply it in WASM
  (counter = max(local, received) + 1), store it and forward it to the other peers. This is simple gossip.
- **Joining**: every new link starts with `EVENT_LOG_REQUEST` / `EVENT_LOG_RESPONSE` in both directions. A joining
  node gets the complete log from its bootstrap peer, rebuilds the state and then announces itself with
  `PEER_JOINED`.
- **Persistence**: the log is stored in `localStorage` (`p2pquiz:<quizId>`). After a reload the state comes back
  from it. The WebRTC links do not: a connected peer creates a new invite link, and the reloaded node opens it.

DataChannel messages are JSON:
`{ protocol: "p2pquiz", version: 1, type, sender, messageId, payload }` with `type` one of `HELLO`, `EVENT`,
`EVENT_LOG_REQUEST`, `EVENT_LOG_RESPONSE`, `SIGNAL`, `PEER_LIST`. Unknown types are ignored.

## How the WASM engine calculates the state

`QuizEngine` (Rust, `wasm-bindgen`) takes and returns JSON strings: `create`, `join`, `create_event`,
`apply_event`, `merge_events`, `get_state`, `get_events`. It does not know about WebRTC.

`get_state` sorts the log by `(lamport, nodeId, eventId)` and replays it from the beginning:

| Event              | Effect                                                                             |
| ------------------ | ---------------------------------------------------------------------------------- |
| `QUIZ_CREATED`     | the quiz exists (the engine checks `quizId` = SHA256(domain\|username\|timestamp)) |
| `PEER_JOINED`      | adds a participant `{ nodeId, username }`                                          |
| `QUIZ_STARTED`     | `LOBBY` → `QUESTION`                                                               |
| `ANSWER_SUBMITTED` | counts the participant's first answer, only while in `QUESTION`                    |
| `SHOW_SCOREBOARD`  | `QUESTION` → `SCOREBOARD`                                                          |

The same events give the same order, so every node computes the same state no matter in which order the events
arrived. Phases only move forward, so two nodes pressing _SHOW SCOREBOARD_ at the same time still end in
`SCOREBOARD`. The result is `{ quizId, phase, participants, answers, scores, … }`. Answers stay hidden until the
scoreboard. HTTPS scores 1, anything else 0, sorted by score and then username. There is deliberately no consensus
protocol: an answer sent at the same moment as _SHOW SCOREBOARD_ counts only if it sorts before it, and every node
decides that the same way.

## Run locally

Requirements: [Rust](https://rustup.rs) with the WebAssembly target, `wasm-pack`, and Node.js 20.19+ or 22.12+.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run dev     # builds the WASM package and starts Vite on http://localhost:5173
npm test        # Rust unit tests of the quiz engine
```

Open the URL in three windows: three browsers, or private windows, or simply three tabs. Every tab is its own node.
The page needs a secure context (`https://` or `localhost`), because it uses `crypto.randomUUID()`.

### Demo: the creator leaves

1. Window 1: username `x`, _CREATE QUIZ_, _INVITE ANOTHER PEER_, _COPY LINK_.
2. Window 2: open the invite link, username `y`, _JOIN QUIZ_, _COPY LINK_ (the response link).
3. Window 1's browser: open the response link. That tab says "Done" and can be closed; x and y are connected.
4. y invites z the same way (window 3).
5. A moment later x and z are linked through y automatically: _Debug_ shows 2 open DataChannels on every node.
6. Any node presses _START QUESTION_; all three answer.
7. Close window 1 (x) completely.
8. y or z presses _SHOW SCOREBOARD_. Both show the same scoreboard, including x's answer.

With phones: show the invite QR code on a screen, scan it with the phone camera, press _JOIN QUIZ_, and send the
response link back with _SHARE_.

## Build

```sh
npm run build     # -> dist/: index.html, one .js file, one .wasm file
npm run preview   # serve dist/ locally
```

All URLs in `dist/` are relative, so the folder works from any path on any static web host.

## Deploy to GitHub Pages

1. Push the repository to GitHub.
2. In the repository: _Settings → Pages → Build and deployment → Source: GitHub Actions_.
3. `.github/workflows/deploy.yml` builds and publishes `dist/` on every push to `main`. It can also be started by hand
   from the _Actions_ tab.
4. The quiz is then at `https://<user>.github.io/<repository>/`.

## Limitations

- Some NAT/firewall combinations cannot establish direct WebRTC connections without TURN. TURN is intentionally not
  implemented in this proof-of-concept. Windows on one machine and machines on one network normally work. A public
  STUN server (`stun.l.google.com:19302`) helps across simple NATs, but it is not required.
- No reconnection logic: after a reload, links are made again by hand with a new invite link.
- A response link must be opened in the same browser as the quiz tab that made the invite (or pasted into it).
- No authentication: every node is trusted. This is a classroom demo.
- Exactly one hard-coded question.
