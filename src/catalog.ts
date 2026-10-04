// The quizzes on the start screen: copies of the published quizzes of
// https://github.com/andracs/cyber-quizzer (npm run quizzes), bundled into the page.
// Only the node that creates a quiz needs them: the quiz itself travels inside the
// QUIZ_CREATED event, so every node plays exactly the same questions.

import { checkQuiz } from "../wasm/pkg/p2p_quiz_wasm.js";

export interface CatalogQuiz {
  /** The file name in quizzes/, e.g. "pentest". */
  slug: string;
  title: string;
  emoji: string | null;
  subject: string | null;
  questionCount: number;
  /** Identifies the questions, like `quiz.contentId` in the state. */
  contentId: string;
  /** The quiz itself (cyber-quizzer format), as the engine takes it. */
  quiz: unknown;
}

const files = import.meta.glob<unknown>("../quizzes/*.json", { eager: true, import: "default" });
let catalog: CatalogQuiz[] | null = null;

/** Needs the WASM engine, so call it after init(). A quiz the engine cannot read is left out. */
export function quizzes(): CatalogQuiz[] {
  catalog ??= Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([path, quiz]) => {
      try {
        const slug = path.replace(/^.*\/|\.json$/g, "");
        return [{ slug, ...JSON.parse(checkQuiz(JSON.stringify(quiz))) }];
      } catch (error) {
        console.warn(`left out ${path}:`, error);
        return [];
      }
    });
  return catalog;
}

export function findQuiz(slug: string): CatalogQuiz {
  const found = quizzes().find((q) => q.slug === slug);
  if (!found) throw new Error("Pick a quiz first.");
  return found;
}

/** "🕵️ Tænk som en hacker" */
export function quizTitle(quiz: { emoji: string | null; title: string | null }): string {
  return `${quiz.emoji ?? "📝"} ${quiz.title ?? "Quiz"}`;
}
