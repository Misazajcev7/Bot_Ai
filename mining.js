/**
 * Mineflayer Bot — Part 2: Line-of-Sight Gated Mining
 * Target: Minecraft 1.20.2
 *
 * Requires:
 *   npm install mineflayer-pathfinder mineflayer-collectblock
 *
 * This module is meant to be required from the Part 1 bot and initialized
 * once the bot has spawned:
 *
 *   const { setupMining } = require('./mining');
 *   bot.once('spawn', () => setupMining(bot));
 *
 * Core rule enforced here: the bot will NEVER mine a block it cannot
 * currently (or, after moving, subsequently) see via an unobstructed ray
 * from its eyes to the block's center. If every candidate block of the
 * requested type is either behind opaque terrain or physically unreachable
 * by walking, the bot reports that and does nothing — it will not path
 * through or dig through walls to "cheat" its way to ore it can't see.
 */

const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const collectBlockPlugin = require('mineflayer-collectblock').plugin;
const { Vec3 } = require('vec3');

const DEFAULT_OPTIONS = {
  searchRadius: 32,      // how far to search for candidate blocks
  maxCandidates: 20,     // cap how many candidate positions we evaluate
  rayStep: 0.2,          // raycast marching step size, in blocks
  approachRange: 4,       // how close pathfinder should get before we re-check LOS
};

let miningState = {
  active: false,
  cancelRequested: false,
};

function setupMining(bot, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlockPlugin);

  const mcData = require('minecraft-data')(bot.version);
  const movements = new Movements(bot, mcData);

  // Critical: do NOT let pathfinder dig through walls to reach a goal.
  // Digging-to-path is exactly the kind of "see through walls by brute
  // force" behavior this system is meant to prevent. The bot may only
  // dig the block it was explicitly told to mine, once it has honest
  // line-of-sight to it.
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = false;

  bot.pathfinder.setMovements(movements);

  bot.mining = {
    mineBlockByName: (blockName, count = 1) =>
      mineBlockByName(bot, mcData, movements, config, blockName, count),
    cancel: () => {
      miningState.cancelRequested = true;
    },
  };

  attachMiningChatCommands(bot);

  return bot.mining;
}

// ---------------------------------------------------------------------------
// Chat command integration ("mine <blockName> [count]")
// ---------------------------------------------------------------------------
function attachMiningChatCommands(bot) {
  bot.on('chat', async (username, message) => {
    if (username === bot.username) return;

    const parts = message.trim().toLowerCase().split(/\s+/);
    if (parts[0] !== 'mine') return;

    if (miningState.active) {
      bot.chat('Already mining — say "stop" first if you want to cancel.');
      return;
    }

    const blockName = parts[1];
    const count = parts[2] ? parseInt(parts[2], 10) : 1;

    if (!blockName) {
      bot.chat('Usage: mine <block_name> [count]');
      return;
    }

    try {
      await bot.mining.mineBlockByName(blockName, isNaN(count) ? 1 : count);
    } catch (err) {
      bot.chat(`Mining stopped: ${err.message}`);
      console.error('[mining] error:', err);
    }
  });
}

// ---------------------------------------------------------------------------
// Line-of-sight raycasting (the "no X-ray" enforcement)
// ---------------------------------------------------------------------------

/**
 * Marches a ray from the bot's eye position to the target block's center,
 * sampling the world at fixed intervals. If any solid ("block"-shaped,
 * opaque) block other than the target itself lies on that ray, the target
 * is considered obstructed and mining is refused.
 *
 * This intentionally does NOT use any information the bot couldn't derive
 * from blocks it has actually loaded/seen client-side — no reaching into
 * unloaded chunks, no ignoring solid geometry.
 */
function hasLineOfSight(bot, targetBlock, rayStep = 0.2) {
  if (!targetBlock) return false;

  const eye = bot.entity.position.offset(0, 1.62, 0);
  const center = targetBlock.position.offset(0.5, 0.5, 0.5);
  const delta = center.minus(eye);
  const distance = delta.norm();

  if (distance < 0.01) return true;

  const direction = delta.scaled(1 / distance);
  const steps = Math.floor(distance / rayStep);

  for (let i = 1; i < steps; i++) {
    const point = eye.plus(direction.scaled(i * rayStep));

    // Stop marching once we're within ~half a block of the target center —
    // anything from here on is "inside" the target voxel, not an obstruction.
    if (point.distanceTo(center) < 0.6) break;

    const blockPos = point.floored();

    // Never treat the target's own voxel as an obstruction.
    if (blockPos.equals(targetBlock.position)) continue;

    const block = bot.blockAt(blockPos, false);
    if (!block) continue; // unloaded chunk edge — treat as non-obstructing, not as free pass to mine blindly

    if (isOpaqueSolid(block)) {
      return false;
    }
  }

  return true;
}

function isOpaqueSolid(block) {
  if (!block) return false;
  if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return false;

  // prismarine-block boundingBox: 'block' = full solid voxel, 'empty' = passable (air, torches...),
  // 'other' = partial/non-cube (slabs, fences, etc — treat conservatively as NOT blocking full sight
  // only if it's also marked transparent; otherwise treat as blocking).
  if (block.boundingBox === 'empty') return false;
  if (block.transparent) return false; // glass, leaves-with-transparency flag, etc.

  return true;
}

// ---------------------------------------------------------------------------
// Candidate discovery + classification
// ---------------------------------------------------------------------------

/**
 * Finds candidate positions of the requested block type within range and
 * classifies each one as:
 *   'visible'    — currently has an unobstructed line of sight
 *   'invisible'  — exists, but is behind opaque terrain (blocked LOS)
 * Sorted nearest-first for 'visible' entries.
 */
function findAndClassifyBlocks(bot, mcData, blockName, config) {
  const blockType = mcData.blocksByName[blockName];
  if (!blockType) {
    throw new Error(`Unknown block type "${blockName}"`);
  }

  const positions = bot.findBlocks({
    matching: blockType.id,
    maxDistance: config.searchRadius,
    count: config.maxCandidates,
  });

  const visible = [];
  const invisible = [];

  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!block) continue;

    if (hasLineOfSight(bot, block, config.rayStep)) {
      visible.push(block);
    } else {
      invisible.push(block);
    }
  }

  visible.sort((a, b) =>
    bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position)
  );

  return { visible, invisible };
}

// ---------------------------------------------------------------------------
// Main mining routine
// ---------------------------------------------------------------------------
async function mineBlockByName(bot, mcData, movements, config, blockName, count) {
  miningState.active = true;
  miningState.cancelRequested = false;

  let minedCount = 0;

  try {
    for (let attempt = 0; attempt < count; attempt++) {
      if (miningState.cancelRequested) {
        bot.chat('Mining cancelled.');
        break;
      }

      const { visible, invisible } = findAndClassifyBlocks(bot, mcData, blockName, config);

      if (visible.length === 0 && invisible.length === 0) {
        bot.chat(`No ${blockName} found within ${config.searchRadius} blocks.`);
        break;
      }

      if (visible.length === 0) {
        bot.chat(
          `Found ${invisible.length} ${blockName} block(s), but all are behind walls — ` +
          `flagging as invisible. Refusing to mine without a clear view.`
        );
        break;
      }

      const target = visible[0];
      const mined = await mineOneBlock(bot, movements, target, blockName, config);

      if (mined) {
        minedCount++;
      } else {
        // Target became obstructed/unreachable after we tried to approach —
        // don't retry the same block, just loop again to re-evaluate.
        continue;
      }
    }
  } finally {
    miningState.active = false;
    if (minedCount > 0) {
      bot.chat(`Done. Mined ${minedCount} ${blockName} block(s).`);
    }
  }

  return minedCount;
}

/**
 * Attempts to reach and mine a single, already-visible block. Re-validates
 * line of sight both before pathing and again right before digging, since
 * moving can change what's obstructed (and since we refuse to dig through
 * walls to "force" access).
 */
async function mineOneBlock(bot, movements, block, blockName, config) {
  if (!hasLineOfSight(bot, block, config.rayStep)) {
    console.log(`[mining] ${blockName} at ${block.position} lost line-of-sight before approach — skipping`);
    return false;
  }

  const goal = new goals.GoalLookAtBlock(block.position, bot.world, {
    range: config.approachRange,
  });

  try {
    await bot.pathfinder.goto(goal);
  } catch (err) {
    bot.chat(`Can't reach that ${blockName} — marking unreachable (${err.message}).`);
    console.log(`[mining] ${blockName} at ${block.position} unreachable: ${err.message}`);
    return false;
  }

  if (miningState.cancelRequested) return false;

  // Re-fetch the block in case the world changed while we were walking.
  const freshBlock = bot.blockAt(block.position);
  if (!freshBlock || freshBlock.name !== blockName) {
    console.log(`[mining] ${blockName} at ${block.position} no longer present — skipping`);
    return false;
  }

  // Final, strict re-check right before digging. This is the last line of
  // defense against mining something the bot can no longer actually see.
  if (!hasLineOfSight(bot, freshBlock, config.rayStep)) {
    bot.chat(`Lost line of sight to that ${blockName} — refusing to mine blind.`);
    console.log(`[mining] ${blockName} at ${freshBlock.position} obstructed after approach — refusing`);
    return false;
  }

  try {
    // collectBlock handles the dig + pickup; canDig on movements only
    // affects pathfinder's travel behavior, not this direct, intentional dig.
    await bot.collectBlock.collect(freshBlock);
    return true;
  } catch (err) {
    console.log(`[mining] Failed to mine ${blockName} at ${freshBlock.position}: ${err.message}`);
    return false;
  }
}

module.exports = { setupMining, hasLineOfSight };
