import mongoose from 'mongoose';

/**
 * 5 PM ask: was yesterday's pair review discussed in today's meeting?
 * One prompt per pair per reviewDateKey, sent to a rotating member.
 */
const discussionPromptSchema = new mongoose.Schema(
  {
    /** Calendar day the pair review belongs to ("kal"). */
    reviewDateKey: { type: String, required: true },
    /** Calendar day we asked (meeting day / send day). */
    meetingDateKey: { type: String, required: true },
    pair: { type: [String], required: true },
    pairKey: { type: String, required: true },
    member: { type: String, required: true },
    roomId: String,
    reviewBody: String,
    message: String,
    eventId: String,
    status: {
      type: String,
      enum: ['pending', 'answered', 'failed', 'skipped'],
      default: 'pending',
    },
    response: {
      answer: { type: String, enum: ['yes', 'no', null], default: null },
      body: String,
      eventId: String,
      respondedAt: Date,
    },
    sendError: String,
    sentAt: Date,
  },
  { timestamps: true }
);

discussionPromptSchema.index(
  { reviewDateKey: 1, pairKey: 1 },
  { unique: true }
);
discussionPromptSchema.index({ meetingDateKey: 1, status: 1 });
discussionPromptSchema.index({ member: 1, status: 1, sentAt: -1 });
discussionPromptSchema.index({ roomId: 1, status: 1, sentAt: -1 });

const DiscussionPrompt = mongoose.model('DiscussionPrompt', discussionPromptSchema);

export default DiscussionPrompt;
