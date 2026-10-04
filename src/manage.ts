// The management half of the page: invite players, follow their progress and see which
// questions were hard (live), finish the quiz, or start a new round with the same or
// another quiz. Any node may manage; nobody has to, because players can finish the quiz
// and see their results on their own.

import { quizTitle, quizzes } from "./catalog";
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
    const slug = $<HTMLSelectElement>("next-quiz").value || null;
    const quiz = quizzes().find((q) => q.slug === slug);
    const what = quiz ? ` with “${quizTitle(quiz)}”` : "";
    if (confirm(`🔄 Start a new round${what}? Everybody starts again from the first question.`)) a.restart(slug);
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
    return { name: `${p.rank}. ${p.username}`, online, progress, score: `⭐ ${p.score}`, marks: p.marks };
  });
  update("players", rows, () =>
    rows.map((r) => {
      const line = el("div", el("span", `${r.online} ${r.name}`), el("span", `${r.progress} · ${r.score}`));
      const marks = el("div", r.marks);
      marks.className = "marks";
      return el("li", line, marks);
    }),
  );
  $("answer-total").textContent = `📨 ${manage.answerCount} answers in round ${quiz.round}`;

  // Which questions were hard: right answers out of all answers, per question.
  update("question-stats", manage.questions, () =>
    manage.questions.map((q) => {
      const result = q.answered === 0 ? "–" : `✅ ${q.correct}/${q.answered}`;
      return el("li", el("span", `${q.number}. ${q.emoji ? `${q.emoji} ` : ""}${q.title}`), el("span", result));
    }),
  );

  $("quiz-status").textContent =
    quiz.status === "OPEN"
      ? `🟢 Open for answers (round ${quiz.round})${quiz.round > 1 ? `, restarted by ${quiz.changedBy}` : ""}`
      : `🏁 Finished by ${quiz.changedBy}. Everybody can see the final leaderboard under 🎮 Play.`;
  $("finish").hidden = quiz.status !== "OPEN";

  // The new round: the same questions again, or another quiz.
  update("next-quiz", quiz.contentId, () => [
    option("", "🔁 The same quiz again"),
    ...quizzes()
      .filter((q) => q.contentId !== quiz.contentId)
      .map((q) => option(q.slug, quizTitle(q))),
  ]);
}

function option(value: string, text: string): HTMLOptionElement {
  const option = el("option", text);
  option.value = value;
  return option;
}
