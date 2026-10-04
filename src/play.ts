// The play half of the page: answer the questions at your own pace, then see your
// own results and the leaderboard. Nobody waits for anybody.

import { $, attempt, el, update } from "./dom";
import type { Actions, ScoreRow, View } from "./ui";

const COLORS = ["🔴", "🔵", "🟡", "🟢"];
const MEDALS = ["🥇", "🥈", "🥉"];
const expanded = new Set<string>();
let actions: Actions | null = null;

export function bindPlay(a: Actions): void {
  actions = a;
}

export function renderPlay({ state }: View): void {
  const { quiz, play } = state;
  const question = play.question;

  $("play-question").hidden = question === null;
  if (question) {
    $("question-progress").textContent = `❓ Question ${question.number} of ${quiz.questionCount}`;
    $("question-text").textContent = question.text;
    update("options", [quiz.round, question.id], () => {
      const shownAt = Date.now();
      return question.options.map((option, i) => {
        const button = el("button", `${COLORS[i]} ${option.label}`);
        button.addEventListener("click", () => {
          if (Date.now() - shownAt < 400) return; // the second half of a double click on the previous question
          void attempt(() => actions?.answer(question.id, option.key));
        });
        return button;
      });
    });
  }

  $("play-result").hidden = play.score === null;
  if (play.score !== null) {
    const cheer = play.score === quiz.questionCount ? "🏆" : play.score * 2 >= quiz.questionCount ? "🎉" : "💪";
    $("score-title").textContent = `${cheer} You scored ${play.score} / ${quiz.questionCount}`;
    update("my-results", play.results, () =>
      play.results.map((r) =>
        el(
          "li",
          el("span", `${r.correct ? "✅" : r.answer ? "❌" : "➖"} ${r.question}`),
          el("span", r.correct ? r.correctAnswer : `you: ${r.answer ?? "–"} · right: ${r.correctAnswer}`),
        ),
      ),
    );
  }

  $("play-note").textContent =
    quiz.status === "FINISHED"
      ? `🏁 ${quiz.changedBy ?? "Someone"} finished the quiz.`
      : play.finished
        ? "⏳ Others may still be playing: the leaderboard updates live."
        : `📝 ${play.answered} of ${quiz.questionCount} answered. Take your time.`;

  $("leaderboard-box").hidden = play.leaderboard.length === 0;
  update("scores", [play.leaderboard, [...expanded]], () =>
    play.leaderboard.map((row) => scoreRow(row, quiz.questionCount)),
  );
}

function scoreRow(row: ScoreRow, total: number): HTMLLIElement {
  const open = expanded.has(row.nodeId);
  const place = MEDALS[row.rank - 1] ?? `${row.rank}.`;
  const status = row.finished ? "" : ` ⏳ ${row.answered}/${total}`;
  const button = el("button", el("span", `${place} ${row.username}${status}`), el("span", `⭐ ${row.score}`));
  button.className = "score-row";
  button.setAttribute("aria-expanded", String(open));
  button.addEventListener("click", () =>
    attempt(() => {
      if (!expanded.delete(row.nodeId)) expanded.add(row.nodeId);
    }),
  );
  const item = el("li", button);
  if (open) {
    const details = el(
      "ul",
      ...row.results.map((r) =>
        el("li", `${r.correct ? "✅" : r.answer ? "❌" : "➖"} ${r.question} ${r.answer ?? "–"}`),
      ),
    );
    details.className = "details";
    item.append(details);
  }
  return item;
}
