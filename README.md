node --max-old-space-size=400 --expose-gc bot.js

npm install mineflayer-pathfinder mineflayer-collectblock

const { setupMining } = require('./mining');
bot.once('spawn', () => setupMining(bot));

npm install mineflayer-pvp

const { setupMining } = require('./mining');
const { setupCombat } = require('./combat');
bot.once('spawn', () => {
  setupMining(bot);
  setupCombat(bot);
});

npm install say

const { setupVoiceControl } = require('./voice-control');
bot.once('spawn', () => setupVoiceControl(bot));
