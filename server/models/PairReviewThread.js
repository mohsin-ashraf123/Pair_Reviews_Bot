import mongoose from 'mongoose';

const threadReplySchema = new mongoose.Schema(
  {
    pair: [String],
    pairKey: String,
    pairLabel: String,
    reviewEventId: String,
    threadEventId: String,
    senderName: String,
    body: String,
    skipped: { type: Boolean, default: false },
    skipReason: String,
  },
  { _id: false }
);

/**
 * Morning digest: yesterday's pair reviews posted as Element thread replies
 * under that day's "Pairs Today" root message.
 */
const pairReviewThreadSchema = new mongoose.Schema(
  {
    /** Review / pairs day being summarized. */
    reviewDateKey: { type: String, required: true, unique: true },
    /** Calendar day we posted the thread (usually next working morning). */
    sendDateKey: String,
    roomId: String,
    rootEventId: String,
    rootBody: String,
    status: {
      type: String,
      enum: ['pending', 'sent', 'skipped', 'failed'],
      default: 'pending',
    },
    skipReason: String,
    error: String,
    replies: { type: [threadReplySchema], default: [] },
    postedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    sentAt: Date,
  },
  { timestamps: true }
);

pairReviewThreadSchema.index({ sendDateKey: -1 });
pairReviewThreadSchema.index({ sentAt: -1 });

const PairReviewThread = mongoose.model('PairReviewThread', pairReviewThreadSchema);

export default PairReviewThread;
