// Screenshot-confirmed review; Matrix timeline independently confirms sender/time/event ID.
// Dry run by default. Run with --apply to repair attendance without sending messages.
import fs from 'node:fs/promises';
import mongoose from 'mongoose';
import { config } from '../config/appConfig.js';
import DailyReview from '../models/DailyReview.js';
import RoomMessage from '../models/RoomMessage.js';
import LeadReportSession from '../models/LeadReportSession.js';
import { recordReviewFromMessage, getPendingPairs, buildPairKey } from '../services/reviewService.js';

const dateKey = '2026-09-25';
const pair = ['Uzair', 'Mohsin'];
const eventId = '$zdW9aN7ez5UbdGOEvKgx6Q4gvvDUpHQcv-8HZVPdhyI';
try {
  await mongoose.connect(process.env.MONGO_URI);
  const review = await DailyReview.findOne({ dateKey });
  const session = await LeadReportSession.findOne({ dateKey });
  const message = await RoomMessage.findOne({ eventId });
  if (!review?.pairs.some(p => buildPairKey(p) === buildPairKey(pair))) {
    throw new Error('Expected assigned pair not found; refusing repair');
  }
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ dateKey, reviewedMembers: review.reviewedMembers, pendingPairs: session?.pendingPairs, eventStored: !!message }));
  } else {
    const backupDir = new URL('../data/repairs/', import.meta.url);
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(new URL(`sep25-${Date.now()}.json`, backupDir), JSON.stringify({ review, session, message }, null, 2));
    await RoomMessage.updateOne({ eventId }, { $setOnInsert: {
      dateKey, roomId: config.matrix.roomId, senderId: '@mohsinashraf:matrix.org',
      senderName: 'Mohsin', direction: 'in', category: 'team_review', messageType: 'm.text',
      body: 'Uzair + Mohsin:\nReview completed. No issues, concerns, or improvement recommendations identified',
      sentAt: new Date('2026-09-25T14:20:13.807Z'),
    } }, { upsert: true });
    const result = await recordReviewFromMessage(
      (await RoomMessage.findOne({ eventId })).body, dateKey, eventId);
    if (result.status !== 'success') throw new Error(`Unexpected result: ${result.status}`);
    const updated = await DailyReview.findOne({ dateKey });
    if (!pair.every(m => updated.reviewedMembers.includes(m))) throw new Error('Attendance verification failed');
    if (session) {
      const wasPending = session.pendingPairs.some(p => buildPairKey(p) === buildPairKey(pair));
      session.pendingPairs = getPendingPairs(updated.pairs, updated);
      if (!session.submittedPairs.some(p => buildPairKey(p) === buildPairKey(pair))) session.submittedPairs.push(pair);
      if (wasPending && ['awaiting_pair_choice', 'awaiting_forgot_reason'].includes(session.stage)) {
        // Discard the stale missing-review options; retain already verified pairs.
        session.stage = 'awaiting_verify';
        session.currentVerifyIndex = session.submittedPairs.findIndex(p => buildPairKey(p) === buildPairKey(pair));
        session.currentPairIndex = 0;
        session.currentPairOptions = [];
        session.pendingForgotOption = undefined;
        session.pendingVerify = undefined;
      }
      await session.save();
    }
    console.log(JSON.stringify({ dateKey, reviewedMembers: updated.reviewedMembers, pendingPairs: session?.pendingPairs, stage: session?.stage }));
  }
} finally {
  await mongoose.disconnect();
}
