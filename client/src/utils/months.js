export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function buildMonthOptions(centerYear) {
  const options = [];
  for (let y = centerYear - 1; y <= centerYear + 1; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      options.push({
        value: `${y}-${m}`,
        label: `${MONTH_NAMES[m - 1]} ${y}`,
      });
    }
  }
  return options;
}

export function todayDateKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
