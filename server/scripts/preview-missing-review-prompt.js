/**
 * Prints the personal follow-up messages for a dev pair and the QA trio.
 * Usage: node scripts/preview-missing-review-prompt.js [YYYY-MM-DD]
 */
import {
  buildPromptOptions,
  formatPromptMessage,
  parsePromptReply,
} from '../services/missingReviewPromptService.js';
import { config } from '../config/appConfig.js';
import { getKarachiDateKey, getPreviousWorkingDay } from '../services/pairService.js';

const dateKey = process.argv[2] || getPreviousWorkingDay(getKarachiDateKey());

const show = (member, pair) => {
  const options = buildPromptOptions(member, pair, dateKey);
  console.log('─'.repeat(60));
  console.log(formatPromptMessage(member, pair, dateKey, options));
  console.log('');
  for (const letter of [...options.map((o) => o.letter), 'A B']) {
    const parsed = parsePromptReply(letter, options);
    if (!parsed) {
      console.log(`  reply "${letter}" → no match`);
      continue;
    }
    const absent = parsed.absentMembers?.join(', ') || '-';
    const halfDay = parsed.halfDayMembers?.join(', ') || '-';
    console.log(
      `  reply "${letter}" → ${parsed.type} | absent: ${absent} | half day: ${halfDay}`
    );
  }
};

show('Hamza', ['Hamza', 'Farhan']);
show(config.qaTeam[0], config.qaTeam);
