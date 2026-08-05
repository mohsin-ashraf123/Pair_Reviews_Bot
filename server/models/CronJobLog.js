import mongoose from 'mongoose';

const cronJobLogSchema = new mongoose.Schema(
  {
    jobKey: { type: String, required: true, unique: true },
    jobType: String,
    dateKey: String,
    matrixEventId: String,
    claimedAt: { type: Date, default: Date.now },
    completedAt: Date,
    status: {
      type: String,
      enum: ['claimed', 'completed', 'failed'],
      default: 'claimed',
    },
  },
  { timestamps: true }
);

const CronJobLog = mongoose.model('CronJobLog', cronJobLogSchema);

export default CronJobLog;
