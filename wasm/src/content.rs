//! The quiz content, in the JSON format of https://github.com/andracs/cyber-quizzer
//! (field names in Danish):
//!
//! ```json
//! { "emoji": "🕵️", "titel": "…", "undertitel": "…", "fag": "…",
//!   "runder": [{ "id": 1, "navn": "…", "emoji": "📜" }],
//!   "spoergsmaal": [{ "runde": 1, "type": "mc", "emoji": "⚖️", "titel": "…", "tekst": "…",
//!                     "svar": ["…", "…"], "rigtigt": 2, "forklaring": "…" }] }
//! ```
//!
//! Four question types, graded like on the cyber-quizzer pages:
//! - "mc": `svar` are the options, `rigtigt` is the index of the right one;
//! - "sandtfalsk": `rigtigt` is true or false;
//! - "raekkefoelge": `elementer` in the right order; right only if all are in place;
//! - "estimat": a number between `min` and `max` in steps of `trin`, right if it is at most
//!   15 % from `rigtigt`, or at most `tolerance` away when that is set. `aar` marks a year.
//!
//! "runder" are sections of one quiz. They have nothing to do with the rounds of the
//! P2P quiz, which start when someone restarts it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Quiz {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    pub titel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undertitel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fag: Option<String>,
    #[serde(default)]
    pub runder: Vec<Section>,
    pub spoergsmaal: Vec<Question>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Section {
    pub id: u32,
    pub navn: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Question {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runde: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub titel: Option<String>,
    pub tekst: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forklaring: Option<String>,
    #[serde(flatten)]
    pub kind: Kind,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Kind {
    #[serde(rename = "mc")]
    Choice { svar: Vec<String>, rigtigt: usize },
    #[serde(rename = "sandtfalsk")]
    TrueFalse { rigtigt: bool },
    #[serde(rename = "raekkefoelge")]
    Order { elementer: Vec<String> },
    #[serde(rename = "estimat")]
    Estimate(Estimate),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Estimate {
    pub min: f64,
    pub max: f64,
    #[serde(default = "one")]
    pub trin: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
    #[serde(default)]
    pub enhed: String,
    pub rigtigt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<f64>,
    #[serde(default)]
    pub aar: bool,
}

fn one() -> f64 {
    1.0
}

/// How an answer did.
pub struct Grade {
    pub correct: bool,
    /// "3 of 5 in the right place." for an order, "12 % off." for an estimate.
    pub detail: Option<String>,
}

impl Quiz {
    /// Reads a quiz and leaves out the questions this app cannot show (an unknown type, or
    /// one that does not add up). Fails if no question is left.
    pub fn parse(value: &Value) -> Result<Quiz, String> {
        #[derive(Deserialize)]
        struct Raw {
            #[serde(default)]
            emoji: Option<String>,
            titel: String,
            #[serde(default)]
            undertitel: Option<String>,
            #[serde(default)]
            fag: Option<String>,
            #[serde(default)]
            runder: Vec<Value>,
            spoergsmaal: Vec<Value>,
        }
        let raw = Raw::deserialize(value).map_err(|e| format!("not a quiz: {e}"))?;
        let quiz = Quiz {
            emoji: raw.emoji.filter(|e| !e.trim().is_empty()),
            titel: raw.titel.trim().to_owned(),
            undertitel: raw.undertitel,
            fag: raw.fag,
            runder: raw
                .runder
                .iter()
                .filter_map(|r| Section::deserialize(r).ok())
                .collect(),
            spoergsmaal: raw
                .spoergsmaal
                .iter()
                .filter_map(|q| Question::deserialize(q).ok())
                .filter(Question::is_valid)
                .collect(),
        };
        if quiz.titel.is_empty() {
            return Err("the quiz has no title".into());
        }
        if quiz.spoergsmaal.is_empty() {
            return Err(format!(
                "“{}” has no question this app can show",
                quiz.titel
            ));
        }
        Ok(quiz)
    }

    /// Identifies the questions: the same quiz gives the same id on every node.
    pub fn content_id(&self) -> String {
        let json = serde_json::to_string(self).expect("a quiz is always serializable");
        Sha256::digest(json)
            .iter()
            .take(8)
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    /// "📜 Med eller uden aftale": the section a question belongs to.
    pub fn section(&self, question: &Question) -> Option<String> {
        let section = self.runder.iter().find(|s| Some(s.id) == question.runde)?;
        Some(match &section.emoji {
            Some(emoji) => format!("{emoji} {}", section.navn),
            None => section.navn.clone(),
        })
    }
}

impl Question {
    fn is_valid(&self) -> bool {
        if self.tekst.trim().is_empty() {
            return false;
        }
        match &self.kind {
            Kind::Choice { svar, rigtigt } => {
                (2..=6).contains(&svar.len()) && *rigtigt < svar.len()
            }
            Kind::TrueFalse { .. } => true,
            Kind::Order { elementer } => (2..=10).contains(&elementer.len()),
            Kind::Estimate(e) => {
                let numbers = [e.min, e.max, e.trin, e.rigtigt, e.start.unwrap_or(e.min)];
                numbers.iter().all(|x| x.is_finite())
                    && e.min < e.max
                    && e.trin > 0.0
                    && (e.max - e.min) / e.trin <= 100_000.0
                    && e.tolerance.is_none_or(|t| t.is_finite() && t >= 0.0)
            }
        }
    }

    /// "choice", "truefalse", "order" or "estimate", for the page.
    pub fn kind_name(&self) -> &'static str {
        match self.kind {
            Kind::Choice { .. } => "choice",
            Kind::TrueFalse { .. } => "truefalse",
            Kind::Order { .. } => "order",
            Kind::Estimate(_) => "estimate",
        }
    }

    /// The short title, or the beginning of the text.
    pub fn title(&self) -> String {
        match &self.titel {
            Some(title) if !title.trim().is_empty() => title.clone(),
            _ => shorten(&self.tekst, 60),
        }
    }

    /// Grades an answer. None if it does not fit the question at all: the wrong type,
    /// an option that does not exist, a number outside the slider, …
    ///
    /// Answers in ANSWER_SUBMITTED events: "mc" the index of an option, "sandtfalsk"
    /// true or false, "raekkefoelge" the item indexes in the order the player put them,
    /// "estimat" the number.
    pub fn grade(&self, answer: &Value) -> Option<Grade> {
        match &self.kind {
            Kind::Choice { svar, rigtigt } => {
                let k = index(answer).filter(|&k| k < svar.len())?;
                Some(Grade {
                    correct: k == *rigtigt,
                    detail: None,
                })
            }
            Kind::TrueFalse { rigtigt } => {
                let said = answer.as_bool()?;
                Some(Grade {
                    correct: said == *rigtigt,
                    detail: None,
                })
            }
            Kind::Order { elementer } => {
                let order = permutation(answer, elementer.len())?;
                let n = order.len();
                let in_place = order
                    .iter()
                    .enumerate()
                    .filter(|(pos, id)| pos == *id)
                    .count();
                Some(Grade {
                    correct: in_place == n,
                    detail: (in_place < n)
                        .then(|| format!("{in_place} of {n} in the right place.")),
                })
            }
            Kind::Estimate(e) => {
                let guess = answer.as_f64().filter(|g| (e.min..=e.max).contains(g))?;
                let diff = (guess - e.rigtigt).abs();
                let (correct, miss) = match e.tolerance {
                    Some(tolerance) => {
                        let unit = if e.aar { "years" } else { e.enhed.as_str() };
                        let miss = format!("{} {unit}", number(diff, false));
                        (diff <= tolerance, (diff > 0.0).then_some(miss))
                    }
                    None => {
                        let off = diff / e.rigtigt.abs().max(1.0);
                        let percent = (off * 100.0).round();
                        (off <= 0.15, (percent > 0.0).then(|| format!("{percent} %")))
                    }
                };
                let detail = match miss {
                    Some(miss) => format!("{} off.", miss.trim()),
                    None => "Spot on.".to_owned(),
                };
                Some(Grade {
                    correct,
                    detail: Some(detail),
                })
            }
        }
    }

    /// An answer in words, for "Your answer: …".
    pub fn label(&self, answer: &Value) -> String {
        match &self.kind {
            Kind::Choice { svar, .. } => index(answer)
                .and_then(|k| svar.get(k))
                .cloned()
                .unwrap_or_default(),
            Kind::TrueFalse { .. } => yes_no(answer.as_bool() == Some(true)),
            Kind::Order { elementer } => match permutation(answer, elementer.len()) {
                Some(order) => order
                    .iter()
                    .map(|&i| elementer[i].as_str())
                    .collect::<Vec<_>>()
                    .join(" → "),
                None => String::new(),
            },
            Kind::Estimate(e) => e.show(answer.as_f64().unwrap_or_default()),
        }
    }

    /// The right answer in words.
    pub fn right_answer(&self) -> String {
        match &self.kind {
            Kind::Choice { svar, rigtigt } => svar[*rigtigt].clone(),
            Kind::TrueFalse { rigtigt } => yes_no(*rigtigt),
            Kind::Order { elementer } => elementer.join(" → "),
            Kind::Estimate(e) => e.show(e.rigtigt),
        }
    }
}

impl Estimate {
    /// A number with its unit: "45.000 pc'er".
    pub fn show(&self, value: f64) -> String {
        format!("{} {}", number(value, self.aar), self.enhed)
            .trim()
            .to_owned()
    }
}

/// Numbers as on the Danish cyber-quizzer pages: 45.000 and 2,5. A year stays 1992.
pub fn number(value: f64, year: bool) -> String {
    if year {
        return format!("{}", value.round());
    }
    let text = format!("{:.3}", value.abs());
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, ""));
    let mut grouped = String::new();
    for (i, digit) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push('.');
        }
        grouped.push(digit);
    }
    let fraction = fraction.trim_end_matches('0');
    let sign = if value < 0.0 && text.chars().any(|c| ('1'..='9').contains(&c)) {
        "-"
    } else {
        ""
    };
    match fraction {
        "" => format!("{sign}{grouped}"),
        _ => format!("{sign}{grouped},{fraction}"),
    }
}

/// The order in which one node sees the items of an ordering question: shuffled by its
/// own seed, so the same after a reload, and never already right.
pub fn shuffled(count: usize, seed: &str) -> Vec<usize> {
    let digest = Sha256::digest(seed);
    let mut state = u64::from_le_bytes(digest[..8].try_into().expect("8 bytes")) | 1;
    let mut order: Vec<usize> = (0..count).collect();
    for i in (1..count).rev() {
        // xorshift64
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        order.swap(i, (state % (i as u64 + 1)) as usize);
    }
    if order.iter().enumerate().all(|(pos, &id)| pos == id) {
        order.rotate_left(1);
    }
    order
}

fn index(value: &Value) -> Option<usize> {
    value.as_u64().and_then(|k| usize::try_from(k).ok())
}

/// Every item exactly once.
fn permutation(value: &Value, count: usize) -> Option<Vec<usize>> {
    let order: Vec<usize> = value.as_array()?.iter().map(index).collect::<Option<_>>()?;
    let mut seen = vec![false; count];
    for &id in &order {
        if id >= count || std::mem::replace(&mut seen[id], true) {
            return None;
        }
    }
    (order.len() == count).then_some(order)
}

fn yes_no(value: bool) -> String {
    if value { "True" } else { "False" }.to_owned()
}

fn shorten(text: &str, max: usize) -> String {
    let text = text.replace('*', "");
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
        None => text,
    }
}
