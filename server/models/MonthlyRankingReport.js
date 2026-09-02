import mongoose from 'mongoose';

/**
 * Final monthly ranking report — generated on the last working day.
 * Contains calculated scores, one-liner summaries, and the Element message.
 */
const memberRankingSchema = new mongoose.Schema(
  {
    member: { type: String, required: true },
    rank: Number,
    score: Number,
    oneLiner: String,
    stats: {
      totalReviews: { type: Number, default: 0 },
      emptyReviews: { type: Number, default: 0 },
      suggestions: { type: Number, default: 0 },
      concerns: { type: Number, default: 0 },
      issues: { type: Number, default: 0 },
      presentDays: { type: Number, default: 0 },
      absentDays: { type: Number, default: 0 },
      halfDays: { type: Number, default: 0 },
      forgotDays: { type: Number, default: 0 },
      excusedDays: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

const monthlyRankingReportSchema = new mongoose.Schema(
  {
    monthKey: { type: String, required: true, unique: true },
    generatedAt: Date,
    sentAt: Date,
    eventId: String,
    roomId: String,
    modelId: String,
    modelName: String,
    rankings: { type: [memberRankingSchema], default: [] },
    reportText: { type: String, default: '' },
    status: {
      type: String,
      enum: ['generating', 'ready', 'sent', 'failed'],
      default: 'generating',
    },
    error: String,
  },
  { timestamps: true }
);

const MonthlyRankingReport = mongoose.model(
  'MonthlyRankingReport',
  monthlyRankingReportSchema
);

export default MonthlyRankingReport;
