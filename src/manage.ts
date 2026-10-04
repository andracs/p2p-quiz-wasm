// The management half of the page: invite players, follow their progress live, and
// finish or restart the quiz. Any node may manage; nobody has to, because players
// can finish the quiz and see their results on their own.

import { $, copyField, el, field, hideShareIfUnsupported, onClick, share, showLink, update } from "./dom";
import type { Actions, View } from "./ui";

// The manual invite on screen (one person, no relay).
let invite: { inviteId: string; link: string } | null = null;

export function bindManage(a: Actions): void {
  onClick("copy-join", () => copyField("join-link", "copy-join"));
  onClick("share-join", () => share(field("join-link").value));
  onClick(
    "invite",
    async () => {
      invite = await a.invite();
      field("response-input").value = "";
    },
    "⏳ CREATING INVITE…",
  );
  onClick("copy-invite", () => copyField("invite-link", "copy-invite"));
  onClick("share-invite", () => share(field("invite-link").value));
  onClick("connect", async () => {
    await a.connect(field("response-input").value);
    field("response-input").value = "";
  });
  onClick("finish", () => {
    if (confirm("🏁 Finish the quiz for everybody? Nobody can answer after that.")) a.finish();
  });
  onClick("restart", () => {
    if (confirm("🔄 Start a new round? Everybody answers again from the first question.")) a.restart();
  });
  hideShareIfUnsupported("share-join", "share-invite");
}

export function renderManage({ session, state, peers, openInvites, joinLink }: View): void {
  const { quiz, manage } = state;

  $("join-box").hidden = joinLink === null;
  $("no-relay").hidden = joinLink !== null;
  if (joinLink) showLink("join", joinLink);

  if (invite && !openInvites.includes(invite.inviteId)) invite = null; // answered
  $("invite-panel").hidden = invite === null;
  if (invite) showLink("invite", invite.link);

  const linkState = new Map(peers.map((p) => [p.nodeId, p.state]));
  const rows = manage.players.map((p) => {
    const link = linkState.get(p.nodeId);
    const online = p.nodeId === session.nodeId ? "👤" : link === "OPEN" ? "🟢" : link === "CONNECTING" ? "🟡" : "⚪";
    const progress = p.finished
      ? "✅ done"
      : p.answered === 0
        ? "👀 not started"
        : `📝 ${p.answered}/${quiz.questionCount}`;
    return { name: `${p.rank}. ${p.username}`, online, progress, score: `⭐ ${p.score}` };
  });
  update("players", rows, () =>
    rows.map((r) => el("li", el("span", `${r.online} ${r.name}`), el("span", `${r.progress} · ${r.score}`))),
  );
  $("answer-total").textContent = `📨 ${manage.answerCount} answers in round ${quiz.round}`;

  $("quiz-status").textContent =
    quiz.status === "OPEN"
      ? `🟢 Open for answers (round ${quiz.round})${quiz.round > 1 ? `, restarted by ${quiz.changedBy}` : ""}`
      : `🏁 Finished by ${quiz.changedBy}. Everybody can see the final leaderboard under 🎮 Play.`;
  $("finish").hidden = quiz.status !== "OPEN";
}
