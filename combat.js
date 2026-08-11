/**
 * Mineflayer Bot — Part 3: Combat & Projectile Dodging
 * Target: Minecraft 1.20.2
 *
 * Requires:
 *   npm install mineflayer-pvp
 *   (mineflayer-pathfinder must already be loaded — Part 2 does this via mining.js)
 *
 * Usage:
 *   const { setupCombat } = require('./combat');
 *   bot.once('spawn', () => setupCombat(bot));
 *
 * INTEGRATION NOTE (read before merging):
 * Parts 1 & 2 don't currently expose a shared state machine, so this module
 * is intentionally self-contained: it keeps its own lightweight record of
 * "what the player last asked for" (by shadow-listening to the same 'come'
 * and 'mine' chat commands) so it can resume that task after combat ends.
 * It also implements its own pathfinder-based follow (GoalFollow) rather
 * than reusing Part 1's naive straight-line follow, since pathfinder is
 * already loaded by this point and GoalFollow handles obstacles properly.
 * If you later build a real shared state machine, swap resumeTask() below
 * to call into it instead.
 */

const { pvp } = require('mineflayer-pvp');
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const DEFAULT_OPTIONS = {
  aggroRadius: 15,           // detect hostiles within this many blocks
  disengageRadius: 20,       // stop chasing once target is this far (hysteresis)
  scanIntervalMs: 500,       // how often we scan for hostile mobs
  meleeRange: 3,             // distance at which we consider ourselves "in range" to attack
  hostileNames: ['zombie', 'husk', 'drowned', 'skeleton', 'stray', 'creeper'],

  // Critical hit timing (see attemptCriticalTiming below for caveats)
  critJumpIntervalMs: 625,   // approx. vanilla sword attack speed

  // Projectile dodging
  dodgeRadius: 1.1,          // blocks — predicted miss distance under which we consider it a hit
  maxLookaheadTicks: 20,     // ~1s of flight time we're willing to react to
  minLookaheadTicks: 1,      // ignore arrows already basically on top of us (can't react in time)
  strafeDurationMs: 300,     // how long we hold the dodge strafe
  dodgeCooldownMs: 250,      // minimum time between separate dodge triggers
};

function setupCombat(bot, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  bot.loadPlugin(pvp);

  const state = {
    inCombat: false,
    currentTarget: null,
    lastCritJump: 0,
    trackedArrows: new Map(), // entityId -> { spawnTime }
    lastDodgeTime: 0,
    strafeTimer: null,
    interruptedTask: null,    // { type: 'following', username } | { type: 'mining', blockName, count }
    lastKnownTask: null,      // shadow-tracked from chat, see attachTaskShadowTracking
  };

  bot.combat = {
    isInCombat: () => state.inCombat,
  };

  attachTaskShadowTracking(bot, state);
  attachHostileScanning(bot, state, config);
  attachDamageTrigger(bot, state, config);
  attachCriticalHitTiming(bot, state, config);
  attachProjectileDodging(bot, state, config);

  return bot.combat;
}

// ---------------------------------------------------------------------------
// Shadow task tracking (so we know what to resume after combat)
// ---------------------------------------------------------------------------
function attachTaskShadowTracking(bot, state) {
  bot.on('chat', (username, message) => {
    const parts = message.trim().toLowerCase().split(/\s+/);

    if (parts[0] === 'come') {
      state.lastKnownTask = { type: 'following', username };
    } else if (parts[0] === 'stop') {
      state.lastKnownTask = null;
    } else if (parts[0] === 'mine') {
      const blockName = parts[1];
      const count = parts[2] ? parseInt(parts[2], 10) : 1;
      if (blockName) {
        state.lastKnownTask = { type: 'mining', blockName, count: isNaN(count) ? 1 : count };
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Target selection / hostile scanning
// ---------------------------------------------------------------------------
function isHostileMob(entity, config) {
  if (!entity || entity.type !== 'mob') return false;

  // Prefer the data-driven category when available (covers modded/renamed
  // entities), fall back to an explicit name allowlist.
  if (entity.kind === 'Hostile mobs') return true;
  return config.hostileNames.includes(entity.name);
}

function findNearestHostile(bot, config, radius) {
  let nearest = null;
  let nearestDist = Infinity;

  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!isHostileMob(entity, config)) continue;

    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist <= radius && dist < nearestDist) {
      nearest = entity;
      nearestDist = dist;
    }
  }

  return nearest;
}

function attachHostileScanning(bot, state, config) {
  setInterval(() => {
    if (!bot.entity) return;

    if (!state.inCombat) {
      const threat = findNearestHostile(bot, config, config.aggroRadius);
      if (threat) {
        engageCombat(bot, state, config, threat);
      }
      return;
    }

    // Already in combat — check whether our target is still valid/close,
    // and whether any hostiles remain at all before considering disengage.
    const target = state.currentTarget;
    const targetGone = !target || !bot.entities[target.id];
    const targetFar = target && bot.entity.position.distanceTo(target.position) > config.disengageRadius;

    if (targetGone || targetFar) {
      const nextThreat = findNearestHostile(bot, config, config.aggroRadius);
      if (nextThreat) {
        engageCombat(bot, state, config, nextThreat); // swap targets, stay in combat
      } else {
        disengageCombat(bot, state);
      }
    }
  }, config.scanIntervalMs);
}

function attachDamageTrigger(bot, state, config) {
  // If the bot takes damage, treat it as an immediate combat trigger even
  // if the attacker isn't in our normal scan (e.g. we were just hit and
  // need to react now rather than waiting for the next scan tick).
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return;
    if (state.inCombat) return;

    const threat = findNearestHostile(bot, config, config.aggroRadius);
    if (threat) {
      engageCombat(bot, state, config, threat);
    }
  });
}

// ---------------------------------------------------------------------------
// Engaging / disengaging combat
// ---------------------------------------------------------------------------
function engageCombat(bot, state, config, target) {
  const wasInCombat = state.inCombat;
  state.inCombat = true;
  state.currentTarget = target;

  if (!wasInCombat) {
    // Entering combat fresh — pause whatever we were doing and remember it.
    state.interruptedTask = state.lastKnownTask;
    pauseCurrentTask(bot);
    bot.chat(`${target.name} spotted — engaging!`);
    bot.emit('combatStateChange', { inCombat: true, target });
  }

  bot.pvp.attack(target);
}

function disengageCombat(bot, state) {
  state.inCombat = false;
  state.currentTarget = null;

  bot.pvp.stop();
  bot.setControlState('jump', false);
  bot.setControlState('left', false);
  bot.setControlState('right', false);

  bot.chat('Area clear.');
  bot.emit('combatStateChange', { inCombat: false });

  resumeTask(bot, state.interruptedTask);
  state.interruptedTask = null;
}

function pauseCurrentTask(bot) {
  // Harmless no-ops if these modules/states aren't active.
  if (bot.mining && typeof bot.mining.cancel === 'function') {
    bot.mining.cancel();
  }
  stopPathFollow(bot);
}

function resumeTask(bot, task) {
  if (!task) return;

  if (task.type === 'following') {
    bot.chat(`Back to following you, ${task.username}.`);
    startPathFollow(bot, task.username);
  } else if (task.type === 'mining') {
    bot.chat(`Resuming mining: ${task.blockName}.`);
    if (bot.mining && typeof bot.mining.mineBlockByName === 'function') {
      bot.mining.mineBlockByName(task.blockName, task.count).catch((err) => {
        console.error('[combat] Failed to resume mining:', err.message);
      });
    }
  }
}

// Minimal pathfinder-based follow, used only to resume post-combat.
// (Part 1's simpler follow can stay as-is for normal "come" handling —
// this just avoids combat.js reaching into Part 1's private state.)
function startPathFollow(bot, username) {
  const player = bot.players[username];
  if (!player || !player.entity) return;
  bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
}

function stopPathFollow(bot) {
  if (bot.pathfinder) {
    bot.pathfinder.setGoal(null);
  }
}

// ---------------------------------------------------------------------------
// Critical hit timing
// ---------------------------------------------------------------------------
/**
 * Vanilla critical hits require the attacker to be airborne/falling (not on
 * ground, not on a ladder/in water, no blindness) at the moment of impact.
 * mineflayer-pvp doesn't expose a hook that fires "right before the next
 * swing", so this is a heuristic: roughly once per vanilla attack-speed
 * interval, if we're on the ground and in melee range of our target, we
 * jump. By the time the plugin's next automatic swing lands, we're
 * typically airborne and falling, which satisfies the crit condition. This
 * is not a guaranteed 100% crit rate — treat it as a best-effort tactic,
 * not a precise timing exploit.
 */
function attachCriticalHitTiming(bot, state, config) {
  bot.on('physicsTick', () => {
    if (!state.inCombat || !state.currentTarget) return;
    if (!bot.entities[state.currentTarget.id]) return;

    const dist = bot.entity.position.distanceTo(state.currentTarget.position);
    if (dist > config.meleeRange) return;
    if (!bot.entity.onGround) return;

    const now = Date.now();
    if (now - state.lastCritJump < config.critJumpIntervalMs) return;

    state.lastCritJump = now;
    bot.setControlState('jump', true);
    // Release next tick — a single-tick jump impulse is enough to leave
    // the ground; holding it longer just delays landing unnecessarily.
    setTimeout(() => bot.setControlState('jump', false), 100);
  });
}

// ---------------------------------------------------------------------------
// Projectile (arrow) tracking + dodging
// ---------------------------------------------------------------------------
function attachProjectileDodging(bot, state, config) {
  bot.on('entitySpawn', (entity) => {
    if (entity.name === 'arrow' || entity.name === 'spectral_arrow') {
      state.trackedArrows.set(entity.id, { spawnTime: Date.now() });
    }
  });

  bot.on('entityGone', (entity) => {
    state.trackedArrows.delete(entity.id);
  });

  bot.on('physicsTick', () => {
    if (state.trackedArrows.size === 0) return;

    const now = Date.now();

    for (const [id, meta] of state.trackedArrows) {
      const arrow = bot.entities[id];

      // Clean up stale entries (hit something, despawned, or we've been
      // tracking it too long to still be relevant).
      if (!arrow || now - meta.spawnTime > 5000) {
        state.trackedArrows.delete(id);
        continue;
      }

      evaluateDodge(bot, state, config, arrow);
    }
  });
}

/**
 * Linear collision prediction. Arrows are actually affected by gravity and
 * drag, but over the ~1 second lookahead window we care about for reacting,
 * a straight-line projection from the current velocity is a close enough
 * approximation to decide "is this about to hit me" — we re-evaluate every
 * physics tick anyway, so the estimate self-corrects as the arrow curves.
 */
function evaluateDodge(bot, state, config, arrow) {
  if (!arrow.velocity) return;

  const vel = arrow.velocity; // blocks/tick
  const velLenSq = vel.dot(vel);
  if (velLenSq < 1e-6) return; // effectively stationary, not a threat yet

  const relPos = bot.entity.position.minus(arrow.position); // arrow -> bot
  let tClosest = relPos.dot(vel) / velLenSq; // ticks until closest approach

  if (tClosest < config.minLookaheadTicks || tClosest > config.maxLookaheadTicks) {
    return; // either already passing us with no reaction time, or too far out to matter yet
  }

  const closestPoint = arrow.position.plus(vel.scaled(tClosest));
  const missDistance = closestPoint.distanceTo(bot.entity.position);

  if (missDistance > config.dodgeRadius) return; // not on a collision course

  triggerDodge(bot, state, config, vel, closestPoint);
}

function triggerDodge(bot, state, config, arrowVelocity, closestPoint) {
  const now = Date.now();
  if (now - state.lastDodgeTime < config.dodgeCooldownMs) return;
  state.lastDodgeTime = now;

  const dodgeDir = computeDodgeDirection(bot, arrowVelocity, closestPoint);
  const useRight = isRightStrafe(bot, dodgeDir);

  if (state.strafeTimer) clearTimeout(state.strafeTimer);

  bot.setControlState('left', !useRight);
  bot.setControlState('right', useRight);

  state.strafeTimer = setTimeout(() => {
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    state.strafeTimer = null;
  }, config.strafeDurationMs);
}

/** Horizontal vector perpendicular to the arrow's flight path, pointing
 *  away from where the bot currently sits relative to that path. */
function computeDodgeDirection(bot, velocity, closestPoint) {
  const velHoriz = new Vec3(velocity.x, 0, velocity.z);
  let perp;

  if (velHoriz.norm() < 1e-6) {
    // Near-vertical shot (rare) — just pick a consistent arbitrary side.
    perp = new Vec3(1, 0, 0);
  } else {
    perp = new Vec3(-velHoriz.z, 0, velHoriz.x).normalize();
  }

  const offset = new Vec3(
    bot.entity.position.x - closestPoint.x,
    0,
    bot.entity.position.z - closestPoint.z
  );

  // Flip perpendicular so it points further away from our current offset,
  // rather than potentially stepping deeper into the arrow's path.
  return offset.dot(perp) < 0 ? perp.scaled(-1) : perp;
}

/** Converts a world-space direction into "is this bot's strafe-right?" */
function isRightStrafe(bot, worldDir) {
  const yaw = bot.entity.yaw;
  const right = new Vec3(Math.cos(yaw), 0, Math.sin(yaw));
  return worldDir.dot(right) > 0;
}

module.exports = { setupCombat };
