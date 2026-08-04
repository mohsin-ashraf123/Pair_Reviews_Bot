import mongoose from 'mongoose';

const dailyReviewSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true },
    lead: String,
    pairs: [[String]],
    reviewedMembers: { type: [String], default: [] },
    pairsSentAt: Date,
    reminderSentAt: Date,
    missedReviewNoticeSentAt: Date,
  },
  { timestamps: true }
);

const DailyReview = mongoose.model('DailyReview', dailyReviewSchema);

export default DailyReview;
