// Ambient type for the vendored, pure ranker module (`.agents/okf/topics/_rank.mjs`). It lives OUTSIDE
// this package (it is vendored per-repo, not built by the CLI), so it has no compiled declaration — this
// wildcard gives the tests real types without a build-time coupling. Shape mirrors the CLI's `Card`.
declare module '*/_rank.mjs' {
  export interface RankCard {
    key: string;
    title: string;
    resource: string;
    seeds: string[];
    symbols: string[];
    aliases: string[];
    tags: string[];
    curated: string;
    curatedLower: string;
  }
  export function parseCardForRank(fallbackKey: string, text: string): RankCard;
  export function rankCards(cards: RankCard[], query: string): { card: RankCard; score: number }[];
}
