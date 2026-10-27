import { Award, Flame, MicVocal, VolumeX } from 'lucide-vue-next';
import type { Component } from 'vue';
import type { VoteSuperlative, VotingSessionState } from '@singpulse/shared/types';

export const SUPERLATIVES: ReadonlyArray<{ key: VoteSuperlative; label: string; icon: Component }> = [
  { key: 'GRAMMY_WORTHY', label: 'GRAMMY WORTHY', icon: Award },
  { key: 'PURE_PASSION', label: 'PURE PASSION', icon: Flame },
  { key: 'STAGE_LEGEND', label: 'STAGE LEGEND', icon: MicVocal },
  { key: 'RIP_EARS', label: 'RIP MY EARS', icon: VolumeX }
];

/** The most-voted superlative (first in list order on a tie); null when nobody picked one. */
export function topSuperlative(vote: Pick<VotingSessionState, 'superlativeCounts'>) {
  let best: (typeof SUPERLATIVES)[number] | null = null;
  let bestCount = 0;
  for (const entry of SUPERLATIVES) {
    const count = vote.superlativeCounts[entry.key];
    if (count > bestCount) {
      best = entry;
      bestCount = count;
    }
  }
  return best;
}
