// Local persistence.
// - The replicated event log lives in localStorage under "p2pquiz:<quizId>".
// - This tab's identity lives in sessionStorage, so a reload resumes as the
//   same node, while other tabs of the same browser stay separate nodes.
// - The last username used lives in localStorage under "p2pquiz:username".

import type { QuizEvent } from "./protocol";

export interface Session {
  quizId: string;
  nodeId: string;
  username: string;
}

const SESSION_KEY = "p2pquiz:session";
const USERNAME_KEY = "p2pquiz:username";
const logKey = (quizId: string) => `p2pquiz:${quizId}`;

export function saveEvents(quizId: string, events: QuizEvent[]): void {
  // Other tabs of this browser may be nodes in the same quiz: keep their events too.
  const log = new Map(loadEvents(quizId).map((event) => [event.eventId, event]));
  for (const event of events) log.set(event.eventId, event);
  write(localStorage, logKey(quizId), [...log.values()]);
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
