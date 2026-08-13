import mongoose from 'mongoose';

const roomMessageSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    dateKey: String,
    roomId: String,
    senderId: String,
    senderName: String,
    body: String,
    direction: { type: String, enum: ['in', 'out'], default: 'in' },
    category: {
      type: String,
      enum: [
        'team_review',
        'bot_pairs',
        'bot_reminder',
        'bot_missed',
        'bot_wrong_pair',
        'bot_duplicate',
        'bot_boss',
        'bot_dm_prompt',
        'bot_dm_ack',
        'member_dm_reply',
        'bot_other',
      ],
      default: 'team_review',
    },
    /** Set for messages inside a member's personal follow-up room. */
    memberName: String,
    messageType: String,
    sentAt: { type: Date, default: Date.now },
    countsAsReview: { type: Boolean, default: false },
    matchedPair: [String],
    pairKey: String,
    reviewIssue: {
      type: String,
      enum: ['wrong_pair', 'duplicate_pair'],
      default: null,
    },
    attemptedPair: [String],
    alertTriggeredBy: String,
    alertTriggeredById: String,
    relatedEventId: String,
    deletedAt: Date,
  },
  { timestamps: true }
);

roomMessageSchema.index({ dateKey: 1, sentAt: -1 });
roomMessageSchema.index({ category: 1, sentAt: -1 });
roomMessageSchema.index({ sentAt: -1 });
roomMessageSchema.index({ dateKey: 1, pairKey: 1, countsAsReview: 1 });
roomMessageSchema.index({ roomId: 1, sentAt: -1 });
roomMessageSchema.index({ memberName: 1, sentAt: -1 });

const RoomMessage = mongoose.model('RoomMessage', roomMessageSchema);

export default RoomMessage;
