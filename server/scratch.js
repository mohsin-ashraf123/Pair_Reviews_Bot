import RoomMessage from './models/RoomMessage.js';
import connectDB from './config/db.js';

async function run() {
  await connectDB();
  const today = new Date('2026-09-03T00:00:00.000Z');
  const msgs = await RoomMessage.find({ sentAt: { $gte: today }, direction: 'out' }).sort({ sentAt: 1 }).lean();
  msgs.forEach(msg => {
    console.log('---');
    console.log('Time:', msg.sentAt);
    console.log('Category:', msg.category);
    console.log('Body:', msg.body);
  });
  process.exit(0);
}

run();
