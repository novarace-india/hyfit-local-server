export const workoutStations = [
  'Dumbbell Step-Ups',
  "Farmer's Carry",
  'Bear Crawl',
  'Burpees to Plate',
  'Front Carry + Air Squats',
  'Tyre Flips',
] as const;

export type StationOutcome = 'none' | 'penalty' | 'ics';
export type RaceStageKind = 'ready' | 'team_start' | 'memorise' | 'run' | 'station' | 'recall' | 'finish' | 'complete';

export type RaceStage = {
  id: string;
  name: string;
  instruction: string;
  kind: RaceStageKind;
  stationNumber?: number;
  nextId?: string;
};

export const raceStages: RaceStage[] = [
  { id: 'ready', name: 'Cognitive Start', instruction: 'Ask the athlete to get ready. Show the colours when the start line is clear.', kind: 'ready', nextId: 'cognitive_memorise' },
  { id: 'cognitive_memorise', name: 'Memorise Colours', instruction: 'Keep the colours visible until the athlete says they are ready.', kind: 'memorise', nextId: 'run_1' },
  { id: 'team_start', name: 'Team Start Line', instruction: 'Tap when the first partner crosses the start line.', kind: 'team_start', nextId: 'run_1' },
  ...workoutStations.flatMap((station, index): RaceStage[] => {
    const number = index + 1;
    return [
      { id: `run_${number}`, name: `200 m Run ${number}`, instruction: 'Tap complete when the athlete reaches the station line.', kind: 'run', nextId: `station_${number}` },
      { id: `station_${number}`, name: station, instruction: number === 3 ? 'Choose No penalty, Knee touch +10 s, or ICS before completing.' : 'No penalty is selected. Choose ICS only if the station is incomplete.', kind: 'station', stationNumber: number, nextId: number === 6 ? 'cognitive_recall' : `run_${number + 1}` },
    ];
  }),
  { id: 'cognitive_recall', name: 'Cognitive Recall', instruction: 'Give the device to the athlete. Tap the remembered colours quickly.', kind: 'recall', nextId: 'finish_approach' },
  { id: 'finish_approach', name: 'Finish Line', instruction: 'Tap Finish Race when the athlete crosses the finish line.', kind: 'finish', nextId: 'complete' },
  { id: 'complete', name: 'Race Complete', instruction: 'Timing is complete.', kind: 'complete' },
];

export function raceStage(id: string) {
  return raceStages.find((stage) => stage.id === id);
}

const bearCrawlPenaltyExemptContests = new Set(['1', '2', '3', '4', '9']);

export function allowsBearCrawlPenalty(contestId: string | null | undefined) {
  return !bearCrawlPenaltyExemptContests.has(String(contestId ?? '').trim());
}

export function validateStationOutcome(stationNumber: number, outcome: StationOutcome, penaltySeconds: number, note: string, contestId = '') {
  if (outcome === 'ics') return penaltySeconds === 0;
  if (outcome === 'penalty') return stationNumber === 3 && penaltySeconds === 10 && allowsBearCrawlPenalty(contestId);
  return outcome === 'none' && penaltySeconds === 0;
}

// Counted in COLOURS, not percent: 0–5 correct is +30s, 6–9 costs nothing, all
// ten pays a 30s bonus. Must stay in step with `cognitiveAdjustment` in
// `backend/src/hyfit-judge/hjudge-race-rules.ts`, which is what actually writes
// `cognitiveskillpenalty` — this copy only draws the judge's screen. The percent
// form both once used disagreed with itself at six of ten (= 60%).
export function cognitiveAdjustment(response: string[], sequence: string[]) {
  const { scoreSequence, cognitiveSequenceLength } = require('./cognitive-sequence');
  const score = scoreSequence(response, sequence);
  return {
    ...score,
    penaltySeconds: score.correctCount <= 5 ? 30 : 0,
    bonusSeconds: score.correctCount === cognitiveSequenceLength ? 30 : 0,
  };
}

export function formatRaceTime(milliseconds: number) {
  const safe = Math.max(0, Math.floor(milliseconds));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const tenths = Math.floor((safe % 1000) / 100);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}
