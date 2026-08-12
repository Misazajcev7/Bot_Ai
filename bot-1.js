/**
 * Mineflayer Bot — Part 5c: Unified Main Assembly
 * Target: Minecraft 1.20.2
 *
 * Run with:  npm start
 *   (equivalent to: node --max-old-space-size=400 --expose-gc bot.js)
 *
 * This file wires together every module built so far:
 *   ./mining.js         — line-of-sight-gated block mining
 *   ./combat.js         — hostile-mob PvP + projectile dodging
 *   ./automation.js     — furnace smelting & crafting-table automation
 *   ./vision.js         — screenshot -> VLM -> sarcastic TTS reply
 *   ./voice-control.js  — TTS primitive (speak) reused for vision replies
 *
 * SUPERSEDES EARLIER LISTENERS:
 * bot.js Part 1 had a bare, unfiltered 'come'/'stop' listener. voice-control.js
 * (Part 4) added a stricter, name/owner-gated listener that superseded it.
 * This file is the final word: it is the ONLY module that attaches a 'chat'
 * command-routing listener and the ONLY module that attaches the readline
 * console listener. mining.js's own 'mine' listener and voice-control.js's
 * own chat/console listeners are intentionally never invoked from here —
 * wiring both would process every command twice. voice-control.js is still
 * required, but only for its `speak()` TTS primitive (see the one-line
 * patch note at the bottom of this file's accompanying README section).
 *
 * PHYSICS NOTE:
 * Part 1 toggled `bot.physicsEnabled` off while idle to save CPU/GC churn,
 * back when the only movement was a naive straight-line follow. Parts 2 and
 * 3 (pathfinder, mineflayer-pvp) both require physics simulation to be on
 * at all times to function correctly, so that toggle is removed here —
 * physics stays on, and the RAM budget is instead protected by tiny view
 * distance + aggressive chunk unloading + periodic forced GC (below).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mineflayer = require('mineflayer');
const { pathfinder, goals } = require('mineflayer-pathfinder');

const { setupMining } = require('./mining');
const { setupCombat } = require('./combat');
const { setupAutomation, resolveAutomationCommand } = require('./automation');
const { analyzeScreenAndRespond } = require('./vision');
const { speak } = require('./voice-control');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

let bot = createBot();
let followTarget = null;
let followActive = false;

// ---------------------------------------------------------------------------
// Bot creation
// ---------------------------------------------------------------------------
function createBot() {
  const instance = mineflayer.createBot({
    host: config.server.host,
    port: config.server.port,
    username: config.botName,
    version: config.server.version,

    // Keep the client-side chunk cache small — the single biggest memory
    // lever mineflayer exposes.
    viewDistance: config.memory.viewDistance,
    checkTimeoutInterval: 30_000,
    respawn: true,
  });

  instance.loadPlugin(pathfinder);

  attachCoreHandlers(instance);
  attachMemoryOptimizations(instance);

  instance.once('spawn', () => {
    console.log(`[bot] Spawned in world as ${instance.username}`);
    setupMining(instance, config.mining);
    setupCombat(instance);
    setupAutomation(instance, config.automation);

    attachUnifiedChatListener(instance);
    attachConsoleInput(instance);

    instance.chat(`${config.botName} на связи. И да, я в курсе, что вы не рады.`);
  });

  return instance;
}

// ---------------------------------------------------------------------------
// Core connection lifecycle
// ---------------------------------------------------------------------------
function attachCoreHandlers(instance) {
  instance.on('kicked', (reason) => {
    console.warn('[bot] Kicked from server:', reason);
  });

  instance.on('error', (err) => {
    console.error('[bot] Connection error:', err.message);
  });

  instance.on('end', (reason) => {
    console.warn('[bot] Disconnected:', reason);
    followActive = false;
    followTarget = null;
    setTimeout(() => {
      console.log('[bot] Reconnecting...');
      bot = createBot();
    }, 5_000);
  });
}

// ---------------------------------------------------------------------------
// Memory optimization (512MB budget)
// ---------------------------------------------------------------------------
function attachMemoryOptimizations(instance) {
  const chunkGcTimer = setInterval(() => {
    dropDistantChunks(instance);
  }, config.memory.chunkGcIntervalMs);

  const memTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    console.log(`[mem] rss=${rssMb}MB heapUsed=${heapMb}MB`);

    if (global.gc) global.gc();
  }, config.memory.memoryLogIntervalMs);

  instance.once('end', () => {
    clearInterval(chunkGcTimer);
    clearInterval(memTimer);
  });
}

function dropDistantChunks(instance) {
  if (!instance.entity || !instance.world) return;

  const { x: px, z: pz } = instance.entity.position;
  const originChunkX = Math.floor(px / 16);
  const originChunkZ = Math.floor(pz / 16);
  const radius = config.memory.maxChunkCacheRadius;

  let unloaded = 0;

  if (typeof instance.world.getColumns === 'function') {
    const columns = instance.world.getColumns();
    for (const { chunkX, chunkZ } of columns) {
      const dx = Math.abs(chunkX - originChunkX);
      const dz = Math.abs(chunkZ - originChunkZ);
      if (dx > radius || dz > radius) {
        if (typeof instance.world.unloadColumn === 'function') {
          instance.world.unloadColumn(chunkX, chunkZ);
          unloaded++;
        }
      }
    }
  }

  if (unloaded > 0) {
    console.log(`[mem] Unloaded ${unloaded} distant chunk column(s)`);
  }
}

// ---------------------------------------------------------------------------
// Unified command resolution (RU + EN, chat + console)
// ---------------------------------------------------------------------------
const VISION_TRIGGER = /(что\s+ты\s+вид(ишь|ел)|оцени)/i;

function resolveCommand(text) {
  const trimmed = text.trim();
  const low = trimmed.toLowerCase();

  if (/^(иди\s+сюда|come|follow)$/i.test(low)) return { type: 'follow' };
  if (/^(стой|stop|halt)$/i.test(low)) return { type: 'stop' };

  const mineMatch = low.match(/^(?:добудь|mine)\s+(.+)$/i);
  if (mineMatch) {
    const { itemName, count } = splitTrailingCount(mineMatch[1]);
    return { type: 'mine', blockName: itemName, count };
  }

  const automationCmd = resolveAutomationCommand(trimmed);
  if (automationCmd) return automationCmd;

  if (VISION_TRIGGER.test(low)) return { type: 'vision', prompt: trimmed };

  // Anything else, prefixed to us or from the owner, is a freeform question
  // for the vision-capable AI brain (it can answer purely from text too —
  // the screenshot just gives it eyes when relevant).
  return { type: 'freeform', text: trimmed };
}

function splitTrailingCount(str) {
  const parts = str.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const maybeCount = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(maybeCount)) {
      parts.pop();
      return { itemName: parts.join('_'), count: maybeCount };
    }
  }
  return { itemName: parts.join('_'), count: 1 };
}

// ---------------------------------------------------------------------------
// Chat listener — strict name/owner gate, single source of command routing
// ---------------------------------------------------------------------------
function attachUnifiedChatListener(instance) {
  instance.on('chat', (username, message) => {
    if (username === instance.username) return;

    const isOwner = username === config.ownerNick;
    const stripped = stripBotPrefix(message, config.botName);

    let commandText;
    if (stripped !== null) {
      commandText = stripped;
    } else if (isOwner) {
      commandText = message.trim();
    } else {
      return; // not addressed to us, and not the owner — stay quiet
    }

    if (!commandText) return;

    dispatchCommand(instance, commandText, { source: 'chat', username });
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
  rest = rest.replace(/^[\s,:;-]+/, '');
  return rest.trim();
}

// ---------------------------------------------------------------------------
// Console listener — trusted operator, no name prefix required
// ---------------------------------------------------------------------------
function attachConsoleInput(instance) {
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
      dispatchCommand(instance, text, { source: 'console' });
    }
    rl.prompt();
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
async function dispatchCommand(instance, text, meta) {
  const resolved = resolveCommand(text);
  console.log(`[cmd] (${meta.source}${meta.username ? ', ' + meta.username : ''}) -> ${resolved.type}`);

  switch (resolved.type) {
    case 'follow': {
      const target = meta.username || config.ownerNick;
      startFollowing(instance, target);
      instance.chat(`Иду, ${target}. Постарайся меня не разочаровать.`);
      break;
    }

    case 'stop': {
      stopFollowing(instance);
      if (instance.mining) instance.mining.cancel();
      if (instance.automation) instance.automation.cancel();
      instance.chat('Стою. Как всегда, безупречно по команде.');
      break;
    }

    case 'mine': {
      if (!resolved.blockName) {
        instance.chat('Что добывать? Использование: добудь <блок> [количество]');
        break;
      }
      instance.chat(`Добываю ${resolved.blockName}...`);
      try {
        await instance.mining.mineBlockByName(resolved.blockName, resolved.count || 1);
      } catch (err) {
        instance.chat(`Не вышло: ${err.message}`);
      }
      break;
    }

    case 'smelt': {
      await instance.automation.smelt(resolved.itemName, resolved.count || 1);
      break;
    }

    case 'craft': {
      await instance.automation.craft(resolved.itemName, resolved.count || 1);
      break;
    }

    case 'vision': {
      await analyzeScreenAndRespond(instance, config, resolved.prompt);
      break;
    }

    case 'freeform':
    default: {
      await analyzeScreenAndRespond(instance, config, resolved.text);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Pathfinder-based follow ("иди сюда" / "come")
// ---------------------------------------------------------------------------
function startFollowing(instance, username) {
  const player = instance.players[username];
  if (!player || !player.entity) {
    instance.chat(`Не вижу тебя, ${username}.`);
    return;
  }

  followTarget = username;
  followActive = true;
  instance.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
}

function stopFollowing(instance) {
  followActive = false;
  followTarget = null;
  if (instance.pathfinder) {
    instance.pathfinder.setGoal(null);
  }
}

module.exports = { createBot };
