//! Quiz names: five short words derived from the quiz id, easy to read out loud.

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
