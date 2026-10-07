export const reportTimes = monthKey => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) throw new Error('Invalid report month');
  const [year, month] = monthKey.split('-').map(Number);
  return { generateAt: new Date(Date.UTC(year, month, 1, 5)), sendAt: new Date(Date.UTC(year, month, 1, 13)) };
};
export const validateRankingOutput = (parsed, members) => {
  if (!Array.isArray(parsed?.rankings) || parsed.rankings.length !== members.length
    || new Set(parsed.rankings.map(r => r.member)).size !== members.length
    || parsed.rankings.some(r => !members.includes(r.member) || !Number.isFinite(Number(r.score))
      || Number(r.score) < 1 || Number(r.score) > 10 || !String(r.oneLiner || '').trim())
    || !String(parsed.reportText || '').trim()) {
    throw new Error('AI returned an incomplete report. No empty report was saved; please retry generation.');
  }
  return parsed;
};

export const shouldAutoSend = (report, sendAt, now) => Boolean(
  report && !report.eventId && report.status === 'scheduled'
  && now >= sendAt && new Date(report.generatedAt) < sendAt
);
