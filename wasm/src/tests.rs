use super::*;

/// A small quiz in the cyber-quizzer format with every question type, plus two
/// questions this app leaves out.
const QUIZ: &str = r#"{
  "emoji": "🧪", "titel": "Test quiz", "fag": "Testing",
  "runder": [{ "id": 1, "navn": "Warm-up", "emoji": "🔥" }, { "id": 2, "navn": "Finale" }],
  "spoergsmaal": [
    { "runde": 1, "type": "mc", "emoji": "🔒", "titel": "Padlock",
      "tekst": "Which protocol keeps web traffic *secret*?",
      "svar": ["HTTP", "HTTPS", "FTP", "SMTP"], "rigtigt": 1, "forklaring": "The S is for secure." },
    { "runde": 1, "type": "sandtfalsk", "tekst": "A STUN server relays the quiz.", "rigtigt": false },
    { "runde": 2, "type": "raekkefoelge", "tekst": "Order the handshake.",
      "elementer": ["offer", "answer", "ICE", "DataChannel"] },
    { "runde": 2, "type": "estimat", "tekst": "How many bits does SHA-256 make?",
      "min": 0, "max": 1000, "trin": 1, "rigtigt": 256, "enhed": "bits" },
    { "runde": 2, "type": "estimat", "tekst": "When was DEF CON held first?",
      "min": 1980, "max": 2010, "rigtigt": 1992, "tolerance": 3, "aar": true },
    { "type": "video", "tekst": "An unknown type: left out." },
    { "type": "mc", "tekst": "No such right option: left out.", "svar": ["a", "b"], "rigtigt": 5 }
  ]
}"#;

const OTHER: &str = r#"{ "titel": "Other quiz", "spoergsmaal": [
  { "type": "sandtfalsk", "tekst": "Rust compiles to WebAssembly.", "rigtigt": true },
  { "type": "mc", "tekst": "Which clock orders the events?", "svar": ["A wall clock", "A Lamport clock"], "rigtigt": 1 }
] }"#;

fn all_right() -> [Value; 5] {
    [
        json!(1),
        json!(false),
        json!([0, 1, 2, 3]),
        json!(256),
        json!(1990),
    ]
}

fn parse(quiz: &str) -> Quiz {
    Quiz::parse(&serde_json::from_str(quiz).unwrap()).unwrap()
}

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
    let created_at = "2026-10-04T10:31:42.123Z";
    node.create("example.github.io", created_at, relay, QUIZ, "created")
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

/// Answers a question of the round this node currently sees.
fn answer(node: &mut QuizEngine, question: usize, answer: Value) -> Result<String, String> {
    let quiz = state(node)["quiz"].clone();
    let round = quiz["round"].as_u64().unwrap();
    let payload = json!({ "round": round, "contentId": quiz["contentId"], "question": question, "answer": answer });
    let id = format!("{}-{round}-{question}", node.node_id);
    node.create_event(ANSWER_SUBMITTED, &payload.to_string(), &id)
}

fn answer_all(node: &mut QuizEngine, answers: &[Value]) {
    for (i, a) in answers.iter().enumerate() {
        answer(node, i, a.clone()).unwrap();
    }
}

fn manage(node: &mut QuizEngine, kind: &str, round: u64) -> Result<String, String> {
    let payload = json!({ "round": round }).to_string();
    node.create_event(kind, &payload, &format!("{}-{kind}-{round}", node.node_id))
}

fn restart_with(node: &mut QuizEngine, round: u64, quiz: &str) -> Result<String, String> {
    let quiz: Value = serde_json::from_str(quiz).unwrap();
    let payload = json!({ "round": round, "quiz": quiz }).to_string();
    let id = format!("{}-restart-{round}", node.node_id);
    node.create_event(QUIZ_RESTARTED, &payload, &id)
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
    assert_eq!(name, names::quiz_name(&x.quiz_id()));
}

#[test]
fn quizzes_are_read_leniently_and_get_a_stable_content_id() {
    let quiz = parse(QUIZ);
    assert_eq!(
        quiz.spoergsmaal.len(),
        5,
        "the unknown and the broken question are left out"
    );
    let again = Quiz::parse(&json!(quiz)).unwrap();
    assert_eq!(
        again.content_id(),
        quiz.content_id(),
        "stable after a round trip through an event"
    );
    assert_ne!(parse(OTHER).content_id(), quiz.content_id());
    assert!(Quiz::parse(&json!({ "titel": "Empty", "spoergsmaal": [] })).is_err());
    assert!(Quiz::parse(&json!({ "spoergsmaal": [] })).is_err());

    let summary: Value = serde_json::from_str(&check_quiz(QUIZ).unwrap()).unwrap();
    assert_eq!(summary["title"], "Test quiz");
    assert_eq!(summary["questionCount"], 5);
    assert_eq!(summary["contentId"], quiz.content_id());
    assert_eq!(
        quiz.section(&quiz.spoergsmaal[0]).as_deref(),
        Some("🔥 Warm-up")
    );
    assert_eq!(
        quiz.section(&quiz.spoergsmaal[2]).as_deref(),
        Some("Finale")
    );
}

#[test]
fn answers_are_graded_like_on_the_cyber_quizzer_pages() {
    let quiz = parse(QUIZ);
    let q = &quiz.spoergsmaal;
    let grade = |i: usize, answer: Value| q[i].grade(&answer).map(|g| (g.correct, g.detail));
    let detail = |text: &str| Some(text.to_owned());
    assert_eq!(grade(0, json!(1)), Some((true, None)));
    assert_eq!(grade(0, json!(3)), Some((false, None)));
    assert_eq!(grade(0, json!(4)), None, "there is no option E");
    assert_eq!(grade(0, json!("B")), None);
    assert_eq!(grade(1, json!(false)), Some((true, None)));
    assert_eq!(grade(1, json!(0)), None);
    assert_eq!(grade(2, json!([0, 1, 2, 3])), Some((true, None)));
    assert_eq!(
        grade(2, json!([1, 0, 2, 3])),
        Some((false, detail("2 of 4 in the right place.")))
    );
    assert_eq!(
        grade(2, json!([0, 0, 2, 3])),
        None,
        "every item exactly once"
    );
    // At most 15 % off counts: 256 * 1.15 = 294.4.
    assert_eq!(grade(3, json!(256)), Some((true, detail("Spot on."))));
    assert_eq!(grade(3, json!(294)), Some((true, detail("15 % off."))));
    assert_eq!(grade(3, json!(300)), Some((false, detail("17 % off."))));
    assert_eq!(grade(3, json!(1001)), None, "outside the slider");
    // With a tolerance, a fixed distance counts.
    assert_eq!(grade(4, json!(1995)), Some((true, detail("3 years off."))));
    assert_eq!(grade(4, json!(1996)), Some((false, detail("4 years off."))));

    assert_eq!(q[0].label(&json!(2)), "FTP");
    assert_eq!(q[1].right_answer(), "False");
    assert_eq!(
        q[2].label(&json!([1, 0, 2, 3])),
        "answer → offer → ICE → DataChannel"
    );
    assert_eq!(q[3].right_answer(), "256 bits");
    assert_eq!(q[4].right_answer(), "1992");
    assert_eq!(content::number(45000.0, false), "45.000");
    assert_eq!(content::number(1234567.0, false), "1.234.567");
    assert_eq!(content::number(2.5, false), "2,5");
}

#[test]
fn ordering_items_are_shuffled_per_node_but_never_already_right() {
    for seed in ["a", "b", "c", "node-y|1|0123abcd|2"] {
        let order = content::shuffled(4, seed);
        let mut sorted = order.clone();
        sorted.sort();
        assert_eq!(sorted, [0, 1, 2, 3]);
        assert_ne!(order, [0, 1, 2, 3]);
        assert_eq!(order, content::shuffled(4, seed), "the same after a reload");
    }
    assert_ne!(
        content::shuffled(6, "node-x"),
        content::shuffled(6, "node-y")
    );
}

#[test]
fn players_answer_at_their_own_pace_and_the_creator_can_leave() {
    let mut x = created("node-x", "x"); // manages, does not play
    let mut y = joined("node-y", "y", &mut x);
    assert_eq!(state(&y)["quiz"]["title"], "Test quiz");
    answer_all(&mut y, &all_right());
    let play = state(&y)["play"].clone();
    assert_eq!(play["score"], 5);
    assert_eq!(play["finished"], true);
    assert!(play["question"].is_null(), "nothing left to answer");
    assert_eq!(play["results"][0]["explanation"], "The S is for secure.");
    assert_eq!(play["results"][3]["detail"], "Spot on.");
    sync(&mut x, &mut y);
    assert_eq!(state(&x)["manage"]["players"][0]["marks"], "✅✅✅✅✅");

    // x disappears. z joins later through y and is still answering.
    drop(x);
    let mut z = joined("node-z", "z", &mut y);
    answer(&mut z, 0, json!(1)).unwrap();
    answer(&mut z, 1, json!(true)).unwrap();
    assert!(
        answer(&mut z, 0, json!(2)).is_err(),
        "one answer per question"
    );
    assert!(
        answer(&mut z, 2, json!([0, 1])).is_err(),
        "an answer must fit its question"
    );
    let play = state(&z)["play"].clone();
    assert_eq!(play["question"]["number"], 3);
    assert_eq!(play["question"]["kind"], "order");
    assert_eq!(play["question"]["section"], "Finale");
    assert_eq!(play["results"][1]["correct"], false);
    assert_eq!(play["results"][1]["answer"], "True");
    assert_eq!(play["results"][1]["rightAnswer"], "False");
    assert_eq!(
        scores(&play["leaderboard"]),
        [("y".into(), 5), ("z".into(), 1)],
        "the leaderboard is live"
    );

    // Finishing the round closes it for everybody, and both see the same scores.
    sync(&mut y, &mut z);
    manage(&mut z, QUIZ_FINISHED, 1).unwrap();
    sync(&mut y, &mut z);
    let (sy, sz) = (state(&y), state(&z));
    assert_eq!(sy["quiz"]["status"], "FINISHED");
    assert_eq!(sy["quiz"]["changedBy"], "z");
    assert!(
        answer(&mut z, 2, json!([0, 1, 2, 3])).is_err(),
        "no answers after finishing"
    );
    assert!(sz["play"]["question"].is_null());
    assert_eq!(sy["manage"], sz["manage"]);
    assert_eq!(
        scores(&sz["manage"]["players"]),
        [("y".into(), 5), ("z".into(), 1), ("x".into(), 0)]
    );
    assert_eq!(sz["manage"]["players"][1]["marks"], "✅❌➖➖➖");
    assert_eq!(sz["manage"]["questions"][1]["answered"], 2);
    assert_eq!(sz["manage"]["questions"][1]["correct"], 1);
}

#[test]
fn concurrent_management_clicks_converge_and_a_restart_starts_empty() {
    let mut x = created("node-x", "x");
    let mut y = joined("node-y", "y", &mut x);
    answer(&mut y, 0, json!(1)).unwrap();
    sync(&mut x, &mut y);
    let content_id = state(&y)["quiz"]["contentId"].clone();

    // Both finish round 1, then both restart into round 2, without hearing from each other.
    manage(&mut x, QUIZ_FINISHED, 1).unwrap();
    manage(&mut y, QUIZ_FINISHED, 1).unwrap();
    manage(&mut x, QUIZ_RESTARTED, 2).unwrap();
    manage(&mut y, QUIZ_RESTARTED, 2).unwrap();
    // A late answer for round 1 must not count anywhere.
    let late = json!({ "round": 1, "contentId": content_id, "question": 1, "answer": false });
    assert!(y
        .create_event(ANSWER_SUBMITTED, &late.to_string(), "late")
        .is_err());
    sync(&mut x, &mut y);

    assert_eq!(x.get_events(), y.get_events());
    let (sx, sy) = (state(&x), state(&y));
    assert_eq!(sx["quiz"]["round"], 2);
    assert_eq!(sx["quiz"]["status"], "OPEN");
    assert_eq!(
        sx["quiz"]["contentId"], content_id,
        "the same questions again"
    );
    assert_eq!(sx["manage"], sy["manage"]);
    assert_eq!(
        sy["manage"]["answerCount"], 0,
        "a new round starts without answers"
    );
    assert_eq!(sy["play"]["question"]["number"], 1);
}

#[test]
fn a_new_round_can_switch_quiz_and_answers_to_other_questions_do_not_count() {
    let mut x = created("node-x", "x");
    let mut y = joined("node-y", "y", &mut x);
    let first = state(&y)["quiz"]["contentId"].clone();
    answer(&mut y, 0, json!(1)).unwrap(); // round 1

    // At the same moment, x starts round 2 with another quiz and y with the same one.
    restart_with(&mut x, 2, OTHER).unwrap();
    manage(&mut y, QUIZ_RESTARTED, 2).unwrap();
    assert_eq!(state(&x)["quiz"]["title"], "Other quiz");
    answer(&mut x, 0, json!(true)).unwrap();
    answer(&mut y, 0, json!(1)).unwrap(); // the first quiz, as far as y knows
    sync(&mut x, &mut y);

    // Both converge on the restart that comes first in the deterministic order …
    assert_eq!(x.get_events(), y.get_events());
    let (sx, sy) = (state(&x), state(&y));
    assert_eq!(sx["quiz"], sy["quiz"]);
    assert_eq!(sy["quiz"]["title"], "Other quiz");
    assert_ne!(sy["quiz"]["contentId"], first);
    // … and only answers to its questions count.
    assert_eq!(scores(&sy["play"]["leaderboard"]), [("x".into(), 1)]);
    assert_eq!(
        sy["play"]["question"]["text"],
        "Rust compiles to WebAssembly."
    );
    assert_eq!(sx["manage"], sy["manage"]);
}

#[test]
fn duplicates_are_ignored_and_lamport_follows_the_rules() {
    let mut x = QuizEngine::new("node-x".into(), "x".into());
    let created_at = "2026-10-04T10:31:42.123Z";
    let created = x
        .create("localhost", created_at, "null", QUIZ, "created")
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
    // A QUIZ_CREATED without questions (an older version of this app) is not accepted.
    event["eventId"] = json!("no-questions");
    event["payload"]["quiz"] = Value::Null;
    assert!(y.apply_event(&event.to_string()).is_err());
}

/// The quizzes copied from cyber-quizzer (npm run quizzes): every question can be shown.
#[test]
fn the_cyber_quizzer_quizzes_are_read_completely() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../quizzes");
    let mut count = 0;
    for entry in std::fs::read_dir(&dir).expect("quizzes/ exists") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let quiz = Quiz::parse(&value).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let questions = value["spoergsmaal"].as_array().unwrap().len();
        assert_eq!(quiz.spoergsmaal.len(), questions, "{}", path.display());
        count += 1;
    }
    assert!(count > 0, "no quizzes in {}", dir.display());
}
