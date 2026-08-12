/**
 * Mineflayer Bot — Part 5a: VLM Screenshot Vision Module
 * Target: Minecraft 1.20.2
 *
 * Requires:
 *   npm install screenshot-desktop node-fetch
 *   Linux screenshot-desktop needs `scrot`, `imagemagick`, or `gnome-screenshot`
 *   available on PATH (whichever backend is installed system-wide).
 *
 * Usage:
 *   const { analyzeScreenAndRespond } = require('./vision');
 *   await analyzeScreenAndRespond(bot, config, 'что ты видишь');
 *
 * DISK-SAFETY GUARANTEE:
 * This module never writes a screenshot to disk. `screenshot-desktop` only
 * writes a file when given a `filename` option — we deliberately never pass
 * one, so it resolves directly to an in-memory Buffer. That buffer is
 * base64-encoded, sent to the API, and then dropped (no reference retained)
 * so it's eligible for GC on the very next pass. This matters on a laptop
 * SSD where "screenshot on every chat message" would otherwise be a lot of
 * needless write-wear over a long uptime.
 */

const screenshot = require('screenshot-desktop');
const fetch = require('node-fetch');
const { speak } = require('./voice-control');

const DEFAULT_TIMEOUT_MS = 30_000;

// Prevent overlapping vision calls — a screenshot + VLM round trip is slow
// (seconds), and firing two concurrently would double screen-capture load
// and could interleave garbled TTS output.
let visionBusy = false;

/**
 * Captures the current screen straight into a RAM buffer, sends it to the
 * configured multimodal model alongside `userText`, and speaks the model's
 * (in-character, sarcastic) reply via voice-control's TTS.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {object} config   parsed config.json
 * @param {string} userText the player's question / trigger phrase
 * @returns {Promise<string|null>} the spoken reply text, or null on failure
 */
async function analyzeScreenAndRespond(bot, config, userText) {
  if (visionBusy) {
    console.log('[vision] Ignoring request — already analyzing a screenshot.');
    return null;
  }
  visionBusy = true;

  try {
    const base64Image = await captureScreenAsBase64();
    if (!base64Image) {
      speak('Экран не показался. Видимо, у меня и так глаз нет.', config);
      return null;
    }

    const reply = await queryVisionModel(config, userText, base64Image);

    console.log(`[vision] Reply: ${reply}`);

    if (config.silentChat) {
      speak(reply, config);
    } else {
      sendChunkedChat(bot, reply);
      speak(reply, config);
    }

    return reply;
  } catch (err) {
    console.error('[vision] Error:', err.message);
    const fallback = 'Что-то с глазами. Технические шоколадки, не мешай.';
    speak(fallback, config);
    return null;
  } finally {
    visionBusy = false;
    // The base64 string (potentially several MB) and any intermediate
    // buffers go out of scope here — force a GC pass so that memory is
    // reclaimed immediately rather than lingering until the next scheduled
    // sweep in bot.js's memory optimizer.
    if (global.gc) global.gc();
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture (RAM only — never touches disk)
// ---------------------------------------------------------------------------
async function captureScreenAsBase64() {
  try {
    // No `filename` option => screenshot-desktop resolves to a Buffer
    // instead of writing a file to disk.
    const buffer = await screenshot({ format: 'jpeg' });
    const base64 = buffer.toString('base64');
    return base64;
  } catch (err) {
    console.error('[vision] Screenshot capture failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multimodal request to the VLM
// ---------------------------------------------------------------------------
async function queryVisionModel(config, userText, base64Image) {
  if (!getApiKey(config)) {
    throw new Error('Missing API key (set OPENAI_API_KEY, or config.ai.apiKey)');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.ai.requestTimeoutMs || DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetch(config.ai.apiUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getApiKey(config)}`,
      },
      body: JSON.stringify({
        model: config.ai.visionModel || 'gpt-4o-mini',
        max_tokens: config.ai.maxTokens || 220,
        temperature: config.ai.temperature ?? 0.9,
        messages: [
          { role: 'system', content: config.ai.systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: userText && userText.length > 0
                  ? userText
                  : 'Опиши, что сейчас происходит на экране, в своём фирменном саркастичном стиле.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                  detail: 'low', // keeps token cost/latency down; screen context rarely needs full-res detail
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`Vision API returned HTTP ${response.status} ${bodyText.slice(0, 200)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || '...';
  } finally {
    clearTimeout(timeout);
  }
}

function getApiKey(config) {
  return process.env.OPENAI_API_KEY || config.ai.apiKey;
}

// Minecraft caps chat messages around 256 characters; split long replies
// so a non-silent response doesn't get truncated/rejected server-side.
function sendChunkedChat(bot, text) {
  const MAX_LEN = 250;
  for (let i = 0; i < text.length; i += MAX_LEN) {
    bot.chat(text.slice(i, i + MAX_LEN));
  }
}

module.exports = { analyzeScreenAndRespond };
