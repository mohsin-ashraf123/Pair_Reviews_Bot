import connectDB from './config/db.js';
import mongoose from 'mongoose';

async function run() {
  await connectDB();
  const sep1 = new Date('2026-09-01T00:00:00.000Z');
  
  const models = [
    'DailyReview',
    'RoomMessage',
    'MissingReviewPrompt',
    'LeadReportSession',
    'PairThreadDraft',
    'DiscussionPrompt',
    'MonthlyMemberInsight',
    'MonthlyRankingReport'
  ];

  for (const modelName of models) {
    try {
      const { default: Model } = await import(`./models/${modelName}.js`);
      let result;
      if (modelName === 'RoomMessage') {
        result = await Model.deleteMany({ sentAt: { $lt: sep1 } });
      } else if (modelName === 'DailyReview' || modelName === 'MissingReviewPrompt' || modelName === 'LeadReportSession' || modelName === 'PairThreadDraft' || modelName === 'DiscussionPrompt') {
        result = await Model.deleteMany({ dateKey: { $lt: '2026-09-01' } });
      } else if (modelName === 'MonthlyMemberInsight' || modelName === 'MonthlyRankingReport') {
        result = await Model.deleteMany({ monthKey: { $lt: '2026-09' } });
      }
      console.log(`Deleted ${result?.deletedCount || 0} from ${modelName}`);
    } catch (e) {
      console.log(`Error deleting from ${modelName}: ${e.message}`);
    }
  }
  
  process.exit(0);
}

run();
