/**
 * Mineflayer Bot — Part 4: Command Filtering, Console Input & AI Voice
 * Target: Minecraft 1.20.2
 * Bot's exact in-game name: "AI_Bot"
 *
 * Requires:
 *   npm install say
 *   (Node 18+ has global fetch built in; on older Node, `npm install node-fetch`
 *   and require it into `fetch` yourself.)
 *   Linux TTS also needs `espeak` installed system-wide for the `say` package to work.
 *
 * Usage:
 *   const { setupVoiceControl } = require('./voice-control');
 *   bot.once('spawn', () => setupVoiceControl(bot));
 *
 * IMPORTANT — supersedes earlier unfiltered listeners:
 * Part 1's plain `come`/`stop` chat listener and Part 2's plain `mine`
 * listener have no sender check at all. If those stay active alongside
 * this module, anyone in chat can still trigger them directly, which
 * defeats the point of the strict filtering below. Remove/disable those
 * two listeners once this module is wired in.
 */

const readline = require('readline');
const say = require('say');
const { goals } = require('mineflayer-pathfinder');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BOT_NAME = 'AI_Bot';           // must match the bot's actual in-game username
const OWNER_NICK = 'YourNick';       // <-- set this to your real Minecraft username
const SILENT_CHAT = true;            // true = AI replies go to TTS only, never to game chat

const DEFAULT_OPTIONS = {
  botName: BOT_NAME,
  ownerNick: OWNER_NICK,
  silentChat: SILENT_CHAT,

  ai: {
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o-mini',
    systemPrompt:
      'You are AI_Bot, a concise, friendly companion inside a Minecraft world. ' +
      'Keep answers short (1-3 sentences) and conversational.',
    maxTokens: 200,
  },

  tts: {
    voice: null,   // null = OS default voice
    speed: 1.0,
  },
};

function setupVoiceControl(bot, options = {}) {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
    ai: { ...DEFAULT_OPTIONS.ai, ...(options.ai || {}) },
    tts: { ...DEFAULT_OPTIONS.tts, ...(options.tts || {}) },
  };

  attachChatListener(bot, config);
  attachConsoleInput(bot, config);

  return { config };
}

// ---------------------------------------------------------------------------
// 1. Strict nickname filtration (chat entry point)
// ---------------------------------------------------------------------------
function attachChatListener(bot, config) {
  bot.on('chat', (username, message) => {
    if (username === bot.username) return; // never react to our own messages

    const isOwner = username === config.ownerNick;
    const stripped = stripBotPrefix(message, config.botName);

    let commandText;
    if (stripped !== null) {
      commandText = stripped;
    } else if (isOwner) {
      commandText = message.trim();
    } else {
      return; // not prefixed and not the owner — ignore completely
    }

    if (!commandText) return;

    handleIncomingCommand(bot, config, commandText, { source: 'chat', username });
  });
}

/**
 * Returns the text after the bot's name if the message starts with it
 * (case-insensitive, tolerant of a following comma/colon/dash), or null
 * if the message doesn't start with the bot's name at all.
 */
function stripBotPrefix(message, botName) {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();
  const prefix = botName.toLowerCase();

  if (!lower.startsWith(prefix)) return null;

  let rest = trimmed.slice(botName.length);
  rest = rest.replace(/^[\s,:;-]+/, ''); // drop ", " / ": " / " - " etc.
  return rest.trim();
}

// ---------------------------------------------------------------------------
// 3. Console input (no prefix required — the terminal operator is trusted)
// ---------------------------------------------------------------------------
function attachConsoleInput(bot, config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('[console] Ready. Type commands (Russian or English) and press Enter.');
  rl.prompt();

  rl.on('line', (line) => {
    const text = line.trim();
    if (text) {
      handleIncomingCommand(bot, config, text, { source: 'console' });
    }
    rl.prompt();
  });
}

// ---------------------------------------------------------------------------
// 2. Multi-language command mapping
// ---------------------------------------------------------------------------
function resolveCommand(text) {
  const normalized = text.trim().toLowerCase();

  if (/^(иди\s+сюда|come)$/i.test(normalized)) {
    return { type: 'follow' };
  }

  if (/^(стой|stop)$/i.test(normalized)) {
    return { type: 'stop' };
  }

  const mineMatch = normalized.match(/^(?:добудь|mine)\s+(.+)$/i);
  if (mineMatch) {
    // Assumes the block token is a valid minecraft-data block id (e.g.
    // "iron_ore"), same as the plain-English "mine" command from Part 2.
    return { type: 'mine', blockName: mineMatch[1].trim() };
  }

  return { type: 'unknown', text };
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------
async function handleIncomingCommand(bot, config, text, meta) {
  const resolved = resolveCommand(text);

  switch (resolved.type) {
    case 'follow': {
      const target = meta.username || config.ownerNick;
      startFollow(bot, target);
      bot.chat('Иду!');
      break;
    }

    case 'stop': {
      stopFollow(bot);
      if (bot.mining && typeof bot.mining.cancel === 'function') {
        bot.mining.cancel();
      }
      bot.chat('Стою.');
      break;
    }

    case 'mine': {
      bot.chat(`Добываю ${resolved.blockName}...`);
      if (bot.mining && typeof bot.mining.mineBlockByName === 'function') {
        try {
          await bot.mining.mineBlockByName(resolved.blockName, 1);
        } catch (err) {
          bot.chat(`Не получилось: ${err.message}`);
        }
      } else {
        bot.chat('Система добычи не подключена.');
      }
      break;
    }

    case 'unknown':
    default:
      await handleFreeformQuery(bot, config, resolved.text, meta);
  }
}

// Minimal pathfinder-based follow (see the same pattern in combat.js).
function startFollow(bot, username) {
  const player = bot.players[username];
  if (!player || !player.entity || !bot.pathfinder) return;
  bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
}

function stopFollow(bot) {
  if (bot.pathfinder) {
    bot.pathfinder.setGoal(null);
  }
}

// ---------------------------------------------------------------------------
// 4. AI brain + TTS ("stealth chat")
// ---------------------------------------------------------------------------
async function handleFreeformQuery(bot, config, text, meta) {
  console.log(`[ai] Query (${meta.source}${meta.username ? ', ' + meta.username : ''}): ${text}`);

  let reply;
  try {
    reply = await queryAI(config, text);
  } catch (err) {
    console.error('[ai] API error:', err.message);
    reply = 'Извините, не могу связаться с ИИ прямо сейчас.';
  }

  console.log(`[ai] Reply: ${reply}`);

  if (config.silentChat) {
    speak(reply, config);
  } else {
    sendChunkedChat(bot, reply);
  }
}

async function queryAI(config, userText) {
  if (!config.ai.apiKey) {
    throw new Error('Missing API key (set OPENAI_API_KEY, or swap in your local LLM handler)');
  }

  const response = await fetch(config.ai.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.ai.apiKey}`,
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [
        { role: 'system', content: config.ai.systemPrompt },
        { role: 'user', content: userText },
      ],
      max_tokens: config.ai.maxTokens,
    }),
  });

  if (!response.ok) {
    throw new Error(`AI API returned HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '...';
}

function speak(text, config) {
  say.speak(text, config.tts.voice, config.tts.speed, (err) => {
    if (err) console.error('[tts] Playback error:', err);
  });
}

// Minecraft caps chat messages around 256 characters; split long AI
// replies so a non-silent response doesn't just get truncated/rejected.
function sendChunkedChat(bot, text) {
  const MAX_LEN = 250;
  for (let i = 0; i < text.length; i += MAX_LEN) {
    bot.chat(text.slice(i, i + MAX_LEN));
  }
}

module.exports = { setupVoiceControl };
