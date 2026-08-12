/**
 * Mineflayer Bot — Part 5b: Smelting & Crafting Automation
 * Target: Minecraft 1.20.2
 *
 * Requires:
 *   npm install mineflayer-pathfinder minecraft-data
 *   (pathfinder is already loaded by mining.js's setupMining — this module
 *   assumes that has already run by the time bot.automation.smelt/craft
 *   are invoked, same convention as mining.js and combat.js.)
 *
 * Usage:
 *   const { setupAutomation, resolveAutomationCommand } = require('./automation');
 *   bot.once('spawn', () => setupAutomation(bot, config));
 *
 * INTEGRATION NOTE:
 * Unlike mining.js, this module does NOT attach its own 'chat' listener.
 * Command routing (matching "переплавь" / "craft" from chat *and* the
 * console) is centralized in bot.js's unified router (Part 5c) so that a
 * single command isn't processed twice. `resolveAutomationCommand` is
 * exported purely as a parsing helper for that router to call into
 * `bot.automation.smelt` / `bot.automation.craft`.
 */

const { goals } = require('mineflayer-pathfinder');

const DEFAULT_OPTIONS = {
  searchRadius: 16,
  smeltTimeoutMs: 90_000,
  pollIntervalMs: 1500,
  approachRange: 3,
  fuelPriority: ['coal', 'charcoal', 'coal_block', 'oak_planks', 'birch_planks', 'lava_bucket'],
  smeltableInputs: {
    raw_iron: 'iron_ingot',
    raw_gold: 'gold_ingot',
    raw_copper: 'copper_ingot',
    iron_ore: 'iron_ingot',
    gold_ore: 'gold_ingot',
    cobblestone: 'stone',
    sand: 'glass',
    clay_ball: 'brick',
    beef: 'cooked_beef',
    porkchop: 'cooked_porkchop',
    chicken: 'cooked_chicken',
  },
};

const FURNACE_BLOCK_NAMES = ['furnace', 'blast_furnace', 'smoker'];

let automationState = {
  active: false,
  cancelRequested: false,
};

function setupAutomation(bot, options = {}) {
  const config = {
    ...DEFAULT_OPTIONS,
    ...options,
    fuelPriority: options.fuelPriority || DEFAULT_OPTIONS.fuelPriority,
    smeltableInputs: { ...DEFAULT_OPTIONS.smeltableInputs, ...(options.smeltableInputs || {}) },
  };

  const mcData = require('minecraft-data')(bot.version);

  bot.automation = {
    smelt: (itemName, count = 1) => smeltItem(bot, mcData, config, itemName, count),
    craft: (itemName, count = 1) => craftItem(bot, mcData, config, itemName, count),
    cancel: () => {
      automationState.cancelRequested = true;
    },
    isActive: () => automationState.active,
  };

  return bot.automation;
}

// ---------------------------------------------------------------------------
// Command parsing helper (used by bot.js's unified router)
// ---------------------------------------------------------------------------
/**
 * Parses "переплавь [item] [count]" / "smelt [item] [count]" and
 * "скрафт(уй) <item> [count]" / "craft <item> [count]".
 * Returns null if `text` doesn't match either form.
 */
function resolveAutomationCommand(text) {
  const normalized = text.trim().toLowerCase();

  const smeltMatch = normalized.match(/^(?:переплавь|smelt)\b\s*(.*)$/i);
  if (smeltMatch) {
    const { itemName, count } = splitTrailingCount(smeltMatch[1]);
    return { type: 'smelt', itemName: itemName || null, count };
  }

  const craftMatch = normalized.match(/^(?:скрафт(?:уй)?|craft)\b\s*(.*)$/i);
  if (craftMatch) {
    const { itemName, count } = splitTrailingCount(craftMatch[1]);
    return { type: 'craft', itemName: itemName || null, count };
  }

  return null;
}

function splitTrailingCount(str) {
  const parts = str.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { itemName: null, count: 1 };

  const last = parts[parts.length - 1];
  const maybeCount = parseInt(last, 10);
  if (!isNaN(maybeCount) && parts.length > 1) {
    parts.pop();
    return { itemName: parts.join('_'), count: maybeCount };
  }

  return { itemName: parts.join('_'), count: 1 };
}

// ---------------------------------------------------------------------------
// Smelting
// ---------------------------------------------------------------------------
async function smeltItem(bot, mcData, config, itemName, count) {
  automationState.active = true;
  automationState.cancelRequested = false;

  try {
    const rawName = itemName ? normalizeItemName(itemName) : autoDetectSmeltable(bot, config);
    if (!rawName) {
      bot.chat('Нечего плавить — нет подходящей руды или сырья в инвентаре.');
      return false;
    }

    const outputName = config.smeltableInputs[rawName];
    if (!outputName) {
      bot.chat(`Не знаю, как переплавить "${rawName}". Может, это уже готовый предмет?`);
      return false;
    }

    const inputStack = findInventoryItem(bot, rawName);
    if (!inputStack || inputStack.count < 1) {
      bot.chat(`У меня нет "${rawName}" для переплавки.`);
      return false;
    }

    const fuel = pickFuel(bot, config);
    if (!fuel) {
      bot.chat('Нет топлива — уголь, древесный уголь или доски бы не помешали.');
      return false;
    }

    const furnaceBlock = findNearbyFurnace(bot, mcData, config);
    if (!furnaceBlock) {
      bot.chat(`Не вижу печку в радиусе ${config.searchRadius} блоков.`);
      return false;
    }

    await approachBlock(bot, furnaceBlock, config);
    if (automationState.cancelRequested) return false;

    const furnace = await bot.openFurnace(furnaceBlock);
    try {
      const smeltCount = Math.min(count, inputStack.count);

      await furnace.putFuel(fuel.type, null, 1);
      await furnace.putInput(inputStack.type, null, smeltCount);

      bot.chat(`Плавлю ${smeltCount}x ${rawName} -> ${outputName}...`);

      const gotOutput = await waitForFurnaceOutput(furnace, config);

      if (gotOutput) {
        await furnace.takeOutput();
        bot.chat(`Готово. Забрал ${outputName} из печки.`);
      } else {
        bot.chat('Печка что-то не торопится. Забери результат позже сам.');
      }

      return gotOutput;
    } finally {
      furnace.close();
    }
  } catch (err) {
    console.error('[automation] Smelt error:', err.message);
    bot.chat(`Не получилось переплавить: ${err.message}`);
    return false;
  } finally {
    automationState.active = false;
  }
}

function waitForFurnaceOutput(furnace, config) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      furnace.removeListener('update', onUpdate);
      clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const onUpdate = () => {
      if (automationState.cancelRequested) return finish(false);
      const output = furnace.outputItem();
      if (output && output.count > 0) finish(true);
    };

    // 'update' fires on server-driven window updates; poll too, since some
    // servers batch/throttle those updates more than real progress ticks.
    const pollTimer = setInterval(() => {
      onUpdate();
    }, config.pollIntervalMs);

    const timeoutTimer = setTimeout(() => finish(false), config.smeltTimeoutMs);

    furnace.on('update', onUpdate);
    onUpdate(); // in case output is already sitting there from a prior run
  });
}

function autoDetectSmeltable(bot, config) {
  for (const item of bot.inventory.items()) {
    if (config.smeltableInputs[item.name]) {
      return item.name;
    }
  }
  return null;
}

function pickFuel(bot, config) {
  for (const fuelName of config.fuelPriority) {
    const stack = findInventoryItem(bot, fuelName);
    if (stack && stack.count > 0) return stack;
  }
  return null;
}

function findNearbyFurnace(bot, mcData, config) {
  const ids = FURNACE_BLOCK_NAMES
    .map((name) => mcData.blocksByName[name]?.id)
    .filter((id) => id !== undefined);

  if (ids.length === 0) return null;

  const pos = bot.findBlock({
    matching: (block) => ids.includes(block.type),
    maxDistance: config.searchRadius,
  });

  return pos ? bot.blockAt(pos.position || pos) : null;
}

// ---------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------
async function craftItem(bot, mcData, config, itemName, count) {
  automationState.active = true;
  automationState.cancelRequested = false;

  try {
    if (!itemName) {
      bot.chat('Что крафтить? Использование: craft <предмет> [количество]');
      return false;
    }

    const normalized = normalizeItemName(itemName);
    const itemType = mcData.itemsByName[normalized];
    if (!itemType) {
      bot.chat(`Не знаю такой предмет: "${normalized}".`);
      return false;
    }

    // First try a 2x2 inventory-grid recipe (no table needed).
    let recipes = bot.recipesFor(itemType.id, null, 1, null);
    let craftingTableBlock = null;

    if (recipes.length === 0) {
      craftingTableBlock = findNearbyCraftingTable(bot, mcData, config);
      if (!craftingTableBlock) {
        bot.chat(`"${normalized}" нужен верстак, а его не видно в радиусе ${config.searchRadius} блоков.`);
        return false;
      }

      await approachBlock(bot, craftingTableBlock, config);
      if (automationState.cancelRequested) return false;

      recipes = bot.recipesFor(itemType.id, null, 1, craftingTableBlock);
    }

    if (recipes.length === 0) {
      bot.chat(`Не хватает материалов, чтобы скрафтить "${normalized}".`);
      return false;
    }

    bot.chat(`Крафчу ${count}x ${normalized}...`);
    await bot.craft(recipes[0], count, craftingTableBlock);
    bot.chat(`Готово: ${count}x ${normalized}.`);
    return true;
  } catch (err) {
    console.error('[automation] Craft error:', err.message);
    bot.chat(`Не получилось скрафтить: ${err.message}`);
    return false;
  } finally {
    automationState.active = false;
  }
}

function findNearbyCraftingTable(bot, mcData, config) {
  const blockType = mcData.blocksByName['crafting_table'];
  if (!blockType) return null;

  const pos = bot.findBlock({
    matching: blockType.id,
    maxDistance: config.searchRadius,
  });

  return pos ? bot.blockAt(pos.position || pos) : null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
async function approachBlock(bot, block, config) {
  if (!bot.pathfinder) return; // pathfinder not loaded — best-effort, assume already close
  const goal = new goals.GoalLookAtBlock(block.position, bot.world, {
    range: config.approachRange,
  });
  await bot.pathfinder.goto(goal);
}

function findInventoryItem(bot, itemName) {
  return bot.inventory.items().find((item) => item.name === itemName) || null;
}

function normalizeItemName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

module.exports = { setupAutomation, resolveAutomationCommand };
