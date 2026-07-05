// combo_descriptions.js — generated experiential descriptions for every
// mood/speed/setting combination used in gacha-engine.js prompt building.
// These replace the raw tag labels so the LLM has something evocative to
// work from when naming and curating playlists, rather than just clinical
// keywords it will parrot back literally.

const MOOD_DESC = {
  sunny:  "carefree and genuinely happy, no asterisk. song of the summer energy. romantic and hopeful. youthful and fleeting but you're fully in it, not mourning it yet.",
  rainy:  "interior and quiet, but also nostalgic and wanting. could be longing for something or someone. the world got smaller and your feelings got bigger.",
  stormy: "massive and unsubtle. the kind of feeling that fills a room before you can name it. heavy, dramatic, demanding. not background music — full presence required. something is at stake.",
  windy:  "restless, brisk, evanescent. moving toward something, light on your feet but not lightweight. the feeling passes quickly and that's part of it.",
  snowy:  "the world outside is white and muffled and everything slowed down. could be alone at a frosted window with something on your mind, or warm lights and familiar people and the smell of something baking. the cold is always there but what you do with it is up to you.",
  cloudy: "hazy and unhurried. not sad, not happy, just floating in the middle of the afternoon. things feel slightly surreal and that's fine. not trying to get anywhere.",
};

const SPEED_DESC = {
  snail:  "60 BPM and under. the tempo of a slow heartbeat. ambient, drone, very slow ballads. almost uncomfortably slow — the music has room to breathe and silence between notes matters.",
  stroll: "61–90 BPM. conversational pace. slow R&B, acoustic, bossa nova. unhurried but moving. the pace of a walk with no destination.",
  quick:  "91–120 BPM. the sweet spot of pop, indie, mid-tempo hip hop. alert and purposeful — brisk without being urgent.",
  fast:   "121–150 BPM. dance music, uptempo pop, driving rock. real momentum — things are moving and you're moving with them. you feel it in your chest.",
  ultra:  "150+ BPM. drum and bass, hardcore, hyperpop. fully committed, no brakes. the volume should probably be lower but it isn't.",
};

const SETTING_DESC = {
  bedroom: "private. this music is just for you, in the room where you're most yourself. could be lying on the floor staring at the ceiling or 2am on your phone.",
  cafe:    "semi-public, low stakes. you're present but not performing. there's ambient noise you're not hearing and a drink you're not finishing.",
  drive:   "the road and the music are the same thing for a while. windows up or down changes everything. you're between places and that's its own kind of freedom.",
  travel:  "displacement. airports, trains, the specific loneliness and excitement of being somewhere unfamiliar. your normal life is on pause.",
  gym:     "physical, focused, a little aggressive. your body is working and the music is working with it. no room for anything soft.",
  work:    "you need to be productive but you also need to not lose your mind. the music is doing something for your brain that you can't quite explain.",
};

// Returns a single experiential sentence for a given combo, used in the
// playlist curation prompt so the model reasons from feeling rather than labels.
function comboDescription(mood, speed, setting) {
  return [
    `Mood: ${MOOD_DESC[mood] || mood}`,
    `Pace: ${SPEED_DESC[speed] || speed}`,
    `Setting: ${SETTING_DESC[setting] || setting}`,
  ].join('\n');
}

module.exports = { comboDescription };
