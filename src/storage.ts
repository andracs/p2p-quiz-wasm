// Local persistence.
// - The replicated event log lives in localStorage under "p2pquiz:<quizId>".
// - This tab's identity lives in sessionStorage, so a reload resumes as the
//   same node, while other tabs of the same browser stay separate nodes.
// - The last username and quiz used live in localStorage ("p2pquiz:username", "p2pquiz:choice").
// - Logs carry the questions, so only the logs of the last few quizzes are kept.

import type { QuizEvent } from "./protocol";

export interface Session {
  quizId: string;
  nodeId: string;
  username: string;
}

const SESSION_KEY = "p2pquiz:session";
const USERNAME_KEY = "p2pquiz:username";
const CHOICE_KEY = "p2pquiz:choice";
const RECENT_KEY = "p2pquiz:recent";
const KEEP_LOGS = 5;
const logKey = (quizId: string) => `p2pquiz:${quizId}`;

export function saveEvents(quizId: string, events: QuizEvent[]): void {
  // Other tabs of this browser may be nodes in the same quiz: keep their events too.
  const log = new Map(loadEvents(quizId).map((event) => [event.eventId, event]));
  for (const event of events) log.set(event.eventId, event);
  write(localStorage, logKey(quizId), [...log.values()]);
  forgetOldQuizzes(quizId);
}

function forgetOldQuizzes(quizId: string): void {
  const earlier = (read<string[]>(localStorage, RECENT_KEY) ?? []).filter((id) => id !== quizId);
  const recent = [quizId, ...earlier].slice(0, KEEP_LOGS);
  write(localStorage, RECENT_KEY, recent);
  try {
    for (const key of Object.keys(localStorage)) {
      const id = /^p2pquiz:([0-9a-f]{64})$/.exec(key)?.[1];
      if (id && !recent.includes(id)) localStorage.removeItem(key);
    }
  } catch (error) {
    console.warn("could not clean up old quizzes", error);
  }
}

export function loadEvents(quizId: string): QuizEvent[] {
  return read<QuizEvent[]>(localStorage, logKey(quizId)) ?? [];
}

export function saveSession(session: Session): void {
  write(sessionStorage, SESSION_KEY, session);
}

export function loadSession(): Session | null {
  return read<Session>(sessionStorage, SESSION_KEY);
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

/** The last username used in this browser, so that opening an invite link is nearly enough to join. */
export function saveUsername(username: string): void {
  write(localStorage, USERNAME_KEY, username);
}

export function loadUsername(): string {
  return read<string>(localStorage, USERNAME_KEY) ?? "";
}

/** The quiz picked last on the start screen (its file name in quizzes/). */
export function saveQuizChoice(slug: string): void {
  write(localStorage, CHOICE_KEY, slug);
}

export function loadQuizChoice(): string {
  return read<string>(localStorage, CHOICE_KEY) ?? "";
}

function read<T>(storage: Storage, key: string): T | null {
  try {
    return JSON.parse(storage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: unknown): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("could not save", key, error);
  }
}
