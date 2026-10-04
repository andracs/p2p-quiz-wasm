//! Playing: everybody answers the questions at their own pace.
//!
//! An answer counts only in the current round, only while that round is open, and
//! only the first answer of a participant to each question. A player sees their own
//! results and the leaderboard after answering every question, or once the round is
//! finished. Until then nobody's answers are revealed to them.

use serde::Serialize;

use crate::content::{Question, QUESTIONS};
use crate::management::{Lifecycle, Participant, Status};
use crate::Event;

pub const ANSWER_SUBMITTED: &str = "ANSWER_SUBMITTED";

struct Answer {
    node_id: String,
    question_id: String,
    key: String,
}

/// The play side of the replayed event log: the accepted answers of the current round.
pub struct Answers {
    round: u32,
    list: Vec<Answer>,
}

impl Answers {
    pub fn new() -> Self {
        Answers {
            round: 1,
            list: Vec::new(),
        }
    }

    /// Called after `Lifecycle::apply` for the same event.
    pub fn apply(&mut self, e: &Event, quiz: &Lifecycle) {
        if self.round != quiz.round {
            // A restarted quiz starts again without answers.
            self.round = quiz.round;
            self.list.clear();
        }
        let question_id = e.payload["questionId"].as_str().unwrap_or_default();
        if e.kind == ANSWER_SUBMITTED
            && quiz.status == Status::Open
            && e.round() == Some(quiz.round)
            && quiz.is_participant(&e.node_id)
            && self.of(&e.node_id, question_id).is_none()
        {
            self.list.push(Answer {
                node_id: e.node_id.clone(),
                question_id: question_id.to_owned(),
                key: e.payload["answer"].as_str().unwrap_or_default().to_owned(),
            });
        }
    }

    pub fn of(&self, node_id: &str, question_id: &str) -> Option<&str> {
        let answer = self
            .list
            .iter()
            .find(|a| a.node_id == node_id && a.question_id == question_id);
        answer.map(|a| a.key.as_str())
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    fn answered(&self, node_id: &str) -> usize {
        self.list.iter().filter(|a| a.node_id == node_id).count()
    }

    fn score(&self, node_id: &str) -> u32 {
        let correct = |q: &&Question| self.of(node_id, q.id) == Some(q.correct);
        QUESTIONS.iter().filter(correct).count() as u32
    }

    fn results(&self, node_id: &str) -> Vec<ResultRow> {
        QUESTIONS
            .iter()
            .map(|q| {
                let answer = self.of(node_id, q.id);
                ResultRow {
                    question: q.text,
                    answer: answer.and_then(|key| q.label(key)),
                    correct_answer: q.label(q.correct).unwrap_or_default(),
                    correct: answer == Some(q.correct),
                }
            })
            .collect()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionView {
    pub id: &'static str,
    /// 1-based position, for "Question 2 of 5".
    pub number: usize,
    pub text: &'static str,
    pub options: Vec<OptionView>,
}

#[derive(Debug, Serialize)]
pub struct OptionView {
    pub key: &'static str,
    pub label: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultRow {
    pub question: &'static str,
    pub answer: Option<&'static str>,
    pub correct_answer: &'static str,
    pub correct: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreRow {
    pub rank: usize,
    pub node_id: String,
    pub username: String,
    pub answered: usize,
    pub finished: bool,
    pub score: u32,
    /// Per-question answers: empty unless revealed.
    pub results: Vec<ResultRow>,
}

/// What the play screen of this node shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayView {
    pub answered: usize,
    pub finished: bool,
    /// The next question to answer. None once everything is answered or the round is finished.
    pub question: Option<QuestionView>,
    /// Revealed after answering every question, or once the round is finished.
    pub score: Option<u32>,
    pub results: Vec<ResultRow>,
    /// Everyone who answered something, best first. Revealed like `score`.
    pub leaderboard: Vec<ScoreRow>,
}

pub fn view(quiz: &Lifecycle, answers: &Answers, me: &str) -> PlayView {
    let answered = answers.answered(me);
    let finished = answered == QUESTIONS.len();
    let reveal = finished || quiz.status == Status::Finished;
    let open = quiz.status == Status::Open && quiz.is_participant(me);
    let next = QUESTIONS
        .iter()
        .enumerate()
        .find(|(_, q)| answers.of(me, q.id).is_none());
    let question = next.filter(|_| open).map(|(i, q)| QuestionView {
        id: q.id,
        number: i + 1,
        text: q.text,
        options: q
            .options
            .iter()
            .map(|&(key, label)| OptionView { key, label })
            .collect(),
    });
    let players: Vec<Participant> = quiz
        .participants
        .iter()
        .filter(|p| answers.answered(&p.node_id) > 0)
        .cloned()
        .collect();
    PlayView {
        answered,
        finished,
        question,
        score: reveal.then(|| answers.score(me)),
        results: if reveal {
            answers.results(me)
        } else {
            Vec::new()
        },
        leaderboard: if reveal {
            ranking(answers, &players, true)
        } else {
            Vec::new()
        },
    }
}

/// Best score first, then username alphabetically (nodeId only breaks exact ties).
pub fn ranking(answers: &Answers, people: &[Participant], reveal: bool) -> Vec<ScoreRow> {
    let mut rows: Vec<ScoreRow> = people
        .iter()
        .map(|p| ScoreRow {
            rank: 0,
            node_id: p.node_id.clone(),
            username: p.username.clone(),
            answered: answers.answered(&p.node_id),
            finished: answers.answered(&p.node_id) == QUESTIONS.len(),
            score: answers.score(&p.node_id),
            results: if reveal {
                answers.results(&p.node_id)
            } else {
                Vec::new()
            },
        })
        .collect();
    rows.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.username.to_lowercase().cmp(&b.username.to_lowercase()))
            .then_with(|| a.username.cmp(&b.username))
            .then_with(|| a.node_id.cmp(&b.node_id))
    });
    for (i, row) in rows.iter_mut().enumerate() {
        row.rank = i + 1;
    }
    rows
}
