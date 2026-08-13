/**
 * Shared YES/NO parsing for lead reports + meeting checks.
 * Tolerates common typos (e.g. "Yse", "Yess") so members are not stuck.
 */

const YES_WORDS = new Set([
  'y',
  'yes',
  'yeah',
  'yep',
  'yup',
  'yse',
  'yas',
  'yess',
  'yeas',
  'yea',
  'ye',
  'haan',
  'han',
  'ha',
  'ok',
  'okay',
  'ready',
  'ji',
]);

const NO_WORDS = new Set([
  'n',
  'no',
  'nah',
  'nope',
  'nahi',
  'nai',
  'na',
]);

const firstToken = (body) => {
  const raw = String(body || '')
    .trim()
    .split(/\s+/)[0] || '';
  return raw.toLowerCase().replace(/[^a-z]/g, '');
};

const editDistance = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = temp;
    }
  }
  return prev[b.length];
};

/** @returns {'yes'|'no'|null} */
export const parseYesNo = (body) => {
  const token = firstToken(body);
  if (!token) return null;

  if (YES_WORDS.has(token)) return 'yes';
  if (NO_WORDS.has(token)) return 'no';

  // 1-edit typos of yes/no (covers Yse, Yse., yes!, etc.)
  if (token.length >= 2 && token.length <= 4 && editDistance(token, 'yes') <= 1) {
    return 'yes';
  }
  if (token.length >= 2 && token.length <= 3 && editDistance(token, 'no') <= 1) {
    return 'no';
  }

  return null;
};
