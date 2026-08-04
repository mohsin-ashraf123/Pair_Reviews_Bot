import DailyPairRecord from '../models/DailyPairRecord.js';
import MessageLog from '../models/MessageLog.js';

export const savePairRecord = async ({
  dateKey,
  pairsData,
  message,
  matrixEventId,
  triggeredBy,
}) => {
  return DailyPairRecord.findOneAndUpdate(
    { dateKey },
    {
      dateKey,
      lead: pairsData.lead,
      developerPairs: pairsData.developerPairs,
      qaPair: pairsData.qaPair,
      allPairs: pairsData.allPairs,
      message,
      matrixEventId: matrixEventId || null,
      sentAt: new Date(),
      triggeredBy,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

export const getLastPairRecord = () =>
  DailyPairRecord.findOne().sort({ sentAt: -1 });

export const getPairRecordByDate = (dateKey) =>
  DailyPairRecord.findOne({ dateKey });

export const getPairRecords = (limit = 50) =>
  DailyPairRecord.find().sort({ sentAt: -1 }).limit(limit);

/** Prefer DailyPairRecord; fall back to legacy MessageLog for older data. */
export const getPairHistory = async (limit = 50) => {
  const records = await getPairRecords(limit);
  if (records.length >= limit) return records;

  const existingKeys = new Set(records.map((r) => r.dateKey));
  const legacy = await MessageLog.find()
    .sort({ sentAt: -1 })
    .limit(limit);

  const merged = [...records];
  for (const log of legacy) {
    if (merged.length >= limit) break;
    if (existingKeys.has(log.dateKey)) continue;
    merged.push({
      _id: log._id,
      dateKey: log.dateKey,
      lead: log.lead,
      allPairs: log.pairs,
      message: log.message,
      sentAt: log.sentAt,
      triggeredBy: log.triggeredBy,
      legacy: true,
    });
  }

  return merged.sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, limit);
};
