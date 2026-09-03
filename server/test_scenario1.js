import mongoose from 'mongoose';
import { config } from 'dotenv';
import { startLeadMorningReport } from './services/leadReportService.js';
import DailyReview from './models/DailyReview.js';
import { getKarachiDateKey } from './services/pairService.js';

config();
process.env.MATRIX_RUN_BOT = 'true';

mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI).then(async () => {
  try {
    const dateKey = getKarachiDateKey(); 
    
    // Create fake review
    let review = await DailyReview.findOne({ dateKey });
    if (!review) {
      review = new DailyReview({ dateKey });
    }
    
    review.lead = 'Mohsin';
    review.pairs = [['Mohsin', 'Adil', 'Aqeel']];
    review.pairsSentAt = new Date();
    // Simulate Mohsin and Adil submitting, leaving Aqeel missing
    review.reviewedMembers = ['Mohsin', 'Adil'];
    await review.save();

    console.log('Triggering lead morning report for Mohsin...');
    const result = await startLeadMorningReport(dateKey, { leadOverride: 'Mohsin', force: true });
    console.log('Result:', result);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
});
