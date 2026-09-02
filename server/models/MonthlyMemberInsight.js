import mongoose from 'mongoose';

/**
 * Parsed review insight per member per day.
 * Each document captures the suggestions / concerns / issues
 * extracted from a pair review for a single team member.
 */
const insightItemSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['suggestion', 'concern', 'issue'],
      required: true,
    },
    text: { type: String, required: true },
    rawSender: String,
  },
  { _id: false }
);

const monthlyMemberInsightSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true },
    monthKey: { type: String, required: true },
    member: { type: String, required: true },
    pairLabel: String,
    pairType: {
      type: String,
      enum: ['developer', 'qa'],
      default: 'developer',
    },
    items: { type: [insightItemSchema], default: [] },
    emptyReview: { type: Boolean, default: false },
    processedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

monthlyMemberInsightSchema.index({ dateKey: 1, member: 1 }, { unique: true });
monthlyMemberInsightSchema.index({ monthKey: 1 });
monthlyMemberInsightSchema.index({ monthKey: 1, member: 1 });

const MonthlyMemberInsight = mongoose.model(
  'MonthlyMemberInsight',
  monthlyMemberInsightSchema
);

export default MonthlyMemberInsight;
