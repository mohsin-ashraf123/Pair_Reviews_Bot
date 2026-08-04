import mongoose from 'mongoose';

const dailyPairRecordSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true },
    lead: String,
    developerPairs: [[String]],
    qaPair: [String],
    allPairs: [[String]],
    message: { type: String, required: true },
    matrixEventId: String,
    sentAt: { type: Date, default: Date.now },
    triggeredBy: { type: String, enum: ['cron', 'manual'], default: 'cron' },
  },
  { timestamps: true }
);

dailyPairRecordSchema.index({ sentAt: -1 });

const DailyPairRecord = mongoose.model('DailyPairRecord', dailyPairRecordSchema);

export default DailyPairRecord;
