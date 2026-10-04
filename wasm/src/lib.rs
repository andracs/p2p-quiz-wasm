//! Quiz domain logic for P2P Quiz Wasm.
//!
//! Nothing in here knows about WebRTC or the browser. The quiz state is never
//! stored or sent anywhere. Every node keeps a copy of the same append-only
//! event log and *derives* the state from it. Sorting the log by
//! (lamport, nodeId, eventId) gives every node the same order, so every node
//! computes the same state, whatever order the events arrived in.
//!
//! The derived state has two independent halves:
//! - `management`: the quiz, who is in it, rounds, finishing and restarting;
//! - `play`: the answers, everybody at their own pace, and the scores.

mod content;
mod management;
mod play;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

use content::QUESTIONS;
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
    question_count: usize,
    participants: Vec<Participant>,
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
    content::quiz_name(quiz_id)
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
    /// `{ "topic", "key" }` for one-click joining, or `null`.
    pub fn create(
        &mut self,
        domain: &str,
        created_at: &str,
        relay_json: &str,
        event_id: &str,
    ) -> Result<String, String> {
        if !self.quiz_id.is_empty() {
            return Err("this engine already belongs to a quiz".into());
        }
        let relay: Value = serde_json::from_str(relay_json).map_err(|e| e.to_string())?;
        self.quiz_id = quiz_id_for(domain, &self.username, created_at);
        let payload = json!({ "domain": domain, "createdAt": created_at, "relay": relay });
        self.emit(QUIZ_CREATED, payload, event_id)
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

    /// Creates a local event (PEER_JOINED, ANSWER_SUBMITTED, QUIZ_FINISHED or
    /// QUIZ_RESTARTED) and returns it (JSON) so it can be broadcast.
    pub fn create_event(
        &mut self,
        kind: &str,
        payload_json: &str,
        event_id: &str,
    ) -> Result<String, String> {
        let payload: Value = serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
        let (quiz, answers) = self.replay();
        let joined = quiz.is_participant(&self.node_id);
        let round = payload["round"].as_u64();
        let question = payload["questionId"].as_str().unwrap_or_default();
        let allowed = match kind {
            PEER_JOINED => quiz.created_at.is_some() && !joined,
            ANSWER_SUBMITTED => {
                let unanswered = answers.of(&self.node_id, question).is_none();
                joined
                    && quiz.status == Status::Open
                    && round == Some(u64::from(quiz.round))
                    && unanswered
            }
            QUIZ_FINISHED => {
                joined && quiz.status == Status::Open && round == Some(u64::from(quiz.round))
            }
            QUIZ_RESTARTED => joined && round == Some(u64::from(quiz.round) + 1),
            _ => false,
        };
        if !allowed {
            return Err(format!("{kind} is not possible right now"));
        }
        self.emit(kind, payload, event_id)
    }

    /// Applies one event received from a peer. Returns false if it was already known.
    pub fn apply_event(&mut self, event_json: &str) -> Result<bool, String> {
        let event: Event =
            serde_json::from_str(event_json).map_err(|e| format!("invalid event: {e}"))?;
        self.receive(event)
    }

    /// Merges a list of events, e.g. the complete event log of a peer.
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
        to_json(&State {
            manage: management::view(&quiz, &answers),
            play: play::view(&quiz, &answers, &self.node_id),
            quiz: QuizInfo {
                quiz_id: self.quiz_id.clone(),
                name: content::quiz_name(&self.quiz_id),
                created_at: quiz.created_at,
                relay: quiz.relay,
                round: quiz.round,
                status: quiz.status,
                changed_by: quiz.changed_by,
                question_count: QUESTIONS.len(),
                participants: quiz.participants,
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
    fn emit(&mut self, kind: &str, payload: Value, event_id: &str) -> Result<String, String> {
        let event = Event {
            event_id: event_id.to_owned(),
            quiz_id: self.quiz_id.clone(),
            node_id: self.node_id.clone(),
            username: self.username.clone(),
            // Lamport rule for local events: counter += 1.
            lamport: self.lamport + 1,
            kind: kind.to_owned(),
            payload,
        };
        self.validate(&event)?;
        self.lamport = event.lamport;
        let json = to_json(&event);
        self.events.insert(event.event_id.clone(), event);
        Ok(json)
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
        match e.kind.as_str() {
            QUIZ_CREATED => {
                let domain = e.payload["domain"].as_str().unwrap_or_default();
                let created_at = e.payload["createdAt"].as_str().unwrap_or_default();
                if quiz_id_for(domain, &e.username, created_at) != e.quiz_id {
                    return Err("quizId does not match its QUIZ_CREATED event".into());
                }
            }
            ANSWER_SUBMITTED => {
                let question =
                    content::question(e.payload["questionId"].as_str().unwrap_or_default());
                let answer = e.payload["answer"].as_str().unwrap_or_default();
                if e.round().is_none() || question.and_then(|q| q.label(answer)).is_none() {
                    return Err("invalid answer".into());
                }
            }
            QUIZ_FINISHED | QUIZ_RESTARTED if e.round().is_none() => {
                return Err("missing round".into())
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
mod tests {
    use super::*;

    fn state(engine: &QuizEngine) -> Value {
        serde_json::from_str(&engine.get_state()).unwrap()
    }

    /// Two nodes exchange their complete event logs.
    fn sync(a: &mut QuizEngine, b: &mut QuizEngine) {
        let (a_log, b_log) = (a.get_events(), b.get_events());
        a.merge_events(&b_log).unwrap();
        b.merge_events(&a_log).unwrap();
    }

    fn created(node_id: &str, username: &str) -> QuizEngine {
        let mut node = QuizEngine::new(node_id.into(), username.into());
        let relay = r#"{"topic":"p2pquiz-test","key":"k"}"#;
        node.create(
            "example.github.io",
            "2026-10-04T10:31:42.123Z",
            relay,
            "created",
        )
        .unwrap();
        node.create_event(PEER_JOINED, "{}", &format!("{node_id}-joined"))
            .unwrap();
        node
    }

    fn joined(node_id: &str, username: &str, via: &mut QuizEngine) -> QuizEngine {
        let mut node = QuizEngine::new(node_id.into(), username.into());
        node.join(&via.quiz_id()).unwrap();
        sync(&mut node, via);
        node.create_event(PEER_JOINED, "{}", &format!("{node_id}-joined"))
            .unwrap();
        sync(&mut node, via);
        node
    }

    fn answer(node: &mut QuizEngine, question: &str, key: &str) -> Result<String, String> {
        let round = state(node)["quiz"]["round"].as_u64().unwrap();
        let payload = json!({ "round": round, "questionId": question, "answer": key }).to_string();
        node.create_event(
            ANSWER_SUBMITTED,
            &payload,
            &format!("{}-{round}-{question}", node.node_id),
        )
    }

    fn manage(node: &mut QuizEngine, kind: &str, round: u64) -> Result<String, String> {
        let payload = json!({ "round": round }).to_string();
        node.create_event(kind, &payload, &format!("{}-{kind}-{round}", node.node_id))
    }

    fn answer_all(node: &mut QuizEngine, keys: [&str; 5]) {
        for (i, key) in keys.iter().enumerate() {
            answer(node, &format!("q{}", i + 1), key).unwrap();
        }
    }

    fn scores(view: &Value) -> Vec<(String, u64)> {
        let rows = view.as_array().unwrap();
        rows.iter()
            .map(|r| {
                (
                    r["username"].as_str().unwrap().to_owned(),
                    r["score"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn quiz_id_is_sha256_of_domain_creator_and_timestamp() {
        assert_eq!(
            quiz_id_for("example.github.io", "x", "2026-10-04T10:31:42.123Z"),
            "6371cd41f75003f6313635b9174311bca12d5d9af13f4812c07e41afad14af48"
        );
    }

    #[test]
    fn quiz_name_is_five_short_words_from_the_id() {
        let x = created("node-x", "x");
        let name = state(&x)["quiz"]["name"].as_str().unwrap().to_owned();
        let words: Vec<&str> = name.split(' ').collect();
        assert_eq!(words.len(), 5);
        assert!(words.iter().all(|w| (2..=5).contains(&w.len())));
        assert_eq!(name, content::quiz_name(&x.quiz_id()));
    }

    #[test]
    fn players_answer_at_their_own_pace_and_the_creator_can_leave() {
        let mut x = created("node-x", "x"); // manages, does not play
        let mut y = joined("node-y", "y", &mut x);
        answer_all(&mut y, ["B", "A", "C", "D", "B"]); // 5 correct
        assert_eq!(state(&y)["play"]["score"], 5);
        assert!(
            state(&y)["play"]["question"].is_null(),
            "nothing left to answer"
        );
        sync(&mut x, &mut y);
        assert_eq!(state(&x)["manage"]["players"][0]["answered"], 5);

        // x disappears. z joins later through y and is still answering.
        drop(x);
        let mut z = joined("node-z", "z", &mut y);
        answer(&mut z, "q1", "B").unwrap();
        answer(&mut z, "q2", "B").unwrap();
        assert!(
            answer(&mut z, "q1", "A").is_err(),
            "one answer per question"
        );
        let play = state(&z)["play"].clone();
        assert_eq!(play["question"]["number"], 3);
        assert!(
            play["score"].is_null() && play["leaderboard"].as_array().unwrap().is_empty(),
            "nothing revealed yet"
        );

        // Finishing the round closes it for everybody, and both see the same scores.
        sync(&mut y, &mut z);
        manage(&mut z, QUIZ_FINISHED, 1).unwrap();
        sync(&mut y, &mut z);
        let (sy, sz) = (state(&y), state(&z));
        assert_eq!(sy["quiz"]["status"], "FINISHED");
        assert_eq!(sy["quiz"]["changedBy"], "z");
        assert!(
            answer(&mut z, "q3", "C").is_err(),
            "no answers after finishing"
        );
        assert_eq!(sy["manage"]["players"], sz["manage"]["players"]);
        assert_eq!(
            scores(&sz["play"]["leaderboard"]),
            [("y".into(), 5), ("z".into(), 1)]
        );
        assert_eq!(
            scores(&sz["manage"]["players"]),
            [("y".into(), 5), ("z".into(), 1), ("x".into(), 0)]
        );
        assert_eq!(
            sz["manage"]["players"][1]["results"][1]["answer"],
            "The answers to the quiz"
        );
    }

    #[test]
    fn concurrent_management_clicks_converge_and_a_restart_starts_empty() {
        let mut x = created("node-x", "x");
        let mut y = joined("node-y", "y", &mut x);
        answer(&mut y, "q1", "B").unwrap();
        sync(&mut x, &mut y);

        // Both finish round 1, then both restart into round 2, without hearing from each other.
        manage(&mut x, QUIZ_FINISHED, 1).unwrap();
        manage(&mut y, QUIZ_FINISHED, 1).unwrap();
        manage(&mut x, QUIZ_RESTARTED, 2).unwrap();
        manage(&mut y, QUIZ_RESTARTED, 2).unwrap();
        // A late answer for round 1 must not count anywhere.
        let late = json!({ "round": 1, "questionId": "q2", "answer": "A" }).to_string();
        assert!(y.create_event(ANSWER_SUBMITTED, &late, "late").is_err());
        sync(&mut x, &mut y);

        assert_eq!(x.get_events(), y.get_events());
        let (sx, sy) = (state(&x), state(&y));
        assert_eq!(sx["quiz"]["round"], 2);
        assert_eq!(sx["quiz"]["status"], "OPEN");
        assert_eq!(sx["manage"], sy["manage"]);
        assert_eq!(
            sy["manage"]["answerCount"], 0,
            "a new round starts without answers"
        );
        assert_eq!(sy["play"]["question"]["id"], "q1");
    }

    #[test]
    fn duplicates_are_ignored_and_lamport_follows_the_rules() {
        let mut x = QuizEngine::new("node-x".into(), "x".into());
        let created = x
            .create("localhost", "2026-10-04T10:31:42.123Z", "null", "created")
            .unwrap();
        let mut y = QuizEngine::new("node-y".into(), "y".into());
        y.join(&x.quiz_id()).unwrap();

        let mut event: Value = serde_json::from_str(&created).unwrap();
        event["lamport"] = json!(7);
        event["eventId"] = json!("late");
        // Same eventId twice: only the first one counts.
        assert_eq!(y.apply_event(&created), Ok(true));
        assert_eq!(y.apply_event(&created), Ok(false));
        assert_eq!(y.lamport, 2);
        // A different (but still valid) event with a higher clock: max(2, 7) + 1.
        assert_eq!(y.apply_event(&event.to_string()), Ok(true));
        assert_eq!(y.lamport, 8);
        assert!(y
            .apply_event(r#"{"eventId":"bad","quizId":"other"}"#)
            .is_err());
    }
}
