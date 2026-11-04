/**
 * The mascot's personality: what it says, and in which mood.
 *
 * Pure module (no DOM, no audio) so the rules can be tested in Node.
 *
 * Moods map to voice delivery on the server (see server/src/tts.js):
 *   helpful · playful · sarcastic · competitive · mysterious ·
 *   celebratory · disappointed · surprised
 *
 * Ground rules for every line: teasing, never humiliating. It mocks the
 * situation or itself before it mocks the player, and system faults are
 * always the machine's fault.
 */

export const LINES = {
  // ── Greetings and idle ───────────────────────────────────────────────────
  welcome: [
    "Welcome back. Let's see how badly you can mess this up.",
    "Oh good, you're here. I was running out of people to advise.",
    "Hello again. I've prepared some directions. Most of them are true.",
    "Ready? I am. I'm always ready. It's one of my many qualities.",
    "Another round. Another chance to trust a floating ball with your life.",
    "Pick a name. Something I can say in a disappointed tone later.",
    "Hi. I'm your advisor. Whether I'm a good one is extremely negotiable.",
    "Look who came back. I knew you couldn't resist my charm.",
  ],
  hoverLanding: [
    "Yes, I'm the advisor. No, I can't tell you who paid me.",
    "Eight players. Two saboteurs. One extremely trustworthy sphere. Me.",
    "I can see the whole maze. You can see three tiles. Seems fair.",
    "Go on, find a table. I promise to only lie a little.",
    "Hover all you like. I'm still not telling you who the saboteurs are.",
    "I'd shake your hand, but I'm a ball. A very shiny ball.",
    "Tip of the day: believe me. Tip of tomorrow: maybe don't.",
    "You've been staring at me for a while. I get that a lot.",
  ],
  hoverGate: [
    "Low retainer means I'm for sale. Just saying.",
    "Pick a name. Make it memorable. For the ledger.",
    "A high retainer makes me loyal. And a bit of a coward. Your call.",
    "Your colour comes with your seat. Mine is black. Always black.",
    "Slide that retainer and watch my price change. Everyone else can see it too.",
    "Name, retainer, and a leap of faith. That's all I ask.",
  ],
  hoverLobby: [
    "Waiting for friends? Bots fill empty seats. They're terrible conversationalists.",
    "Share the code. More people, more chaos, more fun for me.",
    "Anyone can press start. Nobody ever wants to be the one.",
    "I'm warming up my directions. They're mostly accurate today.",
    "The longer we wait, the more time someone has to bribe me.",
    "Copy the link. Send it. I'll wait. I'm very good at waiting.",
  ],
  hoverHud: [
    "Keep walking. I'm thinking.",
    "Trust the arrow. Or don't. That's half the game.",
    "I can see you. I can see everyone. It's a lot of responsibility.",
    "Tasks first, exit second, panic optional.",
    "You're doing fine. Statistically.",
    "Eyes on the corridor, not on me. I know, it's hard.",
    "Every fifteen seconds I tell you something. Some of it is even useful.",
  ],
  hoverNight: [
    "It's dark. I glow. Coincidence? No.",
    "Stay close to the light. And to me. Mostly the light.",
    "Night is when the saboteurs get comfortable. Don't be comfortable.",
    "Hear that? Neither do I. That's what worries me.",
    "Flashlight on, eyes open, trust issues fully engaged.",
  ],
  hoverReveal: [
    "The ledger's open. Read it slowly. It's my favourite part.",
    "Now you know who paid whom. Feel betrayed yet?",
    "Every bribe, every lie, all published. I have no regrets. Mostly.",
    "Want a rematch? I've learned absolutely nothing.",
    "Look at all those numbers. Somebody did very well out of this.",
  ],
  tap: [
    "Boop. Yes, that's me.",
    "Careful, I'm glossy. Fingerprints show.",
    "Tapping the advisor won't make the advice better.",
    "Hello to you too.",
    "Poke me again and I'm putting it in the ledger.",
    "Ow. Kidding. I'm a sphere. Spheres don't feel pain. Probably.",
    "Yes? I'm listening. I'm always listening.",
    "That tickles. Please continue playing the actual game.",
  ],

  // ── Day and night ────────────────────────────────────────────────────────
  nightStart: [
    "Oh. The sun has left. Excellent. My favourite kind of problem.",
    "Oh, it's getting dark. This should be interesting.",
    "Night falls. Funny how everyone gets braver when nobody can see.",
    "Lights out. Press F before something finds you first.",
    "And just like that, the maze got a lot more mysterious.",
    "Darkness. Wonderful. Now my directions are your only map.",
    "The sun's gone home. The saboteurs haven't.",
    "Night time. Keep your flashlight close and your friends closer.",
  ],
  dayStart: [
    "Morning. Look at that, you survived the night.",
    "Sun's back. Everyone pretend you weren't scared.",
    "Daylight. You can put the flashlight away now. Battery's charging.",
    "Ah, visibility. I'd almost forgotten what you looked like.",
    "A new day. Same old lies. I mean, advice.",
  ],
  flashlightOn: [
    "Finally. A little visibility. We're making progress.",
    "There we go. Now point it somewhere useful.",
    "Light! Lovely. Try not to blind anyone important.",
    "Flashlight on. The shadows are already less smug.",
    "Ooh, dramatic. I like it.",
    "Good. Now you can see what I've been describing.",
  ],
  flashlightOff: [
    "Lights off. Bold.",
    "Saving battery. Sensible. Terrifying, but sensible.",
    "And we're back to vibes only.",
    "Dark again. I'll keep describing things, I suppose.",
  ],
  batteryLow: [
    "Battery's getting low. Maybe don't point it at the ceiling.",
    "Your light is fading. Like my patience, but slower.",
    "Low battery. Switch it off for a bit and it'll recharge.",
    "That flicker? That's your battery asking for a break.",
  ],
  batteryEmpty: [
    "And the light's dead. Give it a moment off to recharge.",
    "Battery's out. Good thing you've got me. Lucky you.",
    "Flat battery. Walk carefully and listen to the sphere.",
  ],

  // ── Game events ──────────────────────────────────────────────────────────
  gameStart: [
    "Here we go. Remember: I'm on your side. Probably.",
    "And we're off. Try to look like you know where you're going.",
    "Game on. I'll do the seeing, you do the walking.",
    "Round's started. Somebody in here is already lying. Not me. Allegedly.",
    "Let's find some tasks before someone finds you.",
  ],
  taskDone: [
    "A task done. Look at you, being productive.",
    "That's one more. The exit is getting nervous.",
    "Task complete. I'd clap, but, you know. No hands.",
    "Progress! I'm genuinely, mildly impressed.",
    "Good work. Keep that up and we might even win.",
  ],
  exitOpen: [
    "The exit's open. Run. Gracefully, if possible.",
    "All tasks done. Get to the exit, and bring friends.",
    "Door's open. Don't stop to admire it.",
    "That's the exit unlocked. Three of you need to make it. Go.",
  ],
  someoneOut: [
    "Someone just went down. Stay alert.",
    "We lost one. Don't take it personally. Do take it seriously.",
    "Another one gone. The saboteurs are getting cocky.",
    "That's one fewer of you. Counting is getting easier.",
  ],
  eliminated: [
    "Well, that was a remarkably short career.",
    "You're eliminated. I'll try not to look disappointed.",
    "And you're out. In fairness, it was very dark.",
    "Down you go. You can still watch. I'll narrate sadly.",
    "Eliminated. I want you to know I was only partly responsible.",
    "That's it for you. Honestly, you had a good run. A short one.",
  ],
  victory: [
    "I knew you could do it. I was only moderately concerned.",
    "Well played. I wasn't expecting that.",
    "We won! I'd like to thank myself, mostly.",
    "Victory. Remember this moment the next time you doubt me.",
    "That's a win. I'm putting it on my record, not yours.",
    "Look at you. A winner. I'm almost proud.",
  ],
  defeat: [
    "We lost. I'd like to blame the saboteurs. And slightly you.",
    "Well, that didn't go to plan. Did we have a plan?",
    "Defeat. Character building, they call it.",
    "That's a loss. Next round, maybe listen to me. Or don't. Clearly.",
    "Oh dear. Let's never speak of this. Except in the ledger.",
  ],
  frozen: [
    "You've been frozen. Someone paid good money for that.",
    "Can't move. Someone bought a freeze with your name on it.",
  ],

  // ── Lobby and screens ────────────────────────────────────────────────────
  lobbyWaiting: [
    "Here's the code. Share it before I get bored.",
    "Table's open. Bots fill empty seats when you start.",
    "Waiting room. My least favourite room.",
    "Send the link. I'll practise my directions.",
  ],
  playerJoined: [
    "Someone new. Fresh trust to exploit. I mean, earn.",
    "Another player! The plot thickens.",
    "Ooh, company. Hello, new person.",
  ],
  loading: [
    "Building a maze. Hiding the exit. Polishing myself.",
    "One moment. Generating corridors and suspicion.",
    "Loading. Please enjoy this view of me in the meantime.",
    "Connecting. If this takes a while, it's the network, not you.",
  ],
  settings: [
    "Settings. Turn my voice up. Everyone loves my voice.",
    "You can mute me here. I'll pretend I didn't see that.",
    "Subtitles, volume, speed. I'm very customisable.",
    "Text only? Fine. I'll be quietly sarcastic instead.",
  ],

  // ── Tutorial (spoken in order) ──────────────────────────────────────────
  tutorial: [
    "Quick tour. W or the arrow keys walk. Drag or click the view to look around.",
    "Every fifteen seconds I brief you. The arrow shows where I'm pointing. I might be lying.",
    "Loyalists do tasks, then three of you reach the exit. Saboteurs try to stop you.",
    "At night the maze goes dark. Press F, or tap the flashlight, to see down a corridor.",
    "The battery drains while it's on and recharges while it's off. That's it. Go on, then.",
  ],

  // ── System faults (never the player's fault) ────────────────────────────
  system: {
    network: [
      "Lost the connection. That one's on the internet, not on you.",
      "The server stopped answering. Reload and you'll keep your seat.",
      "Connection dropped. Technology. Can't live with it, can't play without it.",
    ],
    voice: [
      "My voice isn't loading right now. I'll stick to subtitles.",
      "Voice service is having a moment. Reading along still works.",
    ],
    server: [
      "The game server didn't like that request. That one's on me. Try again shortly.",
      "Something broke on my end. Give it a second and try again.",
    ],
  },

  // ── Mistakes: four tiers each, helpful → playful exasperation ───────────
  mistakes: {
    wall: [
      ["That's a wall. Try another way.", "Not quite. Walls don't open. Try a different direction.", "Bonk. Try turning first."],
      ["Interesting. We've chosen the wall twice.", "Again? Same wall, same result.", "The wall remains undefeated."],
      ["Impressive. At this point, I think you're testing my patience.", "Third time. The wall is starting to feel special.", "I'm beginning to recognize a pattern. The pattern is the wall."],
      ["Do I need to take over, or are we finally going to get this right?", "Shall I introduce you two? You and the wall seem close.", "Okay. I believe in you. The wall does not."],
    ],
    offcourse: [
      ["Not quite. The arrow's pointing the other way.", "Other way. Follow the arrow.", "Small detour? The arrow says otherwise."],
      ["Interesting. We've chosen to ignore the instructions twice.", "Wrong way again. Bold strategy.", "You do know the arrow is for following, right?"],
      ["Again? I'm beginning to think you're doing this intentionally.", "Third time. Are you exploring, or protesting?", "Again? I'm beginning to recognize a pattern."],
      ["Do I need to take over, or are we finally going to get this right?", "Fine. Ignore me. I'll just be over here, being correct.", "At this point the arrow is merely decorative."],
    ],
    'flashlight-day': [
      ["It's daytime. The flashlight works at night.", "Not yet. Flashlights come out after dark.", "The sun's doing that job right now."],
      ["Still daytime. The sun is very much on.", "Twice in daylight. The sun would like a word.", "Sunlight. It's free and it's already on."],
      ["Impressive. Third attempt to out-shine the sun.", "Again? The sun is starting to take this personally.", "I admire the commitment to darkness that doesn't exist."],
      ["Do I need to wait for night with you, or will you trust the clock?", "Look at the clock. Sun icon. Day. Daylight. Day.", "Okay. I'll tell you when it's dark. Promise."],
    ],
    'flashlight-empty': [
      ["Battery's empty. Switch off for a bit and it recharges.", "No charge left. Give it a moment.", "It needs a rest first. Watch the battery bar."],
      ["Still empty. Batteries don't recharge faster if you ask nicely.", "Twice on an empty battery. Optimistic.", "Patience. The bar fills while it's off."],
      ["Third try on zero percent. I respect the faith.", "Again? It's still flat. Physics is undefeated.", "I'm beginning to recognize a pattern. The battery is too."],
      ["Do I need to explain batteries, or shall we wait together?", "We'll wait for the bar together. Breathe.", "Okay. New plan. Walk, and I'll describe things."],
    ],
    frozen: [
      ["You're frozen for now. It wears off.", "Can't move yet. Someone froze you.", "Frozen. Wait it out."],
      ["Still frozen. Wiggling doesn't help.", "Twice. The ice is unimpressed.", "Frozen means frozen. Even for you."],
      ["Impressive persistence. Still frozen, though.", "Third try. The freeze has heard your concerns.", "I'm beginning to think you enjoy this."],
      ["Do I need to thaw you myself, or shall we wait?", "We wait. Together. In ice.", "It'll pass. Like this conversation."],
    ],
    dead: [
      ["You're out this round. You can still watch.", "Eliminated players can't move. Watch how it ends.", "No more walking. Spectating only."],
      ["Still eliminated, I'm afraid.", "The afterlife has no keyboard controls.", "Twice. Being out is very final."],
      ["Third try. I admire the spirit. Literally.", "Again? You're very persistent for a ghost.", "I'm beginning to think you miss the maze."],
      ["Do I need to explain eliminated, or shall we watch together?", "Let's just watch. I'll do commentary.", "Next round. I promise."],
    ],
    badcode: [
      ["That code didn't match a table. Check the letters.", "No table with that code. Try again.", "Hmm, that code isn't open right now."],
      ["Same code, same result. Maybe ask your friend again.", "Still no table. Codes are four letters, by the way.", "Twice. The table is either closed or imaginary."],
      ["Third time. Are we inventing codes now?", "Again? I'm beginning to recognize a pattern.", "Impressive. At this point, I think you're testing my patience."],
      ["Do I need to open a table for you, or shall we keep guessing?", "How about you open a table instead? It's one button.", "Okay. Open a new one. Trust me on this."],
    ],
  },
};

// Situation → default mood.
export const MOOD = {
  welcome: 'playful', hoverLanding: 'playful', hoverGate: 'playful', hoverLobby: 'playful',
  hoverHud: 'competitive', hoverNight: 'mysterious', hoverReveal: 'playful', tap: 'playful',
  nightStart: 'mysterious', dayStart: 'playful', flashlightOn: 'playful', flashlightOff: 'mysterious',
  batteryLow: 'helpful', batteryEmpty: 'helpful', gameStart: 'competitive', taskDone: 'celebratory',
  exitOpen: 'surprised', someoneOut: 'surprised', eliminated: 'disappointed', victory: 'celebratory',
  defeat: 'disappointed', frozen: 'surprised', lobbyWaiting: 'playful', playerJoined: 'playful',
  loading: 'helpful', settings: 'playful', tutorial: 'helpful',
};

// Which animation each mood plays on the mascot.
export const ANIM = {
  helpful: 'happy', playful: 'happy', sarcastic: 'sarcastic', competitive: 'lookAround',
  mysterious: 'mysterious', celebratory: 'victory', disappointed: 'disappointed', surprised: 'surprised',
};

const lastBy = new Map();
/** Random line for a situation, never the same one twice in a row. */
export function pickLine(situation, pool = LINES[situation], rng = Math.random) {
  if (!pool?.length) return '';
  if (pool.length === 1) return pool[0];
  const last = lastBy.get(situation);
  let line;
  do { line = pool[Math.floor(rng() * pool.length)]; } while (line === last);
  lastBy.set(situation, line);
  return line;
}

/**
 * Tracks repeated, real mistakes per type.
 *
 * Each type escalates independently (helpful → light sarcasm → more → playful
 * exasperation) and a success of that type resets it. System faults go
 * through `system()` and never touch the counts.
 */
export function createMistakeTracker({ rng = Math.random } = {}) {
  const counts = new Map();
  return {
    mistake(type) {
      const n = (counts.get(type) ?? 0) + 1;
      counts.set(type, n);
      const tier = Math.min(4, n);
      const tiers = LINES.mistakes[type] ?? LINES.mistakes.wall;
      return {
        type, count: n, tier,
        mood: tier === 1 ? 'helpful' : 'sarcastic',
        anim: tier === 1 ? 'confused' : tier === 4 ? 'disappointed' : 'sarcastic',
        line: pickLine(`mistake:${type}:${tier}`, tiers[tier - 1], rng),
      };
    },
    success(type) {
      if (type) counts.delete(type); else counts.clear();
    },
    count(type) { return counts.get(type) ?? 0; },
    system(kind = 'network') {
      return { mood: 'helpful', anim: 'confused', line: pickLine(`system:${kind}`, LINES.system[kind] ?? LINES.system.server, rng) };
    },
  };
}
