// The play half of the page: one question at a time, at your own pace. Right after each
// answer you see whether it was right, and why, as on the cyber-quizzer pages. At the end:
// your result, with every question to look at again. The leaderboard is live.

import { $, attempt, el, onClick, rich, update } from "./dom";
import type { Actions, QuestionView, ResultView, ScoreRow, View } from "./ui";

const COLORS = ["🔴", "🔵", "🟡", "🟢", "🟣", "🟠"];
const PLACES = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const MEDALS = ["🥇", "🥈", "🥉"];
// The second half of a double click must not answer the next question, or skip an explanation.
const CLICK_GUARD_MS = 400;

let actions: Actions | null = null;
/** The question just answered: its explanation stays on screen until NEXT. */
let reviewing: { round: string; index: number; since: number } | null = null;

export function bindPlay(a: Actions): void {
  actions = a;
  onClick("next-question", () => {
    if (reviewing && Date.now() - reviewing.since >= CLICK_GUARD_MS) reviewing = null;
  });
}

export function renderPlay({ state }: View): void {
  const { quiz, play } = state;
  const round = `${quiz.round}|${quiz.contentId}`;
  if (reviewing?.round !== round) reviewing = null; // a new round
  const feedback = play.results.find((r) => r.index === reviewing?.index) ?? null;
  const question = feedback ? null : play.question;

  const shown = feedback ?? question;
  $("play-question").hidden = shown === null;
  if (shown) {
    const section = shown.section ? ` · ${shown.section}` : "";
    $("question-progress").textContent = `❓ Question ${shown.number} of ${quiz.questionCount}${section}`;
    $("question-emoji").textContent = shown.emoji ?? "";
    $("question-emoji").hidden = !shown.emoji;
    update("question-text", shown.text, () => rich(shown.text));
  }
  $("answer-area").hidden = question === null;
  if (question) update("answer-area", [round, question.index], () => answerArea(question, round));
  $("feedback").hidden = feedback === null;
  if (feedback) {
    const estimate = feedback.kind === "estimate";
    $("verdict").textContent = feedback.correct
      ? estimate
        ? "✅ Close enough!"
        : "✅ Right!"
      : estimate
        ? "❌ Not close enough."
        : "❌ Not quite.";
    update("feedback-answers", feedback, () => answerLines(feedback));
    update("explanation", feedback.explanation, () => (feedback.explanation ? rich(`💡 ${feedback.explanation}`) : []));
    $("next-question").textContent = play.question ? "➡️ NEXT QUESTION" : "🏁 SEE MY RESULT";
  }

  const done = play.question === null && quiz.questionCount > 0;
  $("play-result").hidden = shown !== null || !done;
  if (done) {
    const share = play.score / quiz.questionCount;
    const face = share === 1 ? "🏆" : share >= 0.8 ? "🎉" : share >= 0.5 ? "🙂" : "🤔";
    $("score-title").textContent = `${face} ${play.score} of ${quiz.questionCount} right`;
    $("review-hint").hidden = play.results.length === 0;
    update("my-results", play.results, () => play.results.map(reviewItem));
  }

  $("play-note").textContent =
    quiz.status === "FINISHED"
      ? `🏁 ${quiz.changedBy ?? "Someone"} finished the quiz.`
      : play.finished
        ? "⏳ Others may still be playing: the leaderboard updates live."
        : `📝 ${play.answered} of ${quiz.questionCount} answered. Take your time.`;

  $("leaderboard-box").hidden = play.leaderboard.length === 0;
  update("scores", play.leaderboard, () => play.leaderboard.map((row) => scoreRow(row, quiz.questionCount)));
}

/** The buttons, list or slider for one question. Built once per question, so a half-done answer survives redraws. */
function answerArea(q: QuestionView, round: string): Node[] {
  const shownAt = Date.now();
  const send = (answer: unknown) => {
    if (Date.now() - shownAt < CLICK_GUARD_MS) return;
    void attempt(() => {
      actions?.answer(q.index, answer);
      reviewing = { round, index: q.index, since: Date.now() };
    });
  };
  switch (q.kind) {
    case "choice":
      return q.options.map((option, i) => button(`${COLORS[i % COLORS.length]} `, option.label, () => send(option.id)));
    case "truefalse":
      return [button("👍 ", "TRUE", () => send(true)), button("👎 ", "FALSE", () => send(false))];
    case "order":
      return orderArea(q, send);
    case "estimate":
      return estimateArea(q, send);
  }
}

function button(prefix: string, label: string, onPress: () => void): HTMLButtonElement {
  const b = el("button", prefix, ...rich(label));
  b.addEventListener("click", onPress);
  return b;
}

/** Tap the items in the right order; tapping a placed item again takes it (and the ones after it) back. */
function orderArea(q: QuestionView, send: (answer: number[]) => void): Node[] {
  const picked: number[] = [];
  const list = el("ol");
  const check = button("✅ ", "CHECK THE ORDER", () => send([...picked]));
  const reset = button("↩️ ", "START OVER", () => {
    picked.length = 0;
    draw();
  });
  const draw = () => {
    list.replaceChildren(
      ...q.options.map((item) => {
        const place = picked.indexOf(item.id);
        const b = button(`${PLACES[place] ?? "⬜"} `, item.label, () => {
          if (place >= 0) picked.splice(place);
          else picked.push(item.id);
          draw();
        });
        b.setAttribute("aria-pressed", String(place >= 0));
        return el("li", b);
      }),
    );
    check.disabled = picked.length !== q.options.length;
  };
  draw();
  return [el("p", "👆 Tap them in the right order. Tap one again to undo."), list, check, reset];
}

function estimateArea(q: QuestionView, send: (answer: number) => void): Node[] {
  const e = q.estimate!;
  let value = e.start;
  const output = el("output");
  output.className = "guess";
  const range = el("input");
  Object.assign(range, { type: "range", min: String(e.min), max: String(e.max), step: String(e.step) });
  range.setAttribute("aria-label", "Your guess");
  const set = (x: number) => {
    value = Math.min(e.max, Math.max(e.min, Math.round(x / e.step) * e.step));
    range.value = String(value);
    output.textContent = `${formatNumber(value, e.year)} ${e.unit}`.trim();
  };
  range.addEventListener("input", () => set(Number(range.value)));
  set(value);
  const ends = el("p", el("span", formatNumber(e.min, e.year)), el("span", formatNumber(e.max, e.year)));
  ends.className = "ends muted";
  const steps = el(
    "div",
    button("", "➖", () => set(value - e.step)),
    button("", "➕", () => set(value + e.step)),
  );
  steps.className = "pair";
  return [output, range, ends, steps, button("✅ ", "CHECK MY GUESS", () => send(value))];
}

/** As on the Danish cyber-quizzer pages: 45.000 and 2,5; a year stays 1992. */
function formatNumber(value: number, year: boolean): string {
  return year ? String(Math.round(value)) : value.toLocaleString("da-DK", { maximumFractionDigits: 3 });
}

function answerLines(r: ResultView): Node[] {
  const lines = [el("p", `🙋 Your answer: ${r.answer}`)];
  // An estimate is never exactly right, so it always shows the right number.
  if (!r.correct || r.kind === "estimate") lines.push(el("p", `🎯 Right answer: ${r.rightAnswer}`));
  if (r.detail) lines.push(el("p", `📏 ${r.detail}`));
  return lines;
}

function reviewItem(r: ResultView): HTMLLIElement {
  const details = el("details");
  details.append(
    el("summary", `${r.correct ? "✅" : "❌"} ${r.number}. ${r.emoji ? `${r.emoji} ` : ""}${r.title}`),
    el("p", ...rich(r.text)),
    ...answerLines(r),
  );
  if (r.explanation) details.append(el("p", "💡 ", ...rich(r.explanation)));
  return el("li", details);
}

function scoreRow(row: ScoreRow, total: number): HTMLLIElement {
  const place = MEDALS[row.rank - 1] ?? `${row.rank}.`;
  const progress = row.finished ? "" : ` ⏳ ${row.answered}/${total}`;
  return el("li", el("span", `${place} ${row.username}${progress}`), el("span", `⭐ ${row.score}`));
}
