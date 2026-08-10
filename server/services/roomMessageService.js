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
    const result = await sendMatrixMessage(message);
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

  const { handleMemberReply } = await import('./missingReviewPromptService.js');
  const result = await handleMemberReply(member, roomId, body, eventId);

  if (!result?.ack) return;

  try {
    const sent = await sendMatrixMessageToRoom(roomId, result.ack);
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

/** Messages from the last 24 hours for the live dashboard panel. */
export const getLiveRoomMessages = (limit = 50) => {
  const since = new Date(Date.now() - LIVE_WINDOW_MS);
  return RoomMessage.find({ sentAt: { $gte: since } })
    .sort({ sentAt: 1 })
    .limit(limit);
};

/** Team review messages older than 24h (archived). */
export const getArchivedReviewMessages = (limit = 100) => {
  const before = new Date(Date.now() - LIVE_WINDOW_MS);
  return RoomMessage.find({
    direction: 'in',
    category: 'team_review',
    sentAt: { $lt: before },
  })
    .sort({ sentAt: -1 })
    .limit(limit);
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

/** Recent messages for one member's personal room. */
export const getMemberRoomMessages = (roomId, limit = 20) =>
  RoomMessage.find({ roomId }).sort({ sentAt: -1 }).limit(limit);

export const registerMatrixRoomListener = async (client) => {
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
