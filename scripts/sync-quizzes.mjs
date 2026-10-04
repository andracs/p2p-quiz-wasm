// Copies the published quizzes of https://github.com/andracs/cyber-quizzer into quizzes/.
// "Published" means listed in the quiz table of its README (between <!-- quizzer:start -->
// and <!-- quizzer:end -->), which cyber-quizzer's own build keeps up to date.
//
//   npm run quizzes
//
// QUIZ_SOURCE=<base URL> reads from another copy, e.g. a fork.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

const SOURCE = process.env.QUIZ_SOURCE ?? "https://raw.githubusercontent.com/andracs/cyber-quizzer/main";
const TARGET = new URL("../quizzes/", import.meta.url);

async function get(path) {
  const response = await fetch(`${SOURCE}/${path}`);
  if (!response.ok) throw new Error(`${SOURCE}/${path}: ${response.status} ${response.statusText}`);
  return response.text();
}

const readme = await get("README.md");
const table = /<!-- quizzer:start -->([\s\S]*?)<!-- quizzer:end -->/.exec(readme)?.[1] ?? "";
// Rows link to the quiz pages: [Title](https://andracs.github.io/cyber-quizzer/<slug>/)
const slugs = [...new Set([...table.matchAll(/\]\([^)\s]*\/([\w-]+)\/\)/g)].map((m) => m[1]))];
if (slugs.length === 0) throw new Error("Found no quizzes in the README table of cyber-quizzer.");

await mkdir(TARGET, { recursive: true });
for (const file of await readdir(TARGET)) {
  if (file.endsWith(".json") && !slugs.includes(file.slice(0, -5))) await rm(new URL(file, TARGET));
}
for (const slug of slugs) {
  const quiz = JSON.parse(await get(`src/quizzes/${slug}.json`));
  if (typeof quiz.titel !== "string" || !Array.isArray(quiz.spoergsmaal)) {
    throw new Error(`${slug}.json does not look like a cyber-quizzer quiz.`);
  }
  await writeFile(new URL(`${slug}.json`, TARGET), JSON.stringify(quiz, null, 2) + "\n");
  console.log(`quizzes/${slug}.json  ${quiz.emoji ?? "📝"} ${quiz.titel}, ${quiz.spoergsmaal.length} questions`);
}
