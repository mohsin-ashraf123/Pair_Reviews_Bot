import mongoose from 'mongoose';
import { config } from 'dotenv';
config();

mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI).then(async () => {
  const { getKarachiDateKey } = await import('./services/pairService.js');
  const dateKey = getKarachiDateKey();
  
  // Clear the fake test data from today's real record
  const result = await mongoose.connection.collection('dailyreviews').updateOne(
    { dateKey },
    { $set: { reviewedMembers: [] } }
  );
  
  console.log('Fixed daily reviews for today:', result);
  
  // Also delete the fake test session for Mohsin
  const sessionResult = await mongoose.connection.collection('leadreportsessions').deleteMany({
    dateKey,
    lead: 'Mohsin',
    stage: { $in: ['awaiting_ready', 'awaiting_verify', 'awaiting_missing_member_reason'] }
  });
  console.log('Cleared test lead sessions:', sessionResult);

  process.exit(0);
});
