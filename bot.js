/**
 * Mineflayer Bot — Part 1: Connection, Memory Optimization, Basic Chat Commands
 * Target: Minecraft 1.20.2
 *
 * Designed to run comfortably inside a 512MB RAM container.
 * Run with:  node --max-old-space-size=400 --expose-gc bot.js
 *
 * --max-old-space-size=400 leaves headroom under 512MB for the OS/thread stacks.
 * --expose-gc lets us manually trigger garbage collection during idle ticks.
 */

const mineflayer = require('mineflayer');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CONFIG = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  username: process.env.MC_USERNAME || 'HelperBot',
  version: '1.20.2',

  // Memory-related tuning
  viewDistance: 'tiny',      // smallest chunk radius mineflayer supports ('tiny' | 'short' | 'far' | number)
  chunkGcIntervalMs: 30_000, // how often we sweep/unload far chunk data
  memoryLogIntervalMs: 60_000,
  maxChunkCacheRadius: 3,    // chunks beyond this radius (in chunk units) get dropped from our tracking
};

let bot = createBot();
let followTarget = null;     // username of player we're following, or null
let followInterval = null;

// ---------------------------------------------------------------------------
// Bot creation
// ---------------------------------------------------------------------------
function createBot() {
  const instance = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,

    // Keep the client-side chunk cache small. This is the single biggest
    // memory lever mineflayer exposes — 'tiny' loads roughly a 3x3 chunk
    // area around the bot instead of the default (much larger) view.
    viewDistance: CONFIG.viewDistance,

    // Slightly shorter keep-alive timeout so a dead connection is dropped
    // and cleaned up quickly rather than lingering and holding memory.
    checkTimeoutInterval: 30_000,

    // Don't let mineflayer auto-respawn spam reconnect logic; we handle
    // reconnection ourselves below with backoff.
    respawn: true,
  });

  attachCoreHandlers(instance);
  attachMemoryOptimizations(instance);
  attachChatListener(instance);

  return instance;
}

// ---------------------------------------------------------------------------
// Core connection lifecycle
// ---------------------------------------------------------------------------
function attachCoreHandlers(instance) {
  instance.on('spawn', () => {
    console.log(`[bot] Spawned in world as ${instance.username}`);
    instance.chat('Hello! I\'m online. Say "come" to call me over or "stop" to halt me.');
  });

  instance.on('kicked', (reason) => {
    console.warn('[bot] Kicked from server:', reason);
  });

  instance.on('error', (err) => {
    console.error('[bot] Connection error:', err.message);
  });

  instance.on('end', (reason) => {
    console.warn('[bot] Disconnected:', reason);
    clearFollowLoop();
    // Basic reconnect with a short delay so we don't hammer the server
    // or spin the process if the server is genuinely down.
    setTimeout(() => {
      console.log('[bot] Reconnecting...');
      bot = createBot();
    }, 5_000);
  });
}

// ---------------------------------------------------------------------------
// Memory optimization
// ---------------------------------------------------------------------------
function attachMemoryOptimizations(instance) {
  // 1. Aggressively drop chunk columns outside a small radius of the bot.
  //    Mineflayer keeps every loaded chunk column in bot.world until the
  //    server tells it to unload, which on some servers happens rarely.
  //    We proactively unload columns ourselves on an interval.
  const chunkGcTimer = setInterval(() => {
    dropDistantChunks(instance);
  }, CONFIG.chunkGcIntervalMs);

  // 2. Disable local physics simulation while the bot has nothing to do.
  //    Physics ticking walks entities/AABBs every game tick — turning it
  //    off when idle cuts steady-state CPU and object churn (less garbage
  //    for the GC to collect). We re-enable it whenever we actually need
  //    to move (see startFollowing / stopFollowing below).
  instance.physicsEnabled = false;

  // 3. Periodically force a GC pass (requires --expose-gc) and log heap
  //    usage so memory pressure is visible instead of silently growing.
  const memTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
    console.log(`[mem] rss=${rssMb}MB heapUsed=${heapMb}MB`);

    if (global.gc) {
      global.gc();
    }
  }, CONFIG.memoryLogIntervalMs);

  // Clean up timers if this bot instance disconnects, so reconnects don't
  // stack duplicate intervals.
  instance.once('end', () => {
    clearInterval(chunkGcTimer);
    clearInterval(memTimer);
  });
}

/**
 * Unloads chunk columns from bot.world that are farther than
 * CONFIG.maxChunkCacheRadius chunks from the bot's current position.
 * This is the main defense against unbounded chunk-cache growth on
 * servers with a large render distance.
 */
function dropDistantChunks(instance) {
  if (!instance.entity || !instance.world) return;

  const { x: px, z: pz } = instance.entity.position;
  const originChunkX = Math.floor(px / 16);
  const originChunkZ = Math.floor(pz / 16);
  const radius = CONFIG.maxChunkCacheRadius;

  let unloaded = 0;

  // prismarine-world exposes getColumns()/unloadColumn() in recent versions;
  // guard defensively in case the underlying lib shape differs by version.
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
// Chat listener + basic command parsing
// ---------------------------------------------------------------------------
function attachChatListener(instance) {
  instance.on('chat', (username, message) => {
    if (username === instance.username) return; // ignore our own messages

    const command = message.trim().toLowerCase();

    switch (command) {
      case 'come':
        handleComeCommand(instance, username);
        break;

      case 'stop':
        handleStopCommand(instance, username);
        break;

      default:
        // Not a recognized command — ignore silently. Additional commands
        // will be added in later parts of the bot.
        break;
    }
  });
}

function handleComeCommand(instance, username) {
  const player = instance.players[username];
  if (!player || !player.entity) {
    instance.chat(`I can't see you, ${username}.`);
    return;
  }

  instance.chat(`On my way, ${username}!`);
  startFollowing(instance, username);
}

function handleStopCommand(instance, username) {
  instance.chat('Stopping.');
  stopFollowing(instance);
}

// ---------------------------------------------------------------------------
// Minimal movement stub (straight-line follow, no pathfinding yet)
// ---------------------------------------------------------------------------
function startFollowing(instance, username) {
  followTarget = username;
  instance.physicsEnabled = true; // re-enable physics only while moving

  clearFollowLoop();
  followInterval = setInterval(() => {
    const player = instance.players[followTarget];
    if (!player || !player.entity) {
      stopFollowing(instance);
      return;
    }

    const dist = instance.entity.position.distanceTo(player.entity.position);
    if (dist < 2) {
      instance.setControlState('forward', false);
      return;
    }

    instance.lookAt(player.entity.position.offset(0, 1.6, 0));
    instance.setControlState('forward', true);
  }, 250);
}

function stopFollowing(instance) {
  followTarget = null;
  clearFollowLoop();
  instance.setControlState('forward', false);
  instance.physicsEnabled = false; // back to idle, memory-saving state
}

function clearFollowLoop() {
  if (followInterval) {
    clearInterval(followInterval);
    followInterval = null;
  }
}
