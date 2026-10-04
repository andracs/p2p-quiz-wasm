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
| `src/protocol.ts` | DataChannel message format; invite and response codes.                                        |
| `src/main.ts`     | Connects engine, network, storage and UI.                                                     |
| `src/ui.ts`       | Plain DOM rendering.                                                                          |
| `src/storage.ts`  | The event log in `localStorage` under `p2pquiz:<quizId>`.                                     |

Each tab is one node with a random `nodeId` (`crypto.randomUUID()`). The username is only a display name. The quiz
ID is `SHA256(window.location.hostname + "|" + username + "|" + ISO-8601 UTC timestamp)`; the page shows the first
12 hex characters.

## The first link: invite code and response code

Two WebRTC peers must exchange an _offer_ and an _answer_ before they can connect. These contain each side's network
addresses (ICE candidates) and encryption fingerprint. Normally a signaling server carries them. Here a human does:

1. **x** clicks _INVITE ANOTHER PEER_. Its browser creates an `RTCPeerConnection` with a DataChannel named
   `p2p-quiz`, creates the offer, waits until ICE gathering is complete (so all addresses are inside) and shows it as
   an invite code: `p2pq1:` + base64url(deflate(`{ version, type: "offer", quizId, nodeId, username, sdp, inviteId }`)).
2. **y** pastes it and clicks _JOIN QUIZ_. Its browser applies the offer, creates the answer, waits for ICE gathering
   and shows a response code in the same format (`type: "answer"`).
3. **x** pastes the response code and clicks _CONNECT_ (`setRemoteDescription`). The DataChannel opens.

Two codes are needed because WebRTC needs a round trip: each side must learn the other side's addresses and
fingerprint, and the offer cannot contain an answer that does not exist yet. Without a server, copy and paste (chat,
e-mail, a shared screen) is the signaling channel. This is only needed once per new node.

## Every later link: signaling through existing links

Once a node is linked to one node of the quiz, it never needs copy and paste again. If x–y are linked and z joins
through y:

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
  from it. The WebRTC links do not: a connected peer creates a new invite code, and the reloaded node pastes it.

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

1. Window 1: username `x`, _CREATE QUIZ_, _INVITE ANOTHER PEER_, _COPY_.
2. Window 2: username `y`, paste the invite code, _JOIN QUIZ_, _COPY_ the response code.
3. Window 1: paste the response code, _CONNECT_.
4. Window 2 invites window 3 (username `z`) the same way.
5. A moment later x and z are linked through y automatically: _Debug_ shows 2 open DataChannels on every node.
6. Any node presses _START QUESTION_; all three answer.
7. Close window 1 (x) completely.
8. y or z presses _SHOW SCOREBOARD_. Both show the same scoreboard, including x's answer.

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
- No reconnection logic: after a reload, links are made again by hand with a new invite code.
- No authentication: every node is trusted. This is a classroom demo.
- Exactly one hard-coded question.
