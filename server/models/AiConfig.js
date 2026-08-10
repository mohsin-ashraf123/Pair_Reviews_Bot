import mongoose from 'mongoose';

/** Singleton AI provider config (OpenRouter, etc.). */
const aiConfigSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    provider: { type: String, default: 'openrouter' },
    apiKey: { type: String, default: '' },
    modelId: { type: String, default: '' },
    modelName: { type: String, default: '' },
  },
  { timestamps: true }
);

const AiConfig = mongoose.model('AiConfig', aiConfigSchema);

export default AiConfig;
