const key = pair => [...pair].sort().join('|');
export const mergeSubmittedPairs = (existing, submitted) => {
  const available = new Set(submitted.map(key));
  const result = existing.filter(pair => available.has(key(pair)));
  const included = new Set(result.map(key));
  for (const pair of submitted) if (!included.has(key(pair))) {
    result.push(pair);
    included.add(key(pair));
  }
  return result;
};
export const nextUnverifiedIndex = (pairs, decisions, start = 0) => {
  const done = new Set(decisions.map(d => key(d.pair)));
  let index = start;
  while (index < pairs.length && done.has(key(pairs[index]))) index++;
  return index;
};
