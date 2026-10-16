import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  dateKey: { type: String, required: true, unique: true },
  sourceHash: { type: String, required: true },
  processedAt: { type: Date, default: Date.now },
});

export default mongoose.model('InsightProcessingState', schema);
