import RoomMessage from '../models/RoomMessage.js';
import { config } from '../config/appConfig.js';
import { getKarachiDateKey } from './pairService.js';
import { resolveMemberName } from './memberService.js';
import {
  recordReviewFromMessage,
  formatWrongPairAlert,
  handleReviewMessageDeleted,
} from './reviewService.js';
import { sendMatrixMessage, sendMatrixMessageToRoom } from './matrixService.js';
import {
  emitRoomMessage,
  emitRoomMessageDeleted,
  emitMemberRoomMessage,
} from './socketService.js';
import {
  getMemberForRoomId,
  isMemberRoom,
  touchMemberRoom,
} from './memberRoomService.js';

const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const seenEvents = new Set();

/** Matrix edit events carry the new body under m.new_content and point at the original. */
const getEditTargetEventId = (content = {}) => {
  const relatesTo = content['m.relates_to'];
  if (relatesTo?.rel_type === 'm.replace' && relatesTo.event_id) {
    return relatesTo.event_id;
  }
  return null;
};

const getEffectiveBody = (content = {}) => {
  const edited = content['m.new_content']?.body;
  if (typeof edited === 'string' && edited.trim()) return edited.trim();
  return (content.body || '').trim();
};

const classifyBotMessage = (body) => {
  if (body.startsWith('Pairs Today')) return 'bot_pairs';
  if (body.startsWith('🔔 Review Reminder')) return 'bot_reminder';
  if (body.startsWith('🔔 Missing Review')) return 'bot_dm_prompt';
  if (body.startsWith('Missing review for')) return 'bot_missed';
  if (body.startsWith('Yesterday (')) return 'bot_missed';
  if (body.startsWith('⚠️ Wrong Pair Review')) return 'bot_wrong_pair';
  if (body.startsWith('⚠️ Duplicate Pair Review')) return 'bot_duplicate';
  if (body.startsWith('📋 **Pair Review Report') || body.startsWith('📋 Pair Review Report')) {
    return 'bot_boss';
  }
  return 'bot_other';
};

const normalizeEvent = (event, direction = 'in', botUserId = null) => {
  const content = event.content || {};
  const msgtype = content.msgtype || content['m.new_content']?.msgtype || 'm.text';
  if (!['m.text', 'm.notice', 'm.emote'].includes(msgtype)) return null;

  const body = getEffectiveBody(content);
  if (!body) return null;

  const eventId = event.event_id;
  if (!eventId || seenEvents.has(eventId)) return null;
  seenEvents.add(eventId);

  const senderId = event.sender || '';
  const isBot = botUserId && senderId === botUserId;
  const senderName = isBot
    ? 'Chat Bot'
    : resolveMemberName(senderId, event.content?.displayname || '') ||
      senderId.split(':')[0]?.slice(1) ||
      'Unknown';

  let category = 'team_review';
  if (isBot) {
    category = classifyBotMessage(body);
  }

  return {
    eventId,
    dateKey: getKarachiDateKey(new Date(event.origin_server_ts || Date.now())),
    roomId: event.room_id || config.matrix.roomId,
    senderId,
    senderName,
    body,
    direction: isBot ? 'out' : direction,
    category,
    messageType: msgtype,
    sentAt: new Date(event.origin_server_ts || Date.now()),
    replacesEventId: getEditTargetEventId(content),
  };
};

const toLivePayload = (saved) => ({
  id: saved._id.toString(),
  eventId: saved.eventId,
  senderName: saved.senderName,
  senderId: saved.senderId,
  body: saved.body,
  direction: saved.direction,
  category: saved.category,
  sentAt: saved.sentAt,
});

const sendWrongPairAlert = async (mentionedNames, pairs, senderName, senderId, relatedEventId) => {
  try {
    const message = formatWrongPairAlert(mentionedNames, pairs, senderName);
    const result = await sendMatrixMessage(message, {
      kind: 'wrong_pair_alert',
      triggeredBy: senderName,
    });
    await logOutgoingMessage(message, result.event_id, 'bot_wrong_pair', {
      alertTriggeredBy: senderName,
      alertTriggeredById: senderId,
      relatedEventId,
      attemptedPair: mentionedNames,
    });
  } catch (error) {
    console.error('Failed to send wrong pair alert:', error.message);
  }
};

/**
 * Apply an Element edit onto the original review message. Never treat the
 * replace event as a second review — that was firing duplicate / wrong-pair
 * warnings whenever someone fixed a typo.
 */
const applyMessageEdit = async (payload) => {
  const original = await RoomMessage.findOne({ eventId: payload.replacesEventId });
  if (!original) {
    // Original not in our DB — store the edit quietly without review side-effects.
    const { replacesEventId, ...rest } = payload;
    return RoomMessage.findOneAndUpdate(
      { eventId: rest.eventId },
      { ...rest, category: 'team_review' },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  original.body = payload.body;
  await original.save();

  if (original.countsAsReview || original.category === 'team_review') {
    const { recomputeReviewedMembers } = await import('./reviewService.js');
    await RoomMessage.updateOne(
      { eventId: original.eventId },
      {
        $set: { body: payload.body },
        $unset: {
          reviewIssue: 1,
          attemptedPair: 1,
          countsAsReview: 1,
          matchedPair: 1,
          pairKey: 1,
        },
      }
    );

    // Re-evaluate the edited body. Never send room alerts for edits.
    await recordReviewFromMessage(payload.body, original.dateKey, original.eventId);
    await recomputeReviewedMembers(original.dateKey);
  }

  const refreshed = await RoomMessage.findOne({ eventId: original.eventId });
  const age = Date.now() - new Date((refreshed || original).sentAt).getTime();
  if (age <= LIVE_WINDOW_MS) {
    emitRoomMessage(toLivePayload(refreshed || original));
  }

  console.log(`[room] Applied edit to ${original.eventId} (ignored replace ${payload.eventId})`);
  return refreshed || original;
};

export const persistAndBroadcastMessage = async (payload) => {
  try {
    if (payload.replacesEventId) {
      return await applyMessageEdit(payload);
    }

    const saved = await RoomMessage.findOneAndUpdate(
      { eventId: payload.eventId },
      payload,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const age = Date.now() - new Date(saved.sentAt).getTime();
    if (age <= LIVE_WINDOW_MS) {
      emitRoomMessage(toLivePayload(saved));
    }

    if (saved.direction === 'in' && saved.category === 'team_review') {
      const result = await recordReviewFromMessage(
        saved.body,
        saved.dateKey,
        saved.eventId
      );
      // Duplicate submissions are logged silently — never warn in the room.
      // Edits are handled above via m.replace and never reach this path.
      if (result?.status === 'wrong_pair') {
        await sendWrongPairAlert(
          result.mentionedNames,
          result.pairs,
          saved.senderName,
          saved.senderId,
          saved.eventId
        );
      } else if (result?.status === 'success') {
        try {
          const { syncPairReviewThreadDraft } = await import(
            './pairThreadService.js'
          );
          await syncPairReviewThreadDraft(saved.dateKey);
        } catch (error) {
          console.warn(`[thread] Draft sync failed: ${error.message}`);
        }

        try {
          const { syncLeadSessionAfterLateReview } = await import(
            './leadReportService.js'
          );
          await syncLeadSessionAfterLateReview(
            saved.dateKey,
            result.matchedPair
          );
        } catch (error) {
          console.warn(`[lead] Late-review sync failed: ${error.message}`);
        }

        if (result.partialQa) {
          try {
            const { sendPartialQaMissingPrompt } = await import(
              './missingReviewPromptService.js'
            );
            await sendPartialQaMissingPrompt({
              dateKey: saved.dateKey,
              pair: result.matchedPair,
              presentMembers: result.presentMembers,
              missingMembers: result.missingMembers,
            });
          } catch (error) {
            console.error(
              `[review] Partial QA follow-up failed: ${error.message}`
            );
          }
        }
      }
    }

    return saved;
  } catch (error) {
    if (error.code === 11000) return null;
    console.error('Failed to persist room message:', error.message);
    return null;
  }
};

/** Store a bot/member message that belongs to a personal follow-up room. */
export const logMemberRoomMessage = async ({
  member,
  roomId,
  body,
  eventId,
  category,
  dateKey,
  direction = 'out',
  senderId,
  senderName,
}) => {
  const payload = {
    eventId: eventId || `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    dateKey: dateKey || getKarachiDateKey(),
    roomId,
    memberName: member,
    senderId: senderId || config.matrix.user || '@bot:local',
    senderName: senderName || (direction === 'out' ? 'Chat Bot' : member),
    body,
    direction,
    category,
    messageType: 'm.text',
    sentAt: new Date(),
  };

  try {
    const saved = await RoomMessage.findOneAndUpdate(
      { eventId: payload.eventId },
      payload,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    emitMemberRoomMessage({ ...toLivePayload(saved), memberName: member, roomId });
    return saved;
  } catch (error) {
    if (error.code !== 11000) {
      console.error('Failed to persist member room message:', error.message);
    }
    return null;
  }
};

/** Route a reply inside a member's personal room to the prompt handler. */
const handleMemberRoomEvent = async (roomId, event, botUserId) => {
  const member = getMemberForRoomId(roomId);
  if (!member) return;

  const content = event.content || {};
  const body = (content.body || '').trim();
  const eventId = event.event_id;
  if (!body || !eventId || seenEvents.has(eventId)) return;
  seenEvents.add(eventId);

  const senderId = event.sender || '';
  const isBot = botUserId && senderId === botUserId;

  if (isBot) {
    await logMemberRoomMessage({
      member,
      roomId,
      body,
      eventId,
      category: classifyBotMessage(body),
    });
    return;
  }

  await logMemberRoomMessage({
    member,
    roomId,
    body,
    eventId,
    category: 'member_dm_reply',
    direction: 'in',
    senderId,
    senderName: member,
  });
  await touchMemberRoom(member, { lastReplyAt: new Date() });

  // Lead report conversation takes priority over legacy member prompts.
  let activeLead = null;
  try {
    const { handleLeadReply, getActiveLeadSessionForMember } = await import(
      './leadReportService.js'
    );
    activeLead = await getActiveLeadSessionForMember(member);
    console.log(
      `[member-room] ${member} reply "${body.slice(0, 40)}" activeLead=${activeLead?.stage || 'none'} date=${activeLead?.dateKey || '-'}`
    );

    if (activeLead) {
      // Stamp the lead-report day on the inbound reply for dashboard history.
      if (activeLead.dateKey) {
        await RoomMessage.updateOne(
          { eventId },
          { $set: { dateKey: activeLead.dateKey } }
        );
      }

      const leadResult = await handleLeadReply(member, roomId, body, eventId);
      console.log(
        `[lead-report] ${member} -> status=${leadResult?.status} ack=${Boolean(leadResult?.ack)}`
      );

      if (leadResult?.ack) {
        try {
          const sent = await sendMatrixMessageToRoom(roomId, leadResult.ack, {
            kind: 'lead_report_ack',
            member,
            dateKey: activeLead.dateKey,
          });
          await logMemberRoomMessage({
            member,
            roomId,
            body: leadResult.ack,
            eventId: sent.event_id,
            category: 'bot_dm_ack',
            dateKey: activeLead.dateKey,
          });
        } catch (error) {
          console.error(`[lead-report] Ack failed for ${member}: ${error.message}`);
        }
      }
      // Always stop here while a lead report is open — never fall through to
      // discussion/missing-review handlers (they would steal YES/NO replies).
      return;
    }
  } catch (error) {
    console.error(`[lead-report] Handler error for ${member}:`, error);
    // If we know a lead session is open, do not let other handlers eat the reply.
    if (activeLead) return;
  }

  // 5 PM meeting-discussion check (YES/NO) — after lead report, before legacy prompts.
  try {
    const { handleDiscussionReply } = await import('./discussionPromptService.js');
    const discussionResult = await handleDiscussionReply(
      member,
      roomId,
      body,
      eventId
    );
    console.log(
      `[discussion] ${member} -> status=${discussionResult?.status} answer=${discussionResult?.answer || '-'}`
    );

    if (discussionResult?.status && discussionResult.status !== 'no_prompt') {
      if (discussionResult.prompt?.reviewDateKey) {
        await RoomMessage.updateOne(
          { eventId },
          { $set: { dateKey: discussionResult.prompt.reviewDateKey } }
        );
      }

      if (discussionResult.ack) {
        try {
          const sent = await sendMatrixMessageToRoom(roomId, discussionResult.ack, {
            kind: 'discussion_ack',
            member,
            dateKey: discussionResult.prompt?.reviewDateKey || null,
          });
          await logMemberRoomMessage({
            member,
            roomId,
            body: discussionResult.ack,
            eventId: sent.event_id,
            category: 'bot_dm_ack',
            dateKey: discussionResult.prompt?.reviewDateKey || null,
          });
        } catch (error) {
          console.error(`[discussion] Ack failed for ${member}: ${error.message}`);
        }
      }
      return;
    }
  } catch (error) {
    console.error(`[discussion] Handler error for ${member}:`, error);
  }

  const { handleMemberReply } = await import('./missingReviewPromptService.js');
  const result = await handleMemberReply(member, roomId, body, eventId);

  if (!result?.ack) return;

  try {
    const sent = await sendMatrixMessageToRoom(roomId, result.ack, {
      kind: 'missing_review_ack',
      member,
    });
    await logMemberRoomMessage({
      member,
      roomId,
      body: result.ack,
      eventId: sent.event_id,
      category: 'bot_dm_ack',
      dateKey: result.prompt?.dateKey,
    });
  } catch (error) {
    console.error(`[member-room] Ack failed for ${member}: ${error.message}`);
  }
};

export const handleIncomingMatrixMessage = async (roomId, event, botUserId) => {
  if (roomId !== config.matrix.roomId) {
    if (isMemberRoom(roomId)) {
      event.room_id = roomId;
      await handleMemberRoomEvent(roomId, event, botUserId);
    }
    return;
  }

  event.room_id = roomId;
  const payload = normalizeEvent(event, 'in', botUserId);
  if (!payload) return;

  await persistAndBroadcastMessage(payload);
};

export const logOutgoingMessage = async (body, eventId, category = null, meta = {}) => {
  const payload = {
    eventId: eventId || `local-${Date.now()}`,
    dateKey: getKarachiDateKey(),
    roomId: config.matrix.roomId,
    senderId: config.matrix.user || '@bot:local',
    senderName: 'Chat Bot',
    body,
    direction: 'out',
    category: category || classifyBotMessage(body),
    messageType: 'm.text',
    sentAt: new Date(),
    ...meta,
  };

  return persistAndBroadcastMessage(payload);
};

/** Messages from the last 24 hours for the live dashboard panel (main room only). */
export const getLiveRoomMessages = (limit = 50) => {
  const since = new Date(Date.now() - LIVE_WINDOW_MS);
  const personal = Object.values(config.memberRoomMap || {}).filter(Boolean);
  const query = { sentAt: { $gte: since } };
  // Exclude personal follow-up rooms — live chat is Main Pair Reviews only.
  // Using $nin (not exact MATRIX_ROOM_ID) so Matrix room upgrades still show.
  if (personal.length) {
    query.roomId = { $nin: personal };
  } else if (config.matrix.roomId) {
    query.roomId = config.matrix.roomId;
  }
  return RoomMessage.find(query).sort({ sentAt: 1 }).limit(limit);
};

/** Team review messages older than 24h (archived) — main Pair Reviews room only. */
export const getArchivedReviewMessages = (limit = 100) => {
  const before = new Date(Date.now() - LIVE_WINDOW_MS);
  const personal = Object.values(config.memberRoomMap || {}).filter(Boolean);
  const query = {
    direction: 'in',
    category: 'team_review',
    sentAt: { $lt: before },
  };
  if (personal.length) {
    query.roomId = { $nin: personal };
  } else if (config.matrix.roomId) {
    query.roomId = config.matrix.roomId;
  }
  return RoomMessage.find(query).sort({ sentAt: -1 }).limit(limit);
};

/** All bot pairs broadcasts from MessageLog + tagged bot_pairs room messages. */
export const getPairsMessageHistory = async (limit = 50) => {
  const botPairs = await RoomMessage.find({ category: 'bot_pairs' })
    .sort({ sentAt: -1 })
    .limit(limit);
  return botPairs;
};

export const getFullHistory = async () => {
  const before = new Date(Date.now() - LIVE_WINDOW_MS);

  const [pairsMessages, reviewMessages] = await Promise.all([
    RoomMessage.find({
      category: { $in: ['bot_pairs', 'bot_reminder', 'bot_missed'] },
    })
      .sort({ sentAt: -1 })
      .limit(100),
    RoomMessage.find({
      $or: [
        { direction: 'in', category: 'team_review' },
        { category: 'bot_reminder' },
      ],
      sentAt: { $lt: before },
    })
      .sort({ sentAt: -1 })
      .limit(100),
  ]);

  return {
    pairs: pairsMessages,
    reviews: reviewMessages,
  };
};

export const handleMessageRedaction = async (roomId, event) => {
  if (roomId !== config.matrix.roomId) return;

  const redactedEventId =
    event.redacts || event.content?.redacts || event.content?.redacts?.[0];

  if (!redactedEventId) return;

  const result = await handleReviewMessageDeleted(redactedEventId);
  if (result?.deleted) {
    emitRoomMessageDeleted(redactedEventId);
    console.log(`[room] Message removed from dashboard: ${redactedEventId}`);
  }
};

export const getMemberRoomMessages = (roomId, limit = 20) =>
  RoomMessage.find({ roomId }).sort({ sentAt: -1 }).limit(limit);

const decryptPromptSent = new Set();
let matrixListenerRegistered = false;
let mainRoomReconcileTimer = null;

const scheduleMainRoomReconcile = (client) => {
  if (mainRoomReconcileTimer) return;
  mainRoomReconcileTimer = setTimeout(async () => {
    mainRoomReconcileTimer = null;
    try {
      await reconcileMainRoomReviews(client, { limit: 50 });
    } catch (error) {
      console.warn(`[room] Scheduled reconcile failed: ${error.message}`);
    }
  }, 2500);
  if (typeof mainRoomReconcileTimer.unref === 'function') {
    mainRoomReconcileTimer.unref();
  }
};

/**
 * Pull recent personal-room timeline events and feed any missed member replies
 * into the same handler as live room.message (lead YES, discussion YES/NO, etc.).
 */
export const reconcilePendingMemberReplies = async (client) => {
  if (!client) return { checked: 0, processed: 0 };

  const LeadReportSession = (await import('../models/LeadReportSession.js')).default;
  const DiscussionPrompt = (await import('../models/DiscussionPrompt.js')).default;

  const [leadSessions, discussionPrompts] = await Promise.all([
    LeadReportSession.find({
      stage: {
        $in: [
          'awaiting_ready',
          'awaiting_verify',
          'awaiting_momin_check',
          'awaiting_pair_choice',
          'awaiting_forgot_reason',
        ],
      },
    })
      .select('lead roomId reportSentAt stage dateKey')
      .lean(),
    DiscussionPrompt.find({ status: 'pending' })
      .select('member roomId sentAt status reviewDateKey')
      .lean(),
  ]);

  const targets = new Map();
  for (const session of leadSessions) {
    if (!session.roomId) continue;
    targets.set(session.roomId, {
      roomId: session.roomId,
      member: session.lead,
      since: session.reportSentAt ? new Date(session.reportSentAt).getTime() : 0,
      kind: 'lead',
    });
  }
  for (const prompt of discussionPrompts) {
    if (!prompt.roomId) continue;
    const since = prompt.sentAt ? new Date(prompt.sentAt).getTime() : 0;
    const existing = targets.get(prompt.roomId);
    if (!existing || since < existing.since) {
      targets.set(prompt.roomId, {
        roomId: prompt.roomId,
        member: prompt.member,
        since,
        kind: existing ? 'both' : 'discussion',
      });
    }
  }

  if (!targets.size) return { checked: 0, processed: 0 };

  const botUserId = await client.getUserId();
  let processed = 0;

  for (const target of targets.values()) {
    try {
      const res = await client.doRequest(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/messages`,
        { dir: 'b', limit: 30 }
      );

      const chunk = [...(res?.chunk || [])].reverse();
      for (const raw of chunk) {
        let event = raw;
        const ts = Number(event.origin_server_ts || 0);
        if (target.since && ts && ts < target.since - 5_000) continue;
        if (event.sender && botUserId && event.sender === botUserId) continue;

        if (event.type === 'm.room.encrypted' && client.crypto) {
          try {
            const { EncryptedRoomEvent } = await import(
              'matrix-bot-sdk/lib/models/events/EncryptedRoomEvent.js'
            );
            event = (
              await client.crypto.decryptRoomEvent(
                new EncryptedRoomEvent(event),
                target.roomId
              )
            ).raw;
          } catch (error) {
            console.warn(
              `[member-room] Reconcile decrypt failed ${target.roomId}: ${error.message}`
            );
            continue;
          }
        }

        if (event?.type !== 'm.room.message') continue;
        const body = (event.content?.body || '').trim();
        if (!body || !event.event_id) continue;
        if (seenEvents.has(event.event_id)) continue;

        const already = await RoomMessage.exists({ eventId: event.event_id });
        if (already) {
          seenEvents.add(event.event_id);
          continue;
        }

        console.log(
          `[member-room] Reconcile processing ${target.member} "${body.slice(0, 40)}" (${target.kind})`
        );
        await handleIncomingMatrixMessage(target.roomId, event, botUserId);
        processed += 1;
      }
    } catch (error) {
      console.warn(
        `[member-room] Reconcile failed for ${target.member}: ${error.message}`
      );
    }
  }

  if (processed) {
    console.log(`[member-room] Reconcile processed ${processed} missed reply(ies)`);
  }
  return { checked: targets.size, processed };
};

/**
 * Backfill missed main-room messages (decrypt lag / sync gaps).
 * Without this, a review can appear in Element but never hit Mongo / attendance.
 */
export const reconcileMainRoomReviews = async (client, { limit = 60 } = {}) => {
  if (!client) return { checked: 0, processed: 0 };
  const roomId = config.matrix.roomId;
  if (!roomId) return { checked: 0, processed: 0 };

  const botUserId = await client.getUserId();
  let processed = 0;

  try {
    const res = await client.doRequest(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { dir: 'b', limit: Math.min(Number(limit) || 60, 100) }
    );

    const chunk = [...(res?.chunk || [])].reverse();
    for (const raw of chunk) {
      let event = raw;

      if (event.type === 'm.room.encrypted' && client.crypto) {
        try {
          const { EncryptedRoomEvent } = await import(
            'matrix-bot-sdk/lib/models/events/EncryptedRoomEvent.js'
          );
          event = (
            await client.crypto.decryptRoomEvent(
              new EncryptedRoomEvent(event),
              roomId
            )
          ).raw;
        } catch (error) {
          console.warn(
            `[room] Main reconcile decrypt failed: ${error.message}`
          );
          continue;
        }
      }

      if (event?.type !== 'm.room.message') continue;
      if (event.sender && botUserId && event.sender === botUserId) continue;
      const body = getEffectiveBody(event.content || {});
      if (!body || !event.event_id) continue;
      if (seenEvents.has(event.event_id)) continue;

      const already = await RoomMessage.exists({ eventId: event.event_id });
      if (already) {
        seenEvents.add(event.event_id);
        continue;
      }

      console.log(
        `[room] Main reconcile ingesting ${event.sender} "${body.slice(0, 48)}"`
      );
      await handleIncomingMatrixMessage(roomId, event, botUserId);
      processed += 1;
    }
  } catch (error) {
    console.warn(`[room] Main reconcile failed: ${error.message}`);
  }

  if (processed) {
    console.log(`[room] Main reconcile processed ${processed} missed message(s)`);
  }
  return { checked: 1, processed };
};

export const registerMatrixRoomListener = async (client) => {
  if (matrixListenerRegistered) {
    console.log('Matrix room message listener already active');
    return;
  }
  matrixListenerRegistered = true;

  const botUserId = await client.getUserId();

  client.on('room.invite', async (roomId) => {
    try {
      if (roomId === config.matrix.roomId || isMemberRoom(roomId)) {
        await client.joinRoom(roomId);
        console.log(`[matrix] Joined invited room ${roomId}`);
      }
    } catch (error) {
      console.warn(`[matrix] Auto-join failed for ${roomId}: ${error.message}`);
    }
  });

  client.on('room.message', async (roomId, event) => {
    try {
      await handleIncomingMatrixMessage(roomId, event, botUserId);
    } catch (error) {
      console.error('room.message handler error:', error.message);
    }
  });

  // Late decryption (keys arrived after first attempt) — treat like a normal message.
  client.on('room.decrypted_event', async (roomId, event) => {
    try {
      if (event?.type !== 'm.room.message') return;
      await handleIncomingMatrixMessage(roomId, event, botUserId);
    } catch (error) {
      console.error('room.decrypted_event handler error:', error.message);
    }
  });

  client.on('room.failed_decryption', async (roomId, event, err) => {
    try {
      console.warn(
        `[matrix] Failed to decrypt in ${roomId}: ${err?.message || err}`
      );

      // Main Pair Reviews: retry via timeline reconcile (reviews land here).
      if (roomId === config.matrix.roomId) {
        scheduleMainRoomReconcile(client);
        return;
      }

      if (!isMemberRoom(roomId)) return;

      const member = getMemberForRoomId(roomId);
      if (!member) return;

      const { getActiveLeadSessionForMember } = await import('./leadReportService.js');
      const activeLead = await getActiveLeadSessionForMember(member);
      const DiscussionPrompt = (await import('../models/DiscussionPrompt.js')).default;
      const awaitingDiscussion = await DiscussionPrompt.exists({
        member,
        status: 'pending',
      });

      if (!activeLead && !awaitingDiscussion) return;

      const key = `${roomId}:decrypt-prompt`;
      if (decryptPromptSent.has(key)) return;
      decryptPromptSent.add(key);
      setTimeout(() => decryptPromptSent.delete(key), 10 * 60 * 1000);

      const hint =
        'I could not read your last message (encryption). Please send your reply again as plain text (e.g. YES).';
      const sent = await sendMatrixMessageToRoom(roomId, hint, {
        kind: 'decrypt_retry_prompt',
        member,
        dateKey: activeLead?.dateKey || null,
      });
      await logMemberRoomMessage({
        member,
        roomId,
        body: hint,
        eventId: sent.event_id,
        category: 'bot_dm_ack',
        dateKey: activeLead?.dateKey || null,
      });
    } catch (error) {
      console.error('room.failed_decryption handler error:', error.message);
    }
  });

  client.on('room.event', async (roomId, event) => {
    try {
      if (event?.type === 'm.room.redaction') {
        await handleMessageRedaction(roomId, event);
      }
    } catch (error) {
      console.error('room.event handler error:', error.message);
    }
  });

  console.log('Matrix room message listener active');
};
