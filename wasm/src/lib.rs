//! Quiz domain logic for P2P Quiz Wasm.
//!
//! Nothing in here knows about WebRTC or the browser. The quiz state is never
//! stored or sent anywhere. Every node keeps a copy of the same append-only
//! event log and *derives* the state from it. Sorting the log by
//! (lamport, nodeId, eventId) gives every node the same order, so every node
//! computes the same state, whatever order the events arrived in.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;

const QUIZ_CREATED: &str = "QUIZ_CREATED";
const PEER_JOINED: &str = "PEER_JOINED";
const QUIZ_STARTED: &str = "QUIZ_STARTED";
const ANSWER_SUBMITTED: &str = "ANSWER_SUBMITTED";
const SHOW_SCOREBOARD: &str = "SHOW_SCOREBOARD";

// The one hard-coded question.
const QUESTION_ID: &str = "q1";
const QUESTION_TEXT: &str = "Which protocol is normally used for secure web traffic?";
const OPTIONS: [(&str, &str); 4] = [("A", "HTTP"), ("B", "HTTPS"), ("C", "FTP"), ("D", "SMTP")];
const CORRECT_ANSWER: &str = "B";

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

/// Phases only ever move forward: LOBBY -> QUESTION -> SCOREBOARD.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Phase {
    Lobby,
    Question,
    Scoreboard,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Participant {
    node_id: String,
    username: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnswerView {
    node_id: String,
    username: String,
    /// Hidden (null) until the scoreboard is shown.
    answer: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScoreRow {
    rank: usize,
    node_id: String,
    username: String,
    answer: Option<String>,
    answer_label: Option<String>,
    score: u32,
}

/// The state every node derives from its copy of the event log.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuizState {
    quiz_id: String,
    created_at: Option<String>,
    phase: Phase,
    question: Value,
    participants: Vec<Participant>,
    answers: Vec<AnswerView>,
    /// Empty until SCOREBOARD. Sorted by score, then username.
    scores: Vec<ScoreRow>,
    lamport: u64,
    event_count: usize,
}

/// The result of replaying the sorted event log from the beginning.
struct Replay {
    created_at: Option<String>,
    phase: Phase,
    participants: Vec<Participant>,
    /// (nodeId, answer key): the first answer of each participant, in log order.
    answers: Vec<(String, String)>,
}

impl Replay {
    fn is_participant(&self, node_id: &str) -> bool {
        self.participants.iter().any(|p| p.node_id == node_id)
    }

    fn answer_of(&self, node_id: &str) -> Option<&str> {
        self.answers
            .iter()
            .find(|(n, _)| n == node_id)
            .map(|(_, a)| a.as_str())
    }
}

fn replay(sorted: &[&Event]) -> Replay {
    let mut r = Replay {
        created_at: None,
        phase: Phase::Lobby,
        participants: Vec::new(),
        answers: Vec::new(),
    };
    for e in sorted {
        match e.kind.as_str() {
            QUIZ_CREATED if r.created_at.is_none() => {
                r.created_at = e.payload["createdAt"].as_str().map(str::to_owned);
            }
            PEER_JOINED if !r.is_participant(&e.node_id) => r.participants.push(Participant {
                node_id: e.node_id.clone(),
                username: e.username.clone(),
            }),
            QUIZ_STARTED if r.phase == Phase::Lobby => r.phase = Phase::Question,
            SHOW_SCOREBOARD if r.phase == Phase::Question => r.phase = Phase::Scoreboard,
            // One answer per participant, and only while the question is open.
            ANSWER_SUBMITTED
                if r.phase == Phase::Question
                    && r.is_participant(&e.node_id)
                    && r.answer_of(&e.node_id).is_none() =>
            {
                let answer = e.payload["answer"].as_str().unwrap_or_default();
                r.answers.push((e.node_id.clone(), answer.to_owned()));
            }
            // Repeats (a second QUIZ_STARTED, SHOW_SCOREBOARD, answer...) change nothing.
            _ => {}
        }
    }
    r
}

/// quizId = SHA256(domain + "|" + creatorUsername + "|" + creationTimestamp), as hex.
pub fn quiz_id_for(domain: &str, username: &str, created_at: &str) -> String {
    let digest = Sha256::digest(format!("{domain}|{username}|{created_at}"));
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn label_of(answer: &str) -> String {
    OPTIONS
        .iter()
        .find(|(key, _)| *key == answer)
        .map_or(answer, |(_, label)| *label)
        .to_owned()
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("quiz data is always serializable")
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

    /// Starts a new quiz and returns its QUIZ_CREATED event (JSON).
    pub fn create(
        &mut self,
        domain: &str,
        created_at: &str,
        event_id: &str,
    ) -> Result<String, String> {
        if !self.quiz_id.is_empty() {
            return Err("this engine already belongs to a quiz".into());
        }
        self.quiz_id = quiz_id_for(domain, &self.username, created_at);
        let payload = json!({ "domain": domain, "createdAt": created_at });
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

    /// Creates a local event (PEER_JOINED, QUIZ_STARTED, ANSWER_SUBMITTED or
    /// SHOW_SCOREBOARD) and returns it (JSON) so it can be broadcast.
    pub fn create_event(
        &mut self,
        kind: &str,
        payload_json: &str,
        event_id: &str,
    ) -> Result<String, String> {
        let payload: Value = serde_json::from_str(payload_json).map_err(|e| e.to_string())?;
        let r = replay(&self.sorted());
        let joined = r.is_participant(&self.node_id);
        let allowed = match kind {
            PEER_JOINED => r.created_at.is_some() && !joined,
            QUIZ_STARTED => joined && r.phase == Phase::Lobby,
            ANSWER_SUBMITTED => {
                joined && r.phase == Phase::Question && r.answer_of(&self.node_id).is_none()
            }
            SHOW_SCOREBOARD => joined && r.phase == Phase::Question,
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

    /// The quiz state derived from the event log (JSON).
    pub fn get_state(&self) -> String {
        let r = replay(&self.sorted());
        let reveal = r.phase == Phase::Scoreboard;
        let username_of = |node_id: &str| {
            let p = r.participants.iter().find(|p| p.node_id == node_id);
            p.map(|p| p.username.clone()).unwrap_or_default()
        };
        let answers = r
            .answers
            .iter()
            .map(|(node_id, answer)| AnswerView {
                node_id: node_id.clone(),
                username: username_of(node_id),
                answer: reveal.then(|| answer.clone()),
            })
            .collect();
        let mut scores = Vec::new();
        if reveal {
            for p in &r.participants {
                let answer = r.answer_of(&p.node_id);
                scores.push(ScoreRow {
                    rank: 0,
                    node_id: p.node_id.clone(),
                    username: p.username.clone(),
                    answer: answer.map(str::to_owned),
                    answer_label: answer.map(label_of),
                    score: u32::from(answer == Some(CORRECT_ANSWER)),
                });
            }
            // Score descending, then username alphabetically (nodeId only breaks exact ties).
            scores.sort_by(|a, b| {
                b.score
                    .cmp(&a.score)
                    .then_with(|| a.username.to_lowercase().cmp(&b.username.to_lowercase()))
                    .then_with(|| a.username.cmp(&b.username))
                    .then_with(|| a.node_id.cmp(&b.node_id))
            });
            for (i, row) in scores.iter_mut().enumerate() {
                row.rank = i + 1;
            }
        }
        let options: Vec<Value> = OPTIONS
            .iter()
            .map(|(key, label)| json!({ "key": key, "label": label }))
            .collect();
        to_json(&QuizState {
            quiz_id: self.quiz_id.clone(),
            created_at: r.created_at.clone(),
            phase: r.phase,
            question: json!({ "id": QUESTION_ID, "text": QUESTION_TEXT, "options": options }),
            participants: r.participants.clone(),
            answers,
            scores,
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
                let answer = e.payload["answer"].as_str().unwrap_or_default();
                if e.payload["questionId"] != QUESTION_ID
                    || !OPTIONS.iter().any(|(key, _)| *key == answer)
                {
                    return Err("invalid answer".into());
                }
            }
            PEER_JOINED | QUIZ_STARTED | SHOW_SCOREBOARD => {}
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

    fn joined_node(node_id: &str, username: &str, via: &mut QuizEngine) -> QuizEngine {
        let mut node = QuizEngine::new(node_id.into(), username.into());
        node.join(&via.quiz_id()).unwrap();
        sync(&mut node, via);
        node.create_event(PEER_JOINED, "{}", &format!("{node_id}-joined"))
            .unwrap();
        sync(&mut node, via);
        node
    }

    fn answer(node: &mut QuizEngine, key: &str) -> Result<String, String> {
        let payload = json!({ "questionId": "q1", "answer": key }).to_string();
        node.create_event(
            ANSWER_SUBMITTED,
            &payload,
            &format!("{}-answer-{key}", node.node_id),
        )
    }

    #[test]
    fn quiz_id_is_sha256_of_domain_creator_and_timestamp() {
        assert_eq!(
            quiz_id_for("example.github.io", "x", "2026-10-04T10:31:42.123Z"),
            "6371cd41f75003f6313635b9174311bca12d5d9af13f4812c07e41afad14af48"
        );
    }

    #[test]
    fn creator_can_leave_and_the_others_finish_with_the_same_scoreboard() {
        let mut x = QuizEngine::new("node-x".into(), "x".into());
        x.create("example.github.io", "2026-10-04T10:31:42.123Z", "created")
            .unwrap();
        x.create_event(PEER_JOINED, "{}", "x-joined").unwrap();
        let mut y = joined_node("node-y", "y", &mut x);
        let mut z = joined_node("node-z", "z", &mut y);
        sync(&mut x, &mut z);

        y.create_event(QUIZ_STARTED, "{}", "started").unwrap();
        sync(&mut x, &mut y);
        sync(&mut y, &mut z);
        answer(&mut x, "B").unwrap();
        answer(&mut y, "A").unwrap();
        answer(&mut z, "B").unwrap();
        assert!(
            answer(&mut z, "C").is_err(),
            "only one answer per participant"
        );
        sync(&mut x, &mut y);
        sync(&mut x, &mut z);
        sync(&mut y, &mut z);
        assert_eq!(
            state(&y)["answers"][0]["answer"],
            Value::Null,
            "answers stay hidden"
        );

        // x disappears. y and z finish the quiz on their own.
        drop(x);
        z.create_event(SHOW_SCOREBOARD, "{}", "scoreboard").unwrap();
        sync(&mut y, &mut z);

        let (sy, sz) = (state(&y), state(&z));
        assert_eq!(sy["phase"], "SCOREBOARD");
        assert_eq!(sy["scores"], sz["scores"]);
        let rows: Vec<(String, u64)> = sy["scores"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                (
                    row["username"].as_str().unwrap().to_owned(),
                    row["score"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(rows, [("x".into(), 1), ("z".into(), 1), ("y".into(), 0)]);
        assert_eq!(sy["scores"][0]["answerLabel"], "HTTPS");
    }

    #[test]
    fn concurrent_scoreboard_events_still_end_in_scoreboard() {
        let mut x = QuizEngine::new("node-x".into(), "x".into());
        x.create("localhost", "2026-10-04T10:31:42.123Z", "created")
            .unwrap();
        x.create_event(PEER_JOINED, "{}", "x-joined").unwrap();
        let mut y = joined_node("node-y", "y", &mut x);
        x.create_event(QUIZ_STARTED, "{}", "started").unwrap();
        sync(&mut x, &mut y);

        // Both press SHOW SCOREBOARD before hearing from each other.
        x.create_event(SHOW_SCOREBOARD, "{}", "x-scoreboard")
            .unwrap();
        y.create_event(SHOW_SCOREBOARD, "{}", "y-scoreboard")
            .unwrap();
        sync(&mut x, &mut y);

        assert_eq!(state(&x)["phase"], "SCOREBOARD");
        assert_eq!(state(&x)["scores"], state(&y)["scores"]);
        assert_eq!(x.get_events(), y.get_events());
    }

    #[test]
    fn duplicates_are_ignored_and_lamport_follows_the_rules() {
        let mut x = QuizEngine::new("node-x".into(), "x".into());
        let created = x
            .create("localhost", "2026-10-04T10:31:42.123Z", "created")
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
