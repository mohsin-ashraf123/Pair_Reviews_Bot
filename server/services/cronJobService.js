import CronJobLog from '../models/CronJobLog.js';

/** Reserve a one-shot cron slot across all server instances sharing MongoDB. */
export const claimCronJob = async (jobKey, meta = {}) => {
  try {
    await CronJobLog.create({
      jobKey,
      jobType: meta.jobType || null,
      dateKey: meta.dateKey || null,
      status: 'claimed',
      claimedAt: new Date(),
    });
    return true;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
};

export const completeCronJob = async (jobKey, matrixEventId) => {
  await CronJobLog.updateOne(
    { jobKey },
    {
      $set: {
        status: 'completed',
        matrixEventId: matrixEventId || null,
        completedAt: new Date(),
      },
    }
  );
};

/** Allow retry only when the Matrix send failed before completing. */
export const releaseCronJob = async (jobKey) => {
  await CronJobLog.deleteOne({ jobKey, status: 'claimed' });
};
