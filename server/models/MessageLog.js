import mongoose from 'mongoose';

const messageLogSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true },
    message: { type: String, required: true },
    lead: String,
    pairs: [[String]],
    sentAt: { type: Date, default: Date.now },
    triggeredBy: { type: String, enum: ['cron', 'manual'], default: 'cron' },
  },
  { timestamps: true }
);

const MessageLog = mongoose.model('MessageLog', messageLogSchema);

export default MessageLog;
