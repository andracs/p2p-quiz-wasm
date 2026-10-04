# 🧩 P2P Quiz Wasm

A quiz that runs as static files on GitHub Pages. Browsers connect directly to each other with WebRTC, and the quiz
rules are Rust compiled to WebAssembly. It plays the quizzes of
[cyber-quizzer](https://github.com/andracs/cyber-quizzer).

**There is no application backend and no central source of quiz state.** Every browser keeps its own copy of the quiz
and works out the state itself. Whoever created the quiz can leave; the others carry on.

▶️ **https://andracs.github.io/p2p-quiz-wasm/**

## 🎮 How to use

1. **Create:** type your name, pick a quiz and press _✨ CREATE QUIZ_. You land on 🛠️ Manage.
2. **Invite:** show the QR code or share the join link. Whoever opens it types a name and presses _🚀 JOIN QUIZ_. One
   link works for everybody.
3. **Play (🎮):** one question at a time, at your own pace. After each answer you see whether it was right, and why.
   At the end you get your score, every question to look at again, and a live leaderboard.
4. **Manage (🛠️, anybody can):** see who is online, everybody's answers (✅ ❌ ➖) and which questions were hard.
   _🏁 FINISH QUIZ_ closes the quiz for everybody. _🔄 START A NEW ROUND_ starts again with the same quiz or another
   one, and nobody has to join again.

- Latecomers and reloaded pages catch up by themselves. _🚪 LEAVE QUIZ_ takes this device out of the quiz.
- If the network blocks the relay: 🛠️ Manage → _✉️ Invite without the relay_ makes an invite link for one person, who
  sends a response link back.
- _🐞 Debug_ shows this node, its links (with their ICE state) and the event log.

## ⚙️ How this works

**The first link.** Before two browsers can talk, WebRTC needs one round trip: an _offer_ and an _answer_ with each
side's network addresses and keys. Browsers cannot find each other on their own, so that first exchange needs a
carrier:

- **One click, through a relay.** The join link holds a random topic on the public [ntfy](https://ntfy.sh) relay and an
  AES key, after the `#`, which browsers never send to any server. The newcomer knocks on the topic, one of the two
  online nodes with the lowest `nodeId` answers with an offer, and the newcomer sends its answer back. The messages
  are compressed, encrypted and split to stay under ntfy's 4 KB limit, so ntfy only sees a random topic and
  ciphertext. It carries nothing else.
- **Two links, no server at all.** The invite link carries the offer and the response link carries the answer
  (`#p2pq1:` + base64url(deflate(JSON))). A response link opened in a new tab is handed to the quiz tab over a
  `BroadcastChannel`.

**Every later link** is set up peer-to-peer. Nodes send each other `PEER_LIST`s and relay WebRTC `SIGNAL`s (offer,
answer, ICE candidates) through the links that exist, until every node is linked to every other: a full mesh. Each
message has a `messageId` and duplicates are dropped, so relaying never loops.

**The replicated event log.** Nodes never send the quiz state, only events: `QUIZ_CREATED` (with the quiz itself),
`PEER_JOINED`, `ANSWER_SUBMITTED`, `QUIZ_FINISHED` and `QUIZ_RESTARTED` (perhaps with another quiz). Each event has an
`eventId` and a Lamport timestamp. A new event goes to all links. A node that receives an event it does not know yet
applies it, stores it in `localStorage` and passes it on. Every new link starts with both sides exchanging their whole
log (in parts when it is long), which is how latecomers and reloaded pages catch up.

**The WASM engine** (`wasm/src/`) sorts the log by `(lamport, nodeId, eventId)` and replays it, first through the
management half (`management.rs`: who is in, rounds, finish, restart), then through the play half (`play.rs`: the
first answer to each question counts, scores, leaderboard). The same events give the same order, so every node
computes the same state without any consensus protocol: rounds only go up, a round only goes from open to finished,
and an answer names the round and the questions it belongs to. The engine grades answers as cyber-quizzer does
(`content.rs`): multiple choice, true/false, ordering (right only if every item is in place) and estimates (at most
15 % off, or within the quiz's tolerance). The quiz ID is SHA-256(hostname | creator | timestamp); people see five
short words made from it.

**The quizzes** are copies of the quizzes published by cyber-quizzer, in its JSON format, in `quizzes/`. The quiz
itself travels in the event log (in `QUIZ_CREATED`, or in `QUIZ_RESTARTED` for another quiz), so everybody plays the
same questions, whichever version of the page they loaded.

The page code is in `src/`: `peer.ts` (WebRTC mesh), `relay.ts` (one-click joining), `main.ts` (wiring), `ui.ts`,
`play.ts` and `manage.ts` (the page).

## 🛠️ Development

```sh
rustup target add wasm32-unknown-unknown && cargo install wasm-pack
npm install
npm run dev       # WASM + Vite on http://localhost:5173; every tab is its own node
npm test          # Rust tests of the engine
npm run build     # dist/: static files with relative URLs, for any web host
npm run quizzes   # fetch the newest quizzes from cyber-quizzer into quizzes/
```

**Deploy:** in the GitHub repository, choose _Settings → Pages → Source: GitHub Actions_.
`.github/workflows/deploy.yml` fetches the newest quizzes, runs the tests and publishes `dist/` on every push to `main`.
After a change in cyber-quizzer, start it by hand: _Actions → Deploy to GitHub Pages → Run workflow_.

## ⚠️ Limitations

- Some NAT/firewall combinations cannot establish direct WebRTC connections without TURN. TURN is intentionally not
  implemented in this proof-of-concept. One machine or one network normally works; a public STUN server helps across
  simple NATs.
- One-click joining needs ntfy.sh, which limits anonymous use per IP address (a class behind one school connection
  shares that), and somebody in the quiz online. `?relay=https://…` uses a self-hosted ntfy, `?relay=off` none.
- No authentication: every node is trusted, anybody can finish or restart, and the answers are in the event log for
  anyone who looks. This is a classroom demo.
