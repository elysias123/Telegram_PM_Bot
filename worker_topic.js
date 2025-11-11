/**
 * worker.js - Topic-Isolated Telegram PM Bot
 *
 * Features:
 *  1. Topic/Thread 隔离每个用户的对话
 *  2. 首次私聊/话题关键词检测（超过3次封锁）
 *  3. 100以内加减法验证（3次机会）
 *  4. 管理员跳过验证
 *  5. 禁止引用 bot 消息触发
 *
 * Required Worker bindings:
 *  - Environment variables:
 *      BOT_TOKEN  (Telegram bot token)
 *      BOT_SECRET (optional)
 *      ADMIN_UID  (admin numeric id as string)
 *  - KV Namespace binding:
 *      NFD
 */

const TOKEN = BOT_TOKEN;
const SECRET = BOT_SECRET || '';
const ADMIN_UID = String(ADMIN_UID || '');
const nfd = NFD;

const KEYWORDS = ['单人日赚', '长期合作的来', '无需押金', '赚钱'];
const MAX_HIT = 3;
const MAX_TRY = 3;
const VERIFY_TTL = 600;
const HIT_TTL = 86400;

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method !== 'POST') return new Response('ok', { status: 200 });
  let update;
  try { update = await request.json(); } catch (e) { return new Response('invalid json', { status: 400 }); }

  const msg = update.message || update.edited_message;
  if (!msg) return new Response('ok', { status: 200 });

  const fromId = String(msg.from?.id || '');
  const chatId = String(msg.chat?.id || '');
  const threadId = msg.message_thread_id ? String(msg.message_thread_id) : chatId;
  const sessionId = `${chatId}-${threadId}`;

  // 1) 禁止引用 Bot 消息触发
  if (msg.reply_to_message?.from?.is_bot) {
    await sendMessage(sessionId, '⚠️ 禁止通过引用 Bot 消息触发，请直接发送消息。');
    return new Response('ok');
  }

  // 2) 检查封锁
  const blockKey = `block-${sessionId}`;
  if (await nfd.get(blockKey)) return new Response('ok');

  // 3) 管理员跳过验证
  if (fromId === ADMIN_UID) {
    await handleAdminMessage(msg);
    return new Response('ok');
  }

  const firstDetectKey = `first-detect-${sessionId}`;
  const verifyKey = `verify-${sessionId}`;
  const keywordHitKey = `keyword-hit-${sessionId}`;

  // 4) 正在验证阶段
  const verifyDataRaw = await nfd.get(verifyKey);
  if (verifyDataRaw) {
    try {
      const verifyData = JSON.parse(verifyDataRaw);
      await handleVerificationAnswer(sessionId, msg, verifyData);
    } catch (e) { await nfd.delete(verifyKey); await sendMessage(sessionId, '发生错误，请重新开始对话。'); }
    return new Response('ok');
  }

  // 5) 首次检测
  const firstDetected = await nfd.get(firstDetectKey);
  if (!firstDetected) {
    await nfd.put(firstDetectKey, '1');

    // 5a) 关键词检测
    if (msg.text && containsAnyKeyword(msg.text)) {
      const prev = await nfd.get(keywordHitKey);
      const prevNum = prev ? Number(prev) : 0;
      const hitInc = countKeywordHits(msg.text);
      const newCount = prevNum + hitInc;
      await nfd.put(keywordHitKey, String(newCount), { expirationTtl: HIT_TTL });

      if (newCount >= MAX_HIT) {
        await nfd.put(blockKey, '1');
        await sendMessage(sessionId, '⚠️ 您的首次消息包含敏感词，已被自动封锁。');
        await notifyAdmin(`🚫 用户 ${fromId} 首次消息触发敏感词，累计 ${newCount} 次，已封锁。`);
        return new Response('ok');
      } else {
        await sendMessage(sessionId, `⚠️ 检测到敏感词（第 ${newCount}/${MAX_HIT} 次）。请完成验证以继续。`);
      }
    }

    // 5b) 发出加减法验证
    const { a, b, op, answer } = genMathQuestion();
    const verifyState = { answer, tries: 0 };
    await nfd.put(verifyKey, JSON.stringify(verifyState), { expirationTtl: VERIFY_TTL });
    await sendMessage(sessionId, `🧮 验证：请计算 ${a} ${op} ${b} = ?\n您有 ${MAX_TRY} 次机会，请直接回复数字答案。`);
    return new Response('ok');
  }

  // 6) 正常转发或其他逻辑
  await forwardToAdminAndMap(msg, sessionId);
  return new Response('ok');
}

/* --------- Helpers --------- */
function containsAnyKeyword(text) { return KEYWORDS.some(k => text.includes(k)); }
function countKeywordHits(text) { return KEYWORDS.reduce((acc, k) => acc + (text.includes(k) ? 1 : 0), 0); }
function genMathQuestion() {
  const a = Math.floor(Math.random() * 100), b = Math.floor(Math.random() * 100);
  const op = Math.random() < 0.5 ? '+' : '-';
  const answer = op === '+' ? a + b : a - b;
  return { a, b, op, answer };
}

async function handleVerificationAnswer(sessionId, msg, verifyData) {
  const verifyKey = `verify-${sessionId}`, blockKey = `block-${sessionId}`;
  const text = (msg.text || '').trim();
  const parsed = Number(text);
  if (!text || isNaN(parsed)) { await sendMessage(sessionId, '❗ 请输入数字答案（例如：42）。'); return; }

  const correct = Number(verifyData.answer);
  let tries = Number(verifyData.tries || 0);
  if (parsed === correct) {
    await nfd.delete(verifyKey);
    await sendMessage(sessionId, '✅ 验证通过，您可以正常与管理员交流。');
    await notifyAdmin(`✅ 用户 ${sessionId} 验证通过。`);
    return;
  } else {
    tries += 1;
    if (tries >= MAX_TRY) {
      await nfd.delete(verifyKey);
      await nfd.put(blockKey, '1');
      await sendMessage(sessionId, '❌ 验证失败，您已被自动封锁。');
      await notifyAdmin(`🚫 用户 ${sessionId} 验证失败 ${MAX_TRY} 次，已封锁。`);
      return;
    } else {
      verifyData.tries = tries;
      await nfd.put(verifyKey, JSON.stringify(verifyData), { expirationTtl: VERIFY_TTL });
      await sendMessage(sessionId, `❌ 答案错误，还剩 ${MAX_TRY - tries} 次机会。`);
      return;
    }
  }
}

/* Admin logic simplified */
async function handleAdminMessage(msg) {
  const text = (msg.text || '').trim(), parts = text.split(/\s+/), cmd = parts[0] || '';
  if (cmd.startsWith('/block')) { const target = parts[1]; if (!target) return await sendMessage(ADMIN_UID,'用法:/block <userid>'); await nfd.put(`block-${target}`,'1'); return await sendMessage(ADMIN_UID,`已封锁 ${target}`);}
  if (cmd.startsWith('/unblock')) { const target = parts[1]; if (!target) return await sendMessage(ADMIN_UID,'用法:/unblock <userid>'); await nfd.delete(`block-${target}`); return await sendMessage(ADMIN_UID,`已解除封锁 ${target}`);}
  if (cmd.startsWith('/checkblock')) { const target = parts[1]; if (!target) return await sendMessage(ADMIN_UID,'用法:/checkblock <userid>'); const blocked=await nfd.get(`block-${target}`); return await sendMessage(ADMIN_UID, blocked?`用户 ${target} 被封锁`:`用户 ${target} 未被封锁`);}
  // Admin reply to forwarded messages
  if(msg.reply_to_message?.message_id){ const replyToId=String(msg.reply_to_message.message_id); const mappingKey=`msg-map-${replyToId}`; const targetChat=await nfd.get(mappingKey); if(targetChat){ const textToSend=msg.text||''; if(textToSend) await sendMessage(targetChat, `管理员：\n${textToSend}`); await sendMessage(ADMIN_UID, `已发送给 ${targetChat}`);} else await sendMessage(ADMIN_UID,'未找到映射，无法转发回复。'); return;}
  await sendMessage(ADMIN_UID,'收到管理员消息（未识别命令或未回复转发消息）。');
}

async function forwardToAdminAndMap(msg, sessionId) {
  const fromId = String(msg.from?.id || ''), msgId = msg.message_id;
  try {
    const forwardRes = await fetchTelegram('forwardMessage',{ chat_id: ADMIN_UID, from_chat_id: msg.chat.id, message_id: msgId });
    if (forwardRes?.ok && forwardRes.result?.message_id){
      const forwardedMessageId=String(forwardRes.result.message_id);
      await nfd.put(`msg-map-${forwardedMessageId}`, fromId, { expirationTtl: 7*24*3600 });
    } else {
      const textSummary=`来自 ${fromId} 的消息：\n${msg.text||'<非文本消息>'}`;
      const res=await sendMessage(ADMIN_UID,textSummary);
      if(res?.ok && res.result?.message_id) await nfd.put(`msg-map-${res.result.message_id}`, fromId,{expirationTtl:7*24*3600});
    }
  } catch(e){ await sendMessage(ADMIN_UID,`转发消息失败：${String(e)}`);}
}

async function sendMessage(chatId,text,extra={}){ return fetchTelegram('sendMessage',Object.assign({chat_id:chatId,text,parse_mode:'HTML',disable_web_page_preview:true},extra)); }
async function notifyAdmin(text){ return sendMessage(ADMIN_UID,text); }
async function fetchTelegram(method,body){ const url=`https://api.telegram.org/bot${TOKEN}/${method}`; const resp=await fetch(url,{method:'POST',body:JSON.stringify(body),headers:{'content-type':'application/json'}}); try{return await resp.json();}catch(e){return null;} }
