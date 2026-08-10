import AiConfig from '../models/AiConfig.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const maskApiKey = (key) => {
  if (!key) return '';
  const k = String(key).trim();
  if (k.length <= 10) return '••••••••';
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
};

const isFreeModel = (model) => {
  if (!model) return false;
  if (String(model.id || '').endsWith(':free')) return true;
  const prompt = Number(model.pricing?.prompt);
  const completion = Number(model.pricing?.completion);
  return (
    Number.isFinite(prompt) &&
    Number.isFinite(completion) &&
    prompt === 0 &&
    completion === 0
  );
};

const normalizeModel = (model) => ({
  id: model.id,
  name: model.name || model.id,
  contextLength: model.context_length || null,
  free: isFreeModel(model),
  pricing: {
    prompt: model.pricing?.prompt ?? null,
    completion: model.pricing?.completion ?? null,
  },
});

export const getAiConfigDoc = async () => {
  let doc = await AiConfig.findOne({ key: 'default' });
  if (!doc) {
    doc = await AiConfig.create({
      key: 'default',
      provider: 'openrouter',
      apiKey: (process.env.OPENROUTER_API_KEY || '').trim(),
      modelId: (process.env.OPENROUTER_MODEL || '').trim(),
      modelName: '',
    });
  }
  return doc;
};

/** Resolved key: DB first, then env fallback. */
export const resolveApiKey = async () => {
  const doc = await getAiConfigDoc();
  const fromDb = (doc.apiKey || '').trim();
  if (fromDb) return fromDb;
  return (process.env.OPENROUTER_API_KEY || '').trim();
};

export const getAiSettingsPublic = async () => {
  const doc = await getAiConfigDoc();
  const apiKey = await resolveApiKey();
  return {
    provider: doc.provider || 'openrouter',
    configured: Boolean(apiKey),
    apiKeyMasked: maskApiKey(apiKey),
    modelId: doc.modelId || '',
    modelName: doc.modelName || '',
    updatedAt: doc.updatedAt || null,
  };
};

export const saveAiSettings = async ({ apiKey, modelId, modelName, clearKey } = {}) => {
  const doc = await getAiConfigDoc();

  if (clearKey) {
    doc.apiKey = '';
  } else if (typeof apiKey === 'string' && apiKey.trim()) {
    doc.apiKey = apiKey.trim();
  }

  if (typeof modelId === 'string') {
    doc.modelId = modelId.trim();
  }
  if (typeof modelName === 'string') {
    doc.modelName = modelName.trim();
  }

  await doc.save();
  return getAiSettingsPublic();
};

export const fetchOpenRouterModels = async (apiKeyOverride) => {
  const apiKey = (apiKeyOverride || (await resolveApiKey()) || '').trim();
  if (!apiKey) {
    const err = new Error('OpenRouter API key is not configured');
    err.status = 400;
    throw err;
  }

  const res = await fetch(`${OPENROUTER_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    const err = new Error(
      detail || `OpenRouter models request failed (${res.status})`
    );
    err.status = res.status === 401 ? 401 : 502;
    throw err;
  }

  const body = await res.json();
  const models = (body?.data || [])
    .map(normalizeModel)
    .filter((m) => m.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    models,
    total: models.length,
    freeCount: models.filter((m) => m.free).length,
  };
};

/**
 * Chat completion helper for later use-cases.
 * Not wired to UI yet — ready when you pick a purpose.
 */
export const chatCompletion = async ({ messages, model, temperature = 0.3 }) => {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    const err = new Error('OpenRouter API key is not configured');
    err.status = 400;
    throw err;
  }

  const doc = await getAiConfigDoc();
  const modelId = (model || doc.modelId || '').trim();
  if (!modelId) {
    const err = new Error('No AI model selected');
    err.status = 400;
    throw err;
  }

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      messages,
      temperature,
    }),
  });

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || body?.message || '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    const err = new Error(detail || `OpenRouter chat failed (${res.status})`);
    err.status = res.status >= 400 && res.status < 500 ? res.status : 502;
    throw err;
  }

  return res.json();
};
