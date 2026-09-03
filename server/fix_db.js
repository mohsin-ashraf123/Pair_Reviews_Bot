import mongoose from 'mongoose';
import { config } from 'dotenv';
import MonthlyRankingReport from './models/MonthlyRankingReport.js';

config();

mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI).then(async () => {
  await MonthlyRankingReport.updateMany({status: 'scheduled'}, {$set: {status: 'draft'}});
  console.log('Fixed');
  process.exit(0);
});
