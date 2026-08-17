import Holiday from '../models/Holiday.js';

/** In-memory set so working-day helpers stay sync (same as weekends). */
let holidaySet = new Set();
let cacheReady = false;

export const refreshHolidayCache = async () => {
  const rows = await Holiday.find({}).select('dateKey').lean();
  holidaySet = new Set(rows.map((r) => r.dateKey).filter(Boolean));
  cacheReady = true;
  return holidaySet.size;
};

export const ensureHolidayCache = async () => {
  if (!cacheReady) await refreshHolidayCache();
};

export const isHoliday = (dateKey) => {
  if (!dateKey) return false;
  return holidaySet.has(dateKey);
};

export const listHolidayDateKeys = (year, month) => {
  const prefix = `${year}-${String(month).padStart(2, '0')}-`;
  return [...holidaySet].filter((key) => key.startsWith(prefix)).sort();
};

export const setHoliday = async (dateKey, holiday = true, label = 'Holiday') => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) {
    throw new Error('dateKey must be YYYY-MM-DD');
  }

  if (holiday) {
    await Holiday.findOneAndUpdate(
      { dateKey },
      { $set: { dateKey, label: label || 'Holiday' } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
  } else {
    await Holiday.deleteOne({ dateKey });
  }

  await refreshHolidayCache();
  return { dateKey, holiday: Boolean(holiday), label: holiday ? label || 'Holiday' : null };
};

export const getHolidaysInRange = async (fromKey, toKey) => {
  await ensureHolidayCache();
  return Holiday.find({
    dateKey: { $gte: fromKey, $lte: toKey },
  })
    .sort({ dateKey: 1 })
    .lean();
};
