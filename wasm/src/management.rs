//! Quiz management: the quiz itself, who is in it, and its rounds.
//!
//! The quiz is open as soon as it is created; nobody has to press start. FINISHED
//! closes the current round for everybody, RESTARTED opens the next round. Rounds
//! only go up and a round only goes from OPEN to FINISHED, so two nodes clicking at
//! the same moment always end in the same state.

use serde::Serialize;
use serde_json::Value;

use crate::play::{self, Answers, ScoreRow};
use crate::Event;

pub const QUIZ_CREATED: &str = "QUIZ_CREATED";
pub const PEER_JOINED: &str = "PEER_JOINED";
pub const QUIZ_FINISHED: &str = "QUIZ_FINISHED";
pub const QUIZ_RESTARTED: &str = "QUIZ_RESTARTED";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Status {
    Open,
    Finished,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub node_id: String,
    pub username: String,
}

/// The management side of the replayed event log.
pub struct Lifecycle {
    pub created_at: Option<String>,
    /// Where new nodes can knock to join with one click: `{ topic, key }`, or null.
    pub relay: Value,
    pub round: u32,
    pub status: Status,
    /// Who finished or restarted the current round.
    pub changed_by: Option<String>,
    pub participants: Vec<Participant>,
}

impl Lifecycle {
    pub fn new() -> Self {
        Lifecycle {
            created_at: None,
            relay: Value::Null,
            round: 1,
            status: Status::Open,
            changed_by: None,
            participants: Vec::new(),
        }
    }

    pub fn is_participant(&self, node_id: &str) -> bool {
        self.participants.iter().any(|p| p.node_id == node_id)
    }

    pub fn apply(&mut self, e: &Event) {
        match e.kind.as_str() {
            QUIZ_CREATED if self.created_at.is_none() => {
                self.created_at = e.payload["createdAt"].as_str().map(str::to_owned);
                self.relay = e.payload["relay"].clone();
            }
            PEER_JOINED if !self.is_participant(&e.node_id) => {
                self.participants.push(Participant {
                    node_id: e.node_id.clone(),
                    username: e.username.clone(),
                })
            }
            QUIZ_FINISHED if self.status == Status::Open && e.round() == Some(self.round) => {
                self.status = Status::Finished;
                self.changed_by = Some(e.username.clone());
            }
            QUIZ_RESTARTED if e.round() == Some(self.round + 1) => {
                self.round += 1;
                self.status = Status::Open;
                self.changed_by = Some(e.username.clone());
            }
            // Repeats (a second FINISHED or RESTARTED for the same round) change nothing.
            _ => {}
        }
    }
}

/// What the management screen shows: everybody's progress, live.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManageView {
    /// Every participant, best score first. Individual answers only once the round is finished.
    pub players: Vec<ScoreRow>,
    pub answer_count: usize,
}

pub fn view(quiz: &Lifecycle, answers: &Answers) -> ManageView {
    let reveal = quiz.status == Status::Finished;
    ManageView {
        players: play::ranking(answers, &quiz.participants, reveal),
        answer_count: answers.len(),
    }
}
