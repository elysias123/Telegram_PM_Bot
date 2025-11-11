/**
 * worker.js
 * Telegram PM Bot for Cloudflare Workers
 *
 * Features:
 *  - For first-time private chat only:
 *      1) Keyword detection (counts hits, >=3 -> auto block)
 *      2) 100-within addition/subtraction verification (3 tries) -> must pass or auto block
 *  - Admin bypass (ADMIN_UID)
 *  - Uses KV namespace `NFD` for storage
 *
 * Required Worker bindings:
 *  - Environment variables:
 *      BOT_TOKEN  (Telegram bot token)
 *      BOT_SECRET (optional)
 *      ADMIN_UID  (admin numeric id as string or number)
 *  - KV Namespace binding:
 *      NFD
 *
 * Deploy note: make sure to set correct bindings in Cloudflare dashboard.
 */

const TOKEN = BOT_TOKEN; // from Worker environment
const SECRET = BOT_SECRET || ''; // optional
const ADMIN_UID = String(ADMIN_UID || ''); // store as string for comparisons

// Keyword and verification config
const KEYWORDS = ['单人日赚', '长期合作的来', '无需押金', '赚钱'];
const MAX_HIT = 3;       // 达到次数后封锁
const MAX_TRY = 3;       // 验证答题最大尝试次数
const VERIFY_TTL = 600;  // verification state expire in seconds (10 minutes)
const HIT_TTL = 86400;   // keyword-hit ttl in seconds (24 hours)

// NFD is the KV binding name in Worker settings
const nfd = NFD; // ensure your KV binding is named "NFD"

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // If using secret in path: you can check here; for simplicity we accept POST JSON body from Telegram
  if (request.method !== 'POST') return new Response('ok', { status: 200 });

  let update;
  try {
    update = await request.json();
  } catch (e) {
    return new Response('invalid json', { status: 400 });
  }

  // Telegram updates can have many fields; we handle message
  const msg = update.message || update.edited_message || null;
  if (!msg) return new Response('no message', { status: 200 });

  const from = msg.from || {};
  const fromId = String(from.id || '');
  const chat = msg.chat || {};
  const chatId = String(chat.id || '');

  // Basic block check: if user is blocked, ignore or optionally inform
  const blockKey = `block-${fromId}`;
  const isBlocked = await nfd.get(blockKey);
  if (isBlocked) {
    // Optionally inform user they are blocked (commented out to avoid spam)
    // await sendMessage(fromId, '您已被封锁。');
    return new Response('ok', { status: 200 });
  }

  // Admin shortcut: skip first-check / verification and handle admin commands
  const isAdmin = (fromId === String(ADMIN_UID));
  if (isAdmin) {
    await handleAdminMessage(msg);
    return new Response('ok', { status: 200 });
  }

  // Non-admin: proceed with first-contact + verification logic

  const firstDetectKey = `first-detect-${fromId}`;
  const verifyKey = `verify-${fromId}`; // stores JSON {answer, tries}
  const keywordHitKey = `keyword-hit-${fromId}`;

  // If user is in verification stage, handle answer checking first
  const verifyDataRaw = await nfd.get(verifyKey);
  if (verifyDataRaw) {
    try {
      const verifyData = JSON.parse(verifyDataRaw);
      await handleVerificationAnswer(fromId, msg, verifyData);
    } catch (e) {
      // if parse fail, clear state
      await nfd.delete(verifyKey);
      await sendMessage(fromId, '发生错误，请重新开始对话。');
    }
    return new Response('ok', { status: 200 });
  }

  // If firstDetect not present => this is first contact (or first we track)
  const firstDetected = await nfd.get(firstDetectKey);
  if (!firstDetected) {
    // Mark that we've done first-detection for this user (so it's only once)
    await nfd.put(firstDetectKey, '1');

    // 1) Keyword detection
    if (msg.text && containsAnyKeyword(msg.text)) {
      // increase hit count
      const prev = await nfd.get(keywordHitKey);
      const prevNum = prev ? Number(prev) : 0;
      const hitInc = countKeywordHits(msg.text);
      const newCount = prevNum + hitInc;
      await nfd.put(keywordHitKey, String(newCount), { expirationTtl: HIT_TTL });

      if (newCount >= MAX_HIT) {
        // block user
        await nfd.put(blockKey, '1');
        await sendMessage(fromId, '⚠️ 您的首次消息包含敏感词，已被自动封锁。');
        await notifyAdmin(`🚫 用户 ${fromId} 因首次消息触发敏感词（累计 ${newCount} 次）已被封锁。`);
        return new Response('ok', { status: 200 });
      } else {
        // inform user and continue to verification
        await sendMessage(fromId, `⚠️ 检测到敏感词（第 ${newCount}/${MAX_HIT} 次）。接下来请完成验证以继续。`);
      }
    }

    // 2) Issue math verification (only if not blocked)
    const { a, b, op, answer } = genMathQuestion();
    const verifyState = { answer, tries: 0 };
    await nfd.put(verifyKey, JSON.stringify(verifyState), { expirationTtl: VERIFY_TTL });

    await sendMessage(fromId, `🧮 验证：请计算 ${a} ${op} ${b} = ?\n您有 ${MAX_TRY} 次机会，请直接回复数字答案。`);
    return new Response('ok', { status: 200 });
  }

  // If not in verification and not first contact, proceed with normal forwarding behavior
  // (forward message to admin and keep mapping so admin can reply)
  await forwardToAdminAndMap(msg);
  return new Response('ok', { status: 200 });
}

/* --------- Helpers --------- */

function containsAnyKeyword(text) {
  if (!text) return false;
  for (const k of KEYWORDS) {
    if (text.includes(k)) return true;
  }
  return false;
}

function countKeywordHits(text) {
  // count how many keywords appear (count duplicates across keywords; not multiple occurrences of same keyword)
  if (!text) return 0;
  let count = 0;
  for (const k of KEYWORDS) {
    if (text.includes(k)) count += 1;
  }
  return count;
}

function genMathQuestion() {
  const a = Math.floor(Math.random() * 100); // 0..99
  const b = Math.floor(Math.random() * 100); // 0..99
  const op = Math.random() < 0.5 ? '+' : '-';
  const answer = op === '+' ? (a + b) : (a - b);
  return { a, b, op, answer };
}

async function handleVerificationAnswer(fromId, msg, verifyData) {
  // verifyData: { answer, tries }
  const verifyKey = `verify-${fromId}`;
  const blockKey = `block-${fromId}`;
  const keywordHitKey = `keyword-hit-${fromId}`;

  // Accept numeric reply only
  const text = (msg.text || '').trim();
  const parsed = Number(text);
  if (!text || isNaN(parsed)) {
    await sendMessage(fromId, '❗ 请输入数字答案（例如：42）。');
    return;
  }

  const correct = Number(verifyData.answer);
  let tries = Number(verifyData.tries || 0);

  if (parsed === correct) {
    // success: remove verification and notify admin
    await nfd.delete(verifyKey);
    await sendMessage(fromId, '✅ 验证通过，您可以正常与管理员交流。');
    await notifyAdmin(`✅ 用户 ${fromId} 验证通过。`);
    return;
  } else {
    tries += 1;
    if (tries >= MAX_TRY) {
      // fail and block
      await nfd.delete(verifyKey);
      await nfd.put(blockKey, '1');
      await sendMessage(fromId, '❌ 验证失败，您已被自动封锁。');
      await notifyAdmin(`🚫 用户 ${fromId} 验证失败 ${MAX_TRY} 次，已被自动封锁。`);
      return;
    } else {
      // update tries and prompt remaining
      verifyData.tries = tries;
      await nfd.put(verifyKey, JSON.stringify(verifyData), { expirationTtl: VERIFY_TTL });
      await sendMessage(fromId, `❌ 答案错误，还剩 ${MAX_TRY - tries} 次机会。请继续尝试。`);
      return;
    }
  }
}

/* Minimal admin handling: block/unblock/check commands & replying to forwarded messages
   Extend this function to match your original script's admin logic (forwarding, reply mapping, etc.)
*/
async function handleAdminMessage(msg) {
  const text = (msg.text || '').trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0] || '';

  if (cmd.startsWith('/block')) {
    const target = parts[1];
    if (!target) {
      await sendMessage(ADMIN_UID, '用法: /block <userid>');
      return;
    }
    await nfd.put(`block-${String(target)}`, '1');
    await sendMessage(ADMIN_UID, `已封锁用户 ${target}`);
    return;
  }

  if (cmd.startsWith('/unblock')) {
    const target = parts[1];
    if (!target) {
      await sendMessage(ADMIN_UID, '用法: /unblock <userid>');
      return;
    }
    await nfd.delete(`block-${String(target)}`);
    await sendMessage(ADMIN_UID, `已解除封锁 ${target}`);
    return;
  }

  if (cmd.startsWith('/checkblock')) {
    const target = parts[1];
    if (!target) {
      await sendMessage(ADMIN_UID, '用法: /checkblock <userid>');
      return;
    }
    const blocked = await nfd.get(`block-${String(target)}`);
    await sendMessage(ADMIN_UID, blocked ? `用户 ${target} 被封锁` : `用户 ${target} 未被封锁`);
    return;
  }

  // If admin replies to a forwarded message, handle mapping reply -> original user
  // Here we expect admin to reply to the message we forwarded; Telegram provides reply_to_message.message_id
  if (msg.reply_to_message && msg.reply_to_message.message_id) {
    const replyToId = String(msg.reply_to_message.message_id);
    const mappingKey = `msg-map-${replyToId}`;
    const targetChat = await nfd.get(mappingKey);
    if (targetChat) {
      // send admin's reply content to original user
      const textToSend = msg.text || '';
      if (textToSend) {
        await sendMessage(targetChat, `管理员：\n${textToSend}`);
        await sendMessage(ADMIN_UID, `已发送给 ${targetChat}`);
      } else if (msg.photo || msg.document || msg.sticker) {
        // not implemented: you can add copyMessage or sendDocument logic here
        await sendMessage(ADMIN_UID, '收到非文本消息，管理员回复转发功能未实现该类型（请扩展）。');
      }
    } else {
      await sendMessage(ADMIN_UID, '未找到映射，无法转发回复。');
    }
    return;
  }

  // default admin behavior: ack
  await sendMessage(ADMIN_UID, '收到管理员消息（未识别命令或未回复转发消息）。');
}

/* Forward user message to admin and keep mapping */
async function forwardToAdminAndMap(msg) {
  const from = msg.from || {};
  const fromId = String(from.id || '');
  const chat = msg.chat || {};
  const msgId = msg.message_id;

  // forwardMessage - Telegram will show forwarded from user (if desired)
  try {
    const forwardRes = await fetchTelegram('forwardMessage', {
      chat_id: ADMIN_UID,
      from_chat_id: chat.id,
      message_id: msgId
    });

    // store mapping: forwarded message id -> original user id
    if (forwardRes && forwardRes.ok && forwardRes.result && forwardRes.result.message_id) {
      const forwardedMessageId = String(forwardRes.result.message_id);
      await nfd.put(`msg-map-${forwardedMessageId}`, fromId, { expirationTtl: 7 * 24 * 3600 }); // 7 days
    } else {
      // fallback: send a summary to admin
      const textSummary = `来自 ${fromId} 的消息：\n${msg.text || '<非文本消息>'}`;
      const res = await sendMessage(ADMIN_UID, textSummary);
      // if sendMessage returned message id, map it
      if (res && res.ok && res.result && res.result.message_id) {
        await nfd.put(`msg-map-${String(res.result.message_id)}`, fromId, { expirationTtl: 7 * 24 * 3600 });
      }
    }
  } catch (e) {
    await sendMessage(ADMIN_UID, `转发消息失败：${String(e)}`);
  }
}

/* Telegram API helpers */

async function sendMessage(chatId, text, extra = {}) {
  return fetchTelegram('sendMessage', Object.assign({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  }, extra));
}

async function notifyAdmin(text) {
  return sendMessage(ADMIN_UID, text);
}

async function fetchTelegram(method, body) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' }
  });
  try {
    return await resp.json();
  } catch (e) {
    return null;
  }
}
