//! The quiz content: the questions, and the words that make up quiz names.
//! Edit the questions here; every node must run the same build.

pub struct Question {
    pub id: &'static str,
    pub text: &'static str,
    /// (key, label); the keys are what ANSWER_SUBMITTED events carry.
    pub options: [(&'static str, &'static str); 4],
    pub correct: &'static str,
}

pub static QUESTIONS: [Question; 5] = [
    Question {
        id: "q1",
        text: "Which protocol is normally used for secure web traffic?",
        options: [("A", "HTTP"), ("B", "HTTPS"), ("C", "FTP"), ("D", "SMTP")],
        correct: "B",
    },
    Question {
        id: "q2",
        text: "What does a STUN server tell a browser?",
        options: [
            ("A", "Its public IP address and port"),
            ("B", "The answers to the quiz"),
            ("C", "The time of day"),
            ("D", "The Wi-Fi password"),
        ],
        correct: "A",
    },
    Question {
        id: "q3",
        text: "Where do the quiz rules of this app run?",
        options: [
            ("A", "On a web server"),
            ("B", "In a database"),
            ("C", "In Rust compiled to WebAssembly"),
            ("D", "In a spreadsheet"),
        ],
        correct: "C",
    },
    Question {
        id: "q4",
        text: "Which clock puts the quiz events in the same order on every node?",
        options: [
            ("A", "The wall clock"),
            ("B", "An atomic clock"),
            ("C", "A stopwatch"),
            ("D", "A Lamport clock"),
        ],
        correct: "D",
    },
    Question {
        id: "q5",
        text: "What does WebRTC use to find a network path between two browsers?",
        options: [("A", "DNS"), ("B", "ICE"), ("C", "FTP"), ("D", "SMTP")],
        correct: "B",
    },
];

pub fn question(id: &str) -> Option<&'static Question> {
    QUESTIONS.iter().find(|q| q.id == id)
}

impl Question {
    pub fn label(&self, key: &str) -> Option<&'static str> {
        self.options
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, label)| *label)
    }
}

/// 256 short words: one byte of the quiz id picks one word.
const WORDS: [&str; 256] = [
    "ant", "ape", "bat", "bear", "bee", "bird", "boar", "bug", "calf", "cat", "clam", "cod",
    "colt", "cow", "crab", "crow", "deer", "dog", "dove", "duck", "eel", "elk", "emu", "fish",
    "fox", "frog", "goat", "gull", "hare", "hawk", "hen", "ibis", "jay", "kiwi", "lamb", "lark",
    "lion", "lynx", "mole", "moth", "mouse", "mule", "newt", "owl", "ox", "panda", "pig", "pony",
    "puma", "ram", "robin", "seal", "shark", "sheep", "snail", "swan", "tiger", "toad", "trout",
    "tuna", "wasp", "whale", "wolf", "yak", "zebra", "acorn", "bay", "beach", "berry", "bloom",
    "brook", "bush", "cave", "cliff", "cloud", "coast", "coral", "creek", "dawn", "dew", "dune",
    "dusk", "earth", "fern", "field", "flame", "fog", "frost", "glade", "grass", "grove", "hill",
    "ice", "isle", "lake", "leaf", "lily", "marsh", "mist", "moon", "moss", "oak", "ocean", "palm",
    "peak", "pine", "pond", "rain", "reef", "ridge", "river", "rock", "rose", "sand", "sea",
    "seed", "shore", "sky", "snow", "soil", "star", "stone", "storm", "sun", "thorn", "tide",
    "tree", "tulip", "vale", "wave", "wind", "wood", "amber", "bold", "brave", "brisk", "busy",
    "calm", "clear", "cool", "cozy", "crisp", "eager", "early", "easy", "fair", "fancy", "fast",
    "fine", "firm", "fond", "free", "fresh", "glad", "gold", "good", "grand", "happy", "hardy",
    "jolly", "keen", "kind", "light", "lucky", "merry", "mild", "neat", "nice", "noble", "proud",
    "quick", "quiet", "rapid", "ready", "rich", "rosy", "royal", "safe", "shiny", "sleek", "slow",
    "smart", "snug", "soft", "solid", "sunny", "sweet", "swift", "tall", "tidy", "tiny", "true",
    "warm", "wild", "wise", "witty", "young", "blue", "green", "red", "pink", "teal", "lime",
    "mint", "rust", "plum", "navy", "ruby", "jade", "apple", "arrow", "badge", "ball", "band",
    "bell", "bench", "bike", "boat", "book", "boot", "bowl", "box", "brick", "broom", "brush",
    "cake", "camp", "cap", "card", "cart", "chair", "chalk", "clock", "coat", "coin", "comb",
    "cone", "cord", "cork", "cup", "desk", "dial", "dish", "door", "drum", "fan", "flag", "flute",
    "fork", "frame", "gate", "gem", "glove", "harp", "hat", "hook",
];

/// Five short words made from the first five bytes of the quiz id (a SHA-256 hash in hex).
/// Every node derives the same name, and it is easy to read out loud.
pub fn quiz_name(quiz_id: &str) -> String {
    let words: Option<Vec<&str>> = (0..5)
        .map(|i| quiz_id.get(i * 2..i * 2 + 2))
        .map(|hex| {
            u8::from_str_radix(hex?, 16)
                .ok()
                .map(|byte| WORDS[byte as usize])
        })
        .collect();
    words.map(|w| w.join(" ")).unwrap_or_default()
}
