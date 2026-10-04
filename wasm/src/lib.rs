//! Quiz domain logic for P2P Quiz Wasm.
//!
//! Nothing in here knows about WebRTC or the browser. The quiz state is never
//! stored or sent anywhere. Every node keeps a copy of the same append-only
//! event log and *derives* the state from it. Sorting the log by
//! (lamport, nodeId, eventId) gives every node the same order, so every node
//! computes the same state, whatever order the events arrived in.
//!
//! The questions travel inside the log as well: QUIZ_CREATED carries the quiz (in the
//! cyber-quizzer format, see `content`), and a QUIZ_RESTARTED may bring another one.
//!
//! The derived state has two independent halves:
//! - `management`: the quiz, who is in it, rounds, finishing and restarting;
//! - `play`: the answers, everybody at their own pace, and the scores.

mod content;
mod management;
mod names;
mod play;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

use content::Quiz;
use management::{
    Lifecycle, ManageView, Participant, Status, PEER_JOINED, QUIZ_CREATED, QUIZ_FINISHED,
    QUIZ_RESTARTED,
};
use play::{Answers, PlayView, ANSWER_SUBMITTED};

/// One entry in the replicated, append-only event log.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub quiz_id: String,
    pub node_id: String,
    pub username: String,
    pub lamport: u64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

impl Event {
    /// The round a FINISHED, RESTARTED or ANSWER_SUBMITTED event refers to.
    fn round(&self) -> Option<u32> {
        self.payload["round"]
            .as_u64()
            .and_then(|r| u32::try_from(r).ok())
    }
}

/// The part of the state that both screens show.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuizInfo {
    quiz_id: String,
    /// Five short words derived from the quiz id.
    name: String,
    created_at: Option<String>,
    relay: Value,
    round: u32,
    status: Status,
    changed_by: Option<String>,
    participants: Vec<Participant>,
    /// The quiz of the current round: title, emoji, subject and the id of its questions.
    title: Option<String>,
    emoji: Option<String>,
    subject: Option<String>,
    content_id: Option<String>,
    question_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    quiz: QuizInfo,
    manage: ManageView,
    play: PlayView,
    lamport: u64,
    event_count: usize,
}

/// quizId = SHA256(domain + "|" + creatorUsername + "|" + creationTimestamp), as hex.
pub fn quiz_id_for(domain: &str, username: &str, created_at: &str) -> String {
    let digest = Sha256::digest(format!("{domain}|{username}|{created_at}"));
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("quiz data is always serializable")
}

/// The five-word name of a quiz. The first 10 hex digits of the quiz id are enough,
/// so a join link can show the name before the quiz itself has arrived.
#[wasm_bindgen(js_name = quizName)]
pub fn quiz_name(quiz_id: &str) -> String {
    names::quiz_name(quiz_id)
}

/// Reads a quiz in the cyber-quizzer format for the start screen. Returns
/// `{ title, emoji, subject, questionCount, contentId, quiz }`, where `quiz` is the quiz
/// without the questions this app cannot show: that is what `create` takes.
#[wasm_bindgen(js_name = checkQuiz)]
pub fn check_quiz(quiz_json: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(quiz_json).map_err(|e| e.to_string())?;
    let quiz = Quiz::parse(&value)?;
    Ok(to_json(&json!({
        "title": quiz.titel,
        "emoji": quiz.emoji,
        "subject": quiz.fag,
        "questionCount": quiz.spoergsmaal.len(),
        "contentId": quiz.content_id(),
        "quiz": quiz,
    })))
}

/// One node's copy of the quiz: its event log, its Lamport clock and its identity.
#[wasm_bindgen]
pub struct QuizEngine {
    node_id: String,
    username: String,
    quiz_id: String,
    lamport: u64,
    events: HashMap<String, Event>,
}

#[wasm_bindgen]
impl QuizEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(node_id: String, username: String) -> QuizEngine {
        QuizEngine {
            node_id,
            username,
            quiz_id: String::new(),
            lamport: 0,
            events: HashMap::new(),
        }
    }

    #[wasm_bindgen(getter, js_name = quizId)]
    pub fn quiz_id(&self) -> String {
        self.quiz_id.clone()
    }

    /// Starts a new quiz and returns its QUIZ_CREATED event (JSON). `relay_json` is
    /// `{ "topic", "key" }` for one-click joining, or `null`. `quiz_json` is the quiz
    /// (cyber-quizzer format) that everybody plays.
    pub fn create(
        &mut self,
        domain: &str,
        created_at: &str,
        relay_json: &str,
        quiz_json: &str,
        event_id: &str,
    ) -> Result<String, String> {
        if !self.quiz_id.is_empty() {
            return Err("this engine already belongs to a quiz".into());
        }
        let relay: Value = serde_json::from_str(relay_json).map_err(|e| e.to_string())?;
        let quiz: Value = serde_json::from_str(quiz_json).map_err(|e| e.to_string())?;
        let quiz = Quiz::parse(&quiz)?;
        self.quiz_id = quiz_id_for(domain, &self.username, created_at);
        let payload =
            json!({ "domain": domain, "createdAt": created_at, "relay": relay, "quiz": quiz });
        let event = self.local_event(QUIZ_CREATED, payload, event_id);
        self.validate(&event)?;
        Ok(self.store(event))
    }

    /// Attaches the engine to an existing quiz (a joining node, or a page reload).
    /// The events themselves arrive through `merge_events` and `apply_event`.
    pub fn join(&mut self, quiz_id: &str) -> Result<(), String> {
        if quiz_id.len() != 64 || !quiz_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid quiz id".into());
        }
        if !self.quiz_id.is_empty() && self.quiz_id != quiz_id {
            return Err("this engine already belongs to another quiz".into());
        }
        self.quiz_id = quiz_id.to_owned();
        Ok(())
    }

    /// Creates a local event and returns it (JSON) so it can be broadcast:
    /// - PEER_JOINED `{}`
    /// - ANSWER_SUBMITTED `{ round, contentId, question, answer }`
    /// - QUIZ_FINISHED `{ round }`
    /// - QUIZ_RESTARTED `{ round, quiz? }`: without a quiz, the same questions again.
    pub fn create_event(
        &mut self,
        kind: &str,
        payload_json: &str,
        event_id: &str,
    ) -> Result<String, String> {
        let mut payload: Value = serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
        if kind == QUIZ_RESTARTED && !payload["quiz"].is_null() {
            payload["quiz"] = json!(Quiz::parse(&payload["quiz"])?);
        }
        let event = self.local_event(kind, payload, event_id);
        self.validate(&event)?;
        let (quiz, answers) = self.replay();
        let joined = quiz.is_participant(&self.node_id);
        let allowed = match kind {
            PEER_JOINED => quiz.created_at.is_some() && !joined,
            ANSWER_SUBMITTED => answers.counts(&event, &quiz),
            QUIZ_FINISHED => {
                joined && quiz.status == Status::Open && event.round() == Some(quiz.round)
            }
            QUIZ_RESTARTED => joined && event.round() == Some(quiz.round + 1),
            _ => false,
        };
        if !allowed {
            return Err(format!("{kind} is not possible right now"));
        }
        Ok(self.store(event))
    }

    /// Applies one event received from a peer. Returns false if it was already known.
    pub fn apply_event(&mut self, event_json: &str) -> Result<bool, String> {
        let event: Event =
            serde_json::from_str(event_json).map_err(|e| format!("invalid event: {e}"))?;
        self.receive(event)
    }

    /// Merges a list of events, e.g. (part of) the event log of a peer.
    /// Returns the events that were new to this node (JSON array).
    pub fn merge_events(&mut self, events_json: &str) -> Result<String, String> {
        let values: Vec<Value> =
            serde_json::from_str(events_json).map_err(|e| format!("invalid event log: {e}"))?;
        let mut added = Vec::new();
        for value in values {
            if let Ok(event) = serde_json::from_value::<Event>(value) {
                if self.receive(event.clone()) == Ok(true) {
                    added.push(event);
                }
            }
        }
        Ok(to_json(&added))
    }

    /// The quiz state derived from the event log (JSON): `{ quiz, manage, play, lamport, eventCount }`.
    /// `play` is from the point of view of this node.
    pub fn get_state(&self) -> String {
        let (quiz, answers) = self.replay();
        let content = quiz.content.as_ref();
        to_json(&State {
            manage: management::view(&quiz, &answers),
            play: play::view(&quiz, &answers, &self.node_id),
            quiz: QuizInfo {
                quiz_id: self.quiz_id.clone(),
                name: names::quiz_name(&self.quiz_id),
                created_at: quiz.created_at.clone(),
                relay: quiz.relay.clone(),
                round: quiz.round,
                status: quiz.status,
                changed_by: quiz.changed_by.clone(),
                participants: quiz.participants.clone(),
                title: content.map(|c| c.quiz.titel.clone()),
                emoji: content.and_then(|c| c.quiz.emoji.clone()),
                subject: content.and_then(|c| c.quiz.fag.clone()),
                content_id: content.map(|c| c.id.clone()),
                question_count: content.map_or(0, |c| c.quiz.spoergsmaal.len()),
            },
            lamport: self.lamport,
            event_count: self.events.len(),
        })
    }

    /// The complete local event log in deterministic order (JSON array).
    pub fn get_events(&self) -> String {
        to_json(&self.sorted())
    }
}

impl QuizEngine {
    fn local_event(&self, kind: &str, payload: Value, event_id: &str) -> Event {
        Event {
            event_id: event_id.to_owned(),
            quiz_id: self.quiz_id.clone(),
            node_id: self.node_id.clone(),
            username: self.username.clone(),
            // Lamport rule for local events: counter += 1.
            lamport: self.lamport + 1,
            kind: kind.to_owned(),
            payload,
        }
    }

    fn store(&mut self, event: Event) -> String {
        self.lamport = event.lamport;
        let json = to_json(&event);
        self.events.insert(event.event_id.clone(), event);
        json
    }

    fn receive(&mut self, event: Event) -> Result<bool, String> {
        if self.events.contains_key(&event.event_id) {
            return Ok(false);
        }
        self.validate(&event)?;
        // Lamport rule for received events: counter = max(local, received) + 1.
        self.lamport = self.lamport.max(event.lamport) + 1;
        self.events.insert(event.event_id.clone(), event);
        Ok(true)
    }

    /// Checks that do not depend on arrival order, so all nodes accept the same events.
    /// Whether an answer fits its question is decided during the replay, because the
    /// questions of a round are only known there.
    fn validate(&self, e: &Event) -> Result<(), String> {
        if self.quiz_id.is_empty() || e.quiz_id != self.quiz_id {
            return Err("event belongs to another quiz".into());
        }
        if e.event_id.is_empty()
            || e.node_id.is_empty()
            || e.username.trim().is_empty()
            || e.lamport == 0
        {
            return Err("incomplete event".into());
        }
        let p = &e.payload;
        match e.kind.as_str() {
            QUIZ_CREATED => {
                let domain = p["domain"].as_str().unwrap_or_default();
                let created_at = p["createdAt"].as_str().unwrap_or_default();
                if quiz_id_for(domain, &e.username, created_at) != e.quiz_id {
                    return Err("quizId does not match its QUIZ_CREATED event".into());
                }
                Quiz::parse(&p["quiz"])?;
            }
            ANSWER_SUBMITTED => {
                let complete = e.round().is_some()
                    && p["contentId"].is_string()
                    && p["question"].is_u64()
                    && !p["answer"].is_null();
                if !complete {
                    return Err("invalid answer".into());
                }
            }
            QUIZ_FINISHED | QUIZ_RESTARTED if e.round().is_none() => {
                return Err("missing round".into())
            }
            QUIZ_RESTARTED if !p["quiz"].is_null() => {
                Quiz::parse(&p["quiz"])?;
            }
            PEER_JOINED | QUIZ_FINISHED | QUIZ_RESTARTED => {}
            other => return Err(format!("unknown event type {other}")),
        }
        Ok(())
    }

    /// Deterministic total order: lamport, then nodeId, then eventId.
    fn sorted(&self) -> Vec<&Event> {
        let mut events: Vec<&Event> = self.events.values().collect();
        events.sort_by(|a, b| {
            (a.lamport, &a.node_id, &a.event_id).cmp(&(b.lamport, &b.node_id, &b.event_id))
        });
        events
    }

    /// Replays the sorted log through both halves of the state.
    fn replay(&self) -> (Lifecycle, Answers) {
        let (mut quiz, mut answers) = (Lifecycle::new(), Answers::new());
        for event in self.sorted() {
            quiz.apply(event);
            answers.apply(event, &quiz);
        }
        (quiz, answers)
    }
}

#[cfg(test)]
mod tests;
