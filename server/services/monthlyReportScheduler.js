import MonthlyRankingReport from '../models/MonthlyRankingReport.js';
import { getKarachiDateKey } from './pairService.js';
import { previousMonthKey } from './dateValidation.js';
import { reportTimes, validateRankingOutput, shouldAutoSend } from './monthlyReportPolicy.js';
import { getAllMembers } from '../config/appConfig.js';
import { generateMonthlyReport, sendMonthlyReport } from './rankingService.js';

let running = false;
export const reconcileMonthlyReport = async (now = new Date()) => {
  if (running) return;
  running = true;
  try {
    const monthKey = previousMonthKey(getKarachiDateKey(now));
    const { generateAt, sendAt } = reportTimes(monthKey);
    if (now < generateAt) return;
    const report = await MonthlyRankingReport.findOne({ monthKey });
    if (report?.eventId) return;
    let valid = false;
    try { validateRankingOutput(report, getAllMembers()); valid = true; } catch {}
    if (!valid) {
      try { await generateMonthlyReport(monthKey); }
      catch (error) {
        await MonthlyRankingReport.updateOne({ monthKey }, { $set: { status: 'failed', error: error.message } }, { upsert: true });
        throw error;
      }
      // A late generated draft must first be available for human review.
      return;
    }
    if (shouldAutoSend(report, sendAt, now)) {
      await sendMonthlyReport(monthKey);
    }
  } finally { running = false; }
};
