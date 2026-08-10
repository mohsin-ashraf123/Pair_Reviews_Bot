import mongoose from 'mongoose';

/**
 * Persistent log when the bot attempted to send a Matrix message but failed.
 * Shown in dashboard History as send-failure entries.
 */
const botSendFailureSchema = new mongoose.Schema(
  {
    dateKey: { type: String, index: true },
    kind: {
      type: String,
      default: 'message',
      index: true,
    },
    roomId: String,
    member: String,
    body: String,
    error: { type: String, required: true },
    triggeredBy: String,
    failedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

botSendFailureSchema.index({ failedAt: -1 });

const BotSendFailure = mongoose.model('BotSendFailure', botSendFailureSchema);

export default BotSendFailure;
