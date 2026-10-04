//! Playing: everybody answers the questions at their own pace.
//!
//! An answer counts only in the current round, only while that round is open, only for
//! the questions of that round (its content id), and only the first answer of a
//! participant to each question. As on the cyber-quizzer pages, a player sees right
//! after answering whether it was right, and why. The leaderboard is live.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;
use serde_json::Value;

use crate::content::{self, Kind, Quiz};
use crate::management::{Content, Lifecycle, Participant, Status};
use crate::Event;

pub const ANSWER_SUBMITTED: &str = "ANSWER_SUBMITTED";

struct Answer {
    value: Value,
    correct: bool,
}

/// The play side of the replayed event log: the accepted answers of the current round.
pub struct Answers {
    round: u32,
    /// nodeId -> question index -> answer.
    by_node: HashMap<String, BTreeMap<usize, Answer>>,
    count: usize,
}

impl Answers {
    pub fn new() -> Self {
        Answers {
            round: 1,
            by_node: HashMap::new(),
            count: 0,
        }
    }

    /// Called after `Lifecycle::apply` for the same event.
    pub fn apply(&mut self, e: &Event, quiz: &Lifecycle) {
        if self.round != quiz.round {
            // A new round starts without answers.
            *self = Answers::new();
            self.round = quiz.round;
        }
        if let Some((index, answer)) = self.accept(e, quiz) {
            self.by_node
                .entry(e.node_id.clone())
                .or_default()
                .insert(index, answer);
            self.count += 1;
        }
    }

    /// Whether an ANSWER_SUBMITTED event would count right now.
    pub fn counts(&self, e: &Event, quiz: &Lifecycle) -> bool {
        self.accept(e, quiz).is_some()
    }

    fn accept(&self, e: &Event, quiz: &Lifecycle) -> Option<(usize, Answer)> {
        let content = quiz.content.as_ref()?;
        let index = e.payload["question"]
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())?;
        let question = content.quiz.spoergsmaal.get(index)?;
        let counts = e.kind == ANSWER_SUBMITTED
            && quiz.status == Status::Open
            && e.round() == Some(quiz.round)
            && e.payload["contentId"].as_str() == Some(content.id.as_str())
            && quiz.is_participant(&e.node_id)
            && self.get(&e.node_id, index).is_none();
        let grade = question.grade(&e.payload["answer"]).filter(|_| counts)?;
        let answer = Answer {
            value: e.payload["answer"].clone(),
            correct: grade.correct,
        };
        Some((index, answer))
    }

    fn get(&self, node_id: &str, index: usize) -> Option<&Answer> {
        self.by_node.get(node_id)?.get(&index)
    }

    pub fn len(&self) -> usize {
        self.count
    }

    fn answered(&self, node_id: &str) -> usize {
        self.by_node.get(node_id).map_or(0, BTreeMap::len)
    }

    fn score(&self, node_id: &str) -> usize {
        let answers = self.by_node.get(node_id);
        answers.map_or(0, |a| a.values().filter(|a| a.correct).count())
    }

    /// How many answered question `index`, and how many of them got it right.
    pub fn tally(&self, index: usize) -> (usize, usize) {
        let answers = self.by_node.values().filter_map(|a| a.get(&index));
        answers.fold((0, 0), |(n, right), a| {
            (n + 1, right + usize::from(a.correct))
        })
    }

    /// One mark per question: ✅ right, ❌ wrong, ➖ not answered (yet).
    fn marks(&self, node_id: &str, question_count: usize) -> String {
        (0..question_count)
            .map(|i| match self.get(node_id, i) {
                Some(answer) if answer.correct => '✅',
                Some(_) => '❌',
                None => '➖',
            })
            .collect()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionView {
    /// What an ANSWER_SUBMITTED event refers to: the position of the question in the quiz.
    pub index: usize,
    /// 1-based, for "Question 2 of 18".
    pub number: usize,
    /// The section of the quiz, e.g. "📜 Med eller uden aftale".
    pub section: Option<String>,
    pub emoji: Option<String>,
    pub text: String,
    /// "choice", "truefalse", "order" or "estimate".
    pub kind: &'static str,
    /// Choice: the options. Order: the items, shuffled. `id` is what the answer carries.
    pub options: Vec<Item>,
    pub estimate: Option<EstimateView>,
}

#[derive(Debug, Serialize)]
pub struct Item {
    pub id: usize,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct EstimateView {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub start: f64,
    pub unit: String,
    /// A year: shown without a thousands separator.
    pub year: bool,
}

/// One answered question, with the right answer and the explanation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultView {
    pub index: usize,
    pub number: usize,
    pub section: Option<String>,
    pub emoji: Option<String>,
    pub title: String,
    pub text: String,
    pub kind: &'static str,
    pub correct: bool,
    pub answer: String,
    pub right_answer: String,
    /// "3 of 5 in the right place.", "12 % off."
    pub detail: Option<String>,
    pub explanation: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreRow {
    pub rank: usize,
    pub node_id: String,
    pub username: String,
    pub answered: usize,
    pub finished: bool,
    pub score: usize,
    /// One mark per question: ✅ right, ❌ wrong, ➖ not answered.
    pub marks: String,
}

/// What the play screen of this node shows.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayView {
    pub answered: usize,
    /// Answered every question.
    pub finished: bool,
    /// The next question to answer. None once everything is answered or the round is finished.
    pub question: Option<QuestionView>,
    pub score: usize,
    /// This node's answers so far, in question order.
    pub results: Vec<ResultView>,
    /// Everyone who answered something, best first.
    pub leaderboard: Vec<ScoreRow>,
}

pub fn view(quiz: &Lifecycle, answers: &Answers, me: &str) -> PlayView {
    let Some(content) = &quiz.content else {
        return PlayView::default(); // the quiz itself has not arrived yet
    };
    let count = content.quiz.spoergsmaal.len();
    let open = quiz.status == Status::Open && quiz.is_participant(me);
    let next = (0..count).find(|&i| answers.get(me, i).is_none());
    let seed = |i: usize| format!("{me}|{}|{}|{i}", quiz.round, content.id);
    let players: Vec<Participant> = quiz
        .participants
        .iter()
        .filter(|p| answers.answered(&p.node_id) > 0)
        .cloned()
        .collect();
    PlayView {
        answered: answers.answered(me),
        finished: next.is_none(),
        question: next
            .filter(|_| open)
            .map(|i| question_view(content, i, &seed(i))),
        score: answers.score(me),
        results: (0..count)
            .filter_map(|i| Some(result_view(&content.quiz, i, answers.get(me, i)?)))
            .collect(),
        leaderboard: ranking(answers, &players, count),
    }
}

fn question_view(content: &Content, index: usize, seed: &str) -> QuestionView {
    let q = &content.quiz.spoergsmaal[index];
    let (options, estimate) = match &q.kind {
        Kind::Choice { svar, .. } => (items(svar, 0..svar.len()), None),
        Kind::TrueFalse { .. } => (Vec::new(), None),
        Kind::Order { elementer } => {
            let order = content::shuffled(elementer.len(), seed);
            (items(elementer, order), None)
        }
        Kind::Estimate(e) => {
            // As on the cyber-quizzer pages: snapped to the step, within the slider.
            let start = e.start.unwrap_or((e.min + e.max) / 2.0);
            let start = ((start / e.trin).round() * e.trin).clamp(e.min, e.max);
            let view = EstimateView {
                min: e.min,
                max: e.max,
                step: e.trin,
                start,
                unit: e.enhed.clone(),
                year: e.aar,
            };
            (Vec::new(), Some(view))
        }
    };
    QuestionView {
        index,
        number: index + 1,
        section: content.quiz.section(q),
        emoji: q.emoji.clone(),
        text: q.tekst.clone(),
        kind: q.kind_name(),
        options,
        estimate,
    }
}

fn items(labels: &[String], order: impl IntoIterator<Item = usize>) -> Vec<Item> {
    let item = |id: usize| Item {
        id,
        label: labels[id].clone(),
    };
    order.into_iter().map(item).collect()
}

fn result_view(quiz: &Quiz, index: usize, answer: &Answer) -> ResultView {
    let q = &quiz.spoergsmaal[index];
    ResultView {
        index,
        number: index + 1,
        section: quiz.section(q),
        emoji: q.emoji.clone(),
        title: q.title(),
        text: q.tekst.clone(),
        kind: q.kind_name(),
        correct: answer.correct,
        answer: q.label(&answer.value),
        right_answer: q.right_answer(),
        detail: q.grade(&answer.value).and_then(|grade| grade.detail),
        explanation: q.forklaring.clone(),
    }
}

/// Best score first, then username alphabetically (nodeId only breaks exact ties).
pub fn ranking(answers: &Answers, people: &[Participant], question_count: usize) -> Vec<ScoreRow> {
    let mut rows: Vec<ScoreRow> = people
        .iter()
        .map(|p| ScoreRow {
            rank: 0,
            node_id: p.node_id.clone(),
            username: p.username.clone(),
            answered: answers.answered(&p.node_id),
            finished: question_count > 0 && answers.answered(&p.node_id) == question_count,
            score: answers.score(&p.node_id),
            marks: answers.marks(&p.node_id, question_count),
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
