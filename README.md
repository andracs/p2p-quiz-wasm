# 🧩 P2P Quiz Wasm

A small proof-of-concept: a quiz that runs as static files (for example on GitHub Pages). Browsers connect directly
to each other with WebRTC DataChannels, and the quiz rules are Rust compiled to WebAssembly. Players join with one
click and answer at their own pace; whoever manages the quiz can follow the progress live, finish it or restart it.

**There is no application backend and no central source of quiz state.** No server, database or WebSocket service
holds the quiz. Every browser (a _node_) keeps a full copy of the quiz's event log and computes the state itself. The
node that created the quiz has no special role: it can leave, and the others carry on.

The only server-side help is optional: a public [ntfy](https://ntfy.sh) relay passes on the very first, encrypted
WebRTC handshake of a new node, so that joining takes one click. Without it, joining works with two links (an invite
and a response) and no server at all.

## Architecture

```
  node (browser tab)                                node (browser tab)
 ┌───────────────────────────────────────┐         ┌──────────────────────┐
 │ ui.ts / play.ts / manage.ts  page     │         │                      │
 │ main.ts      wiring                   │         │    the same code     │
 │ wasm/        QuizEngine (Rust)        │         │                      │
 │ storage.ts   localStorage             │         │                      │
 │ peer.ts      WebRTC  ◄────────────────┼─────────┼──► DataChannel       │
 │ relay.ts     first handshake ◄──┐     │         │    "p2p-quiz" (JSON) │
 └─────────────────────────────────┼─────┘         └──────────────────────┘
                                   └─ ntfy.sh (optional, encrypted, handshake only)
```

| File                     | Responsibility                                                             |
| ------------------------ | -------------------------------------------------------------------------- |
| `wasm/src/lib.rs`        | `QuizEngine`: event log, Lamport clock, validation, replay. No networking. |
| `wasm/src/management.rs` | Quiz management: who is in the quiz, rounds, finish and restart.           |
| `wasm/src/play.rs`       | Playing: answers at your own pace, progress, scores, leaderboard.          |
| `wasm/src/content.rs`    | The questions, and the 256 words that make quiz names.                     |
| `src/peer.ts`            | WebRTC: links, relayed signaling, full mesh, deduplication. No quiz logic. |
| `src/relay.ts`           | One-click joining over ntfy: encryption, knocking, door keepers.           |
| `src/protocol.ts`        | DataChannel messages; invite and response codes and links.                 |
| `src/main.ts`            | Connects engine, network, relay, storage and page.                         |
| `src/ui.ts`              | The page around the quiz: start, joining, header, tabs, debug.             |
| `src/play.ts`            | 🎮 Play: questions, own results, leaderboard.                              |
| `src/manage.ts`          | 🛠️ Manage: join link and QR code, live progress, finish, restart.          |
| `src/dom.ts`             | Small DOM helpers and QR codes.                                            |
| `src/storage.ts`         | The event log in `localStorage` under `p2pquiz:<quizId>`.                  |

Each tab is one node with a random `nodeId` (`crypto.randomUUID()`). The username is only a display name. The quiz
ID is `SHA256(window.location.hostname + "|" + username + "|" + ISO-8601 UTC timestamp)`. People see a name of five
short words instead, made from the first five bytes of that hash, for example “desk brave tiny harp fancy”.

## Management and play are separate

Both in the engine and on the page, the quiz has two independent halves:

- **🛠️ Manage** (`management.rs`, `manage.ts`): invite players, see everybody's progress live, **🏁 finish** the quiz
  (no more answers, everybody sees the final leaderboard), **🔄 restart** it (a new round: everybody answers again).
- **🎮 Play** (`play.rs`, `play.ts`): the quiz is open from the moment it is created. Players join whenever they like
  and answer the questions one by one at their own pace. After their last answer they see their own results and the
  leaderboard, which keeps updating while others play.

Any node may manage, and nobody has to: players finish and see their results without anybody pressing a button.
**🚪 Leave quiz** takes this device out of the quiz.

## Joining with one click (through the relay)

The quiz creator's 🛠️ Manage tab shows a **join link** and its QR code:

```
https://andracs.github.io/p2p-quiz-wasm/#join=p2pquiz-<random topic>.<random key>.<first 10 hex digits of the quiz id>
```

The same link works for any number of people. Opening it and pressing _JOIN QUIZ_ is all a player does:

```
 newcomer              ntfy topic (encrypted)            door keeper (an online node)
    │ ── knock {me} ───────────► │ ────────────────────────────► │
    │ ◄───────────────────────── │ ◄── offer {to: me, invite} ── │   WebRTC offer
    │ ── answer {to, response} ► │ ────────────────────────────► │   WebRTC answer
    │ ◄═════════════ DataChannel, then the usual mesh and event log ════════════► │
```

- **Door keepers**: the two online nodes with the lowest `nodeId`s listen on the topic. The first answers a knock at
  once, the second only if the first stays silent. If the creator leaves, two other nodes take over the door.
- **Encryption**: every relay message is AES-GCM encrypted with the key from the link. That key sits after the `#`,
  which browsers never send to any server, so ntfy only sees a random topic name and ciphertext. The quiz itself never
  touches the relay: after the handshake everything is peer-to-peer, as below.
- **Reload**: a reloaded node keeps its identity, rebuilds its state from `localStorage` and knocks by itself to
  link up again.
- **Choosing the relay**: `?relay=https://your-ntfy.example` uses a self-hosted ntfy (for example on a school
  server), `?relay=off` switches it off. Links keep that setting.

### Why ntfy, and its limits

ntfy is a free publish/subscribe service that browsers can use directly: it allows cross-origin requests, delivers
messages instantly with server-sent events, and takes messages up to 4 KB (a handshake is about 1 KB). A JSON storage
service such as jsonblob.com could hold a handshake too, but browsers would have to poll it, and simultaneous joiners
would overwrite each other. The public ntfy.sh limits anonymous use **per IP address**: about 60 requests at once,
then one every 5 to 10 seconds, and 30 subscriptions. A whole class behind one school internet connection shares
that. A one-click join costs about five requests, so a class can join within a few minutes; a self-hosted ntfy has
no such limits.

## Joining without any server: two links

🛠️ Manage → _✉️ Invite without the relay_ makes an **invite link** for one person, with the WebRTC offer inside:
`https://…/#p2pq1:…` (`p2pq1:` + base64url(deflate(`{ version, type: "offer", quizId, nodeId, username, sdp,
inviteId }`))). The new player opens it and presses _JOIN QUIZ_; their browser creates the answer and shows a
**response link**. They send it back (chat, mail, QR code), and the inviter opens it in the same browser. That opens
a new tab, which hands the code to the quiz tab over a `BroadcastChannel` (a channel between tabs of one browser),
and the quiz tab connects. Pasting either link into the text fields works too.

Two links are needed because WebRTC needs a round trip: each side must learn the other side's addresses and
encryption fingerprint. A browser cannot listen for incoming connections or find other browsers on a network, so
without a relay, people carry the two links. A response may be opened minutes after it was made.

## Every later link: signaling through existing links

Once a node is linked to one node of the quiz, everything else happens peer-to-peer. If x–y are linked and z joins
through y:

```
 x ────── y ────── z     1. y sends PEER_LIST to x and z: "I am linked to x and z"
 x ─offer─► y ───► z     2. of x and z, the node with the smaller nodeId creates an offer; y relays it
 x ◄answer─ y ◄─── z     3. the answer and the ICE candidates travel back the same way

        x                4. x and z now have their own DataChannel: a full mesh.
       / \                  If x leaves, y ── z keeps working.
      y───z
```

Offers, answers and ICE candidates travel in `SIGNAL` messages
(`{ sourceNodeId, destinationNodeId, payload: { type: "offer" | "answer" | "ice", ... } }`), straight to the
destination if linked to it, otherwise flooded to all other links. Every message has a `messageId`, and
`seenMessageIds` drops duplicates, so flooding cannot loop. _🐞 Debug_ shows how many signals a node relayed.

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
  "payload": { "round": 1, "questionId": "q2", "answer": "A" }
}
```

| Event              | Half       | Effect                                                                     |
| ------------------ | ---------- | -------------------------------------------------------------------------- |
| `QUIZ_CREATED`     | management | the quiz exists and is open; carries the relay topic and key               |
| `PEER_JOINED`      | management | a node is in the quiz                                                      |
| `QUIZ_FINISHED`    | management | closes the current round: no more answers, final leaderboard for everybody |
| `QUIZ_RESTARTED`   | management | opens the next round: everybody starts again at question 1                 |
| `ANSWER_SUBMITTED` | play       | the first answer of a node to a question, in the current round, while open |

- **Creating** an event: Lamport counter + 1, add it to the local log, send it to all peers (`EVENT`).
- **Receiving** an event: ignore it if its `eventId` is known; otherwise apply it in WASM
  (counter = max(local, received) + 1), store it and forward it to the other peers. This is simple gossip.
- **Joining**: every new link starts with `EVENT_LOG_REQUEST` / `EVENT_LOG_RESPONSE` in both directions, so a
  newcomer gets the complete log and both sides catch up.
- **Persistence**: the log is stored in `localStorage` (`p2pquiz:<quizId>`), so a reload rebuilds the state.

DataChannel messages are JSON: `{ protocol: "p2pquiz", version: 1, type, sender, messageId, payload }` with `type`
one of `HELLO`, `EVENT`, `EVENT_LOG_REQUEST`, `EVENT_LOG_RESPONSE`, `SIGNAL`, `PEER_LIST`. Unknown types are ignored.

## How the WASM engine calculates the state

`QuizEngine` (Rust, `wasm-bindgen`) takes and returns JSON strings: `create`, `join`, `create_event`, `apply_event`,
`merge_events`, `get_state`, `get_events`. It does not know about WebRTC.

`get_state` sorts the log by `(lamport, nodeId, eventId)` and replays it from the beginning, first through the
management half (`Lifecycle`), then through the play half (`Answers`). It returns `{ quiz, manage, play }`:

- `quiz`: name, round, status (`OPEN` or `FINISHED`), participants.
- `manage`: everybody's progress and score, live; individual answers only once the round is finished.
- `play`: for this node, the next question, and once it answered everything (or the round is finished) its score,
  its results and the leaderboard.

The same events give the same order, so every node computes the same state no matter in which order the events
arrived. Rounds only go up, and a round only goes from `OPEN` to `FINISHED`. So if two nodes press _FINISH_ or
_RESTART_ at the same moment, every node still ends in the same state. There is deliberately no consensus protocol:
an answer sent at the same moment as _FINISH_ counts only if it sorts before it, and every node decides that the same
way. The questions are in `wasm/src/content.rs`.

## Run locally

Requirements: [Rust](https://rustup.rs) with the WebAssembly target, `wasm-pack`, and Node.js 20.19+ or 22.12+.

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install
npm run dev     # builds the WASM package and starts Vite on http://localhost:5173
npm test        # Rust unit tests of the quiz engine
```

Open the URL in several windows: different browsers, private windows, or simply tabs (every tab is its own node).
The page needs a secure context (`https://` or `localhost`), because it uses `crypto.randomUUID()` and WebCrypto.

### Demo: the creator leaves

1. Window 1: your name, _✨ CREATE QUIZ_. 🛠️ Manage shows the join link and QR code.
2. Windows 2 and 3 (or phones scanning the QR code): open the link, type a name, _🚀 JOIN QUIZ_. They land on
   🎮 Play and answer at their own pace; window 1 sees their progress under 👥 Players.
3. Window 1: _🚪 LEAVE QUIZ_. A fourth player can still join with the same link.
4. Anybody: 🛠️ Manage → _🏁 FINISH QUIZ_. Everybody sees the same final leaderboard; tap a row for the answers.
5. _🔄 RESTART_ starts round 2.

## Build

```sh
npm run build     # -> dist/: index.html, one .js file, one .wasm file
npm run preview   # serve dist/ locally
```

All URLs in `dist/` are relative, so the folder works from any path on any static web host.

## Deploy to GitHub Pages

1. Push the repository to GitHub.
2. In the repository: _Settings → Pages → Build and deployment → Source: GitHub Actions_.
3. `.github/workflows/deploy.yml` runs the Rust tests and publishes `dist/` on every push to `main`. It can also be
   started by hand from the _Actions_ tab.
4. The quiz is then at `https://<user>.github.io/<repository>/`.

## Limitations

- Some NAT/firewall combinations cannot establish direct WebRTC connections without TURN. TURN is intentionally not
  implemented in this proof-of-concept. Windows on one machine and machines on one network normally work. A public
  STUN server (`stun.l.google.com:19302`) helps across simple NATs, but it is not required.
- One-click joining needs the relay and at least one node of the quiz online. School networks may block ntfy.sh; the
  two-link invite always works.
- No authentication: every node is trusted, and any node can finish or restart the quiz. This is a classroom demo.
- The five questions are compiled into the WASM engine (`wasm/src/content.rs`).
