export const isValidDateKey = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
export const validateMonth = (year, month) => {
  if (!Number.isInteger(year) || year < 1970 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error('Invalid year or month');
  }
};
export const previousMonthKey = dateKey => {
  const [year, month] = dateKey.split('-').map(Number);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
};
