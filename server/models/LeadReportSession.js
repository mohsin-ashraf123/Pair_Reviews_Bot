import mongoose from 'mongoose';

const pairDecisionSchema = new mongoose.Schema(
  {
    pair: [String],
    letter: String,
    label: String,
    type: String,
    absentMembers: [String],
    halfDayMembers: [String],
    forgotReason: String,
    decidedAt: Date,
  },
  { _id: false }
);

const verifyDecisionSchema = new mongoose.Schema(
  {
    pair: [String],
    verified: Boolean,
    /** Did Momin Sir do cross-pair testing / review logging for this pair? */
    mominCrossChecked: { type: Boolean, default: null },
    decidedAt: Date,
  },
  { _id: false }
);

const pairOptionSchema = new mongoose.Schema(
  {
    letter: { type: String },
    label: { type: String },
    type: { type: String },
    absentMembers: { type: [String], default: [] },
    halfDayMembers: { type: [String], default: [] },
  },
  { _id: false }
);

/**
 * One lead's personal-room conversation for a working day they were responsible for.
 * Same-day 6:50 nudge + next-morning 10:50 report live on this document.
 */
const leadReportSessionSchema = new mongoose.Schema(
  {
    /** The calendar day the lead was responsible for (pairs date). */
    dateKey: { type: String, required: true, unique: true },
    lead: { type: String, required: true },
    roomId: String,
    pairs: [[String]],
    submittedPairs: [[String]],
    pendingPairs: [[String]],

    reportSentAt: Date,
    reportEventId: String,

    /**
     * idle → awaiting_ready → awaiting_verify → awaiting_momin_check
     *   → awaiting_pair_choice → awaiting_forgot_reason → completed
     */
    stage: {
      type: String,
      enum: [
        'idle',
        'awaiting_ready',
        'awaiting_verify',
        'awaiting_momin_check',
        'awaiting_pair_choice',
        'awaiting_forgot_reason',
        'completed',
      ],
      default: 'idle',
    },

    /** Index into submittedPairs while verifying one-by-one. */
    currentVerifyIndex: { type: Number, default: 0 },
    verifyDecisions: { type: [verifyDecisionSchema], default: [] },
    /** After verify YES/NO, hold answer until Momin cross-pair check is answered. */
    pendingVerify: {
      pair: [String],
      verified: Boolean,
    },

    currentPairIndex: { type: Number, default: 0 },
    currentPairOptions: { type: [pairOptionSchema], default: [] },
    pendingForgotOption: { type: pairOptionSchema, default: undefined },

    /** True only if every submitted pair was verified YES. */
    reviewsVerified: { type: Boolean, default: null },
    pairDecisions: { type: [pairDecisionSchema], default: [] },
    lastError: String,
  },
  { timestamps: true }
);

leadReportSessionSchema.index({ lead: 1, stage: 1 });

const LeadReportSession = mongoose.model('LeadReportSession', leadReportSessionSchema);

export default LeadReportSession;
