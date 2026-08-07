import mongoose from 'mongoose';

const dailyReviewSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true },
    lead: String,
    pairs: [[String]],
    reviewedMembers: { type: [String], default: [] },
    /** Confirmed absent through a member's follow-up reply. */
    absentMembers: { type: [String], default: [] },
    /** Review happened but the message was never posted — counts as present. */
    lateReviewedMembers: { type: [String], default: [] },
    /** Present, but could not review because a pair partner was absent. */
    excusedMembers: { type: [String], default: [] },
    /** On half day leave — tracked separately from a full absence. */
    halfDayMembers: { type: [String], default: [] },
    pairsSentAt: Date,
    reminderSentAt: Date,
    missedReviewNoticeSentAt: Date,
    missingReviewPromptsSentAt: Date,
  },
  { timestamps: true }
);

const DailyReview = mongoose.model('DailyReview', dailyReviewSchema);

export default DailyReview;
