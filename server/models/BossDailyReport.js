import mongoose from 'mongoose';

/** Prepared AI Sir report — ready at 5:58 PM, sent at 6:00 PM (weekdays). */
const bossDailyReportSchema = new mongoose.Schema(
  {
    /** Review day the report covers (previous working day at send time). */
    reviewDateKey: { type: String, required: true, unique: true },
    /** Calendar day we prepare/send (usually today). */
    sendDateKey: { type: String, required: true },
    brief: { type: String, default: '' },
    modelId: String,
    modelName: String,
    status: {
      type: String,
      enum: ['preparing', 'ready', 'sent', 'failed'],
      default: 'preparing',
    },
    prepareError: String,
    sendError: String,
    roomId: String,
    eventId: String,
    preparedAt: Date,
    sentAt: Date,
  },
  { timestamps: true }
);

bossDailyReportSchema.index({ sendDateKey: 1 });

const BossDailyReport = mongoose.model('BossDailyReport', bossDailyReportSchema);

export default BossDailyReport;
