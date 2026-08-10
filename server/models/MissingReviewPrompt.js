import mongoose from 'mongoose';

const optionSchema = new mongoose.Schema(
  {
    letter: String,
    label: String,
    /** partner_absent | self_absent | all_absent | half_day | forgot */
    type: String,
    /** members marked absent when this option is chosen */
    absentMembers: [String],
    /** members marked as half day leave when this option is chosen */
    halfDayMembers: [String],
  },
  { _id: false }
);

/** Declared as its own schema so the `type` field is not read as a SchemaType. */
const responseSchema = new mongoose.Schema(
  {
    letter: String,
    label: String,
    type: String,
    absentMembers: [String],
    halfDayMembers: [String],
    body: String,
    eventId: String,
    respondedAt: Date,
  },
  { _id: false }
);

/**
 * One DM sent to a single member because their pair review was missing
 * for `dateKey`, plus the option they replied with.
 */
const missingReviewPromptSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true },
    promptDateKey: String,
    member: { type: String, required: true },
    pair: [String],
    partners: [String],
    roomId: String,
    eventId: String,
    message: String,
    options: [optionSchema],
    status: {
      type: String,
      enum: ['pending', 'answered', 'failed', 'cancelled'],
      default: 'pending',
    },
    sendError: String,
    response: responseSchema,
    sentAt: Date,
  },
  { timestamps: true }
);

missingReviewPromptSchema.index({ dateKey: 1, member: 1 }, { unique: true });
missingReviewPromptSchema.index({ roomId: 1, status: 1, sentAt: -1 });

const MissingReviewPrompt = mongoose.model(
  'MissingReviewPrompt',
  missingReviewPromptSchema
);

export default MissingReviewPrompt;
