#!/usr/bin/env node
/**
 * `livetennis` — a command-line client for the Live Tennis API.
 *
 * ```
 * export LIVETENNISAPI_KEY=twjp_…
 * npx livetennisapi live
 * npx livetennisapi match 18953
 * npx livetennisapi watch --match 18953
 * ```
 *
 * Zero dependencies — tables are rendered by hand so `npx livetennisapi` needs
 * no install beyond the package itself.
 */

import { LiveTennisAPI } from './client.js';
import { LiveTennisAPIError, RateLimited, Unauthorized, UpgradeRequired } from './errors.js';
import { formatScore } from './types.js';
import type { Match, MatchStatus, Player, Score } from './types.js';
import { VERSION } from './index.js';

const HELP = `livetennis ${VERSION} — Live Tennis API (https://livetennisapi.com)

Usage
  livetennis health                    liveness probe (no key needed)
  livetennis live [--status S]         matches by status: live|upcoming|completed
  livetennis match <id>                full detail for one match
  livetennis score <id>                current score only
  livetennis players <query>           search players by name
  livetennis fixtures                  upcoming scheduled fixtures
  livetennis history                   recently completed matches
  livetennis watch [--match <id>]      stream live scores (ULTRA)

Options
  --limit <n>     cap the number of rows
  --json          emit raw JSON instead of a table
  --api-key <k>   override $LIVETENNISAPI_KEY
  --version       print the version

The API key is read from --api-key or $LIVETENNISAPI_KEY.
Get one at https://livetennisapi.com/#pricing`;

interface Args {
  command: string;
  positional: string[];
  status: MatchStatus;
  limit?: number;
  match?: number;
  json: boolean;
  apiKey?: string;
  baseUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: '', positional: [], status: 'live', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--json') args.json = true;
    else if (arg === '--status') args.status = argv[++i] as MatchStatus;
    else if (arg === '--limit') args.limit = Number(argv[++i]);
    else if (arg === '--match') args.match = Number(argv[++i]);
    else if (arg === '--api-key') args.apiKey = argv[++i];
    else if (arg === '--base-url') args.baseUrl = argv[++i];
    else if (!arg.startsWith('-')) {
      if (!args.command) args.command = arg;
      else args.positional.push(arg);
    }
  }
  return args;
}

function table(title: string, columns: string[], rows: (string | number)[][]): void {
  if (!rows.length) {
    console.log(`${title}: nothing to show`);
    return;
  }
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  console.log(`\n${title}`);
  console.log(columns.map((c, i) => c.padEnd(widths[i]!)).join('  '));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    console.log(row.map((c, i) => String(c ?? '').padEnd(widths[i]!)).join('  '));
  }
  console.log();
}

const names = (m: Match): [string, string] => [
  m.players?.p1?.name ?? '?',
  m.players?.p2?.name ?? '?',
];

const serverMark = (score: Score | null | undefined, side: 1 | 2): string =>
  score?.server === side ? '*' : ' ';

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--version')) {
    console.log(`livetennisapi ${VERSION}`);
    return 0;
  }
  const args = parseArgs(argv);
  if (!args.command || args.command === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return args.command ? 0 : 1;
  }

  const hasKey = Boolean(args.apiKey || process.env.LIVETENNISAPI_KEY);
  if (args.command !== 'health' && !hasKey) {
    console.log('No API key. Set LIVETENNISAPI_KEY or pass --api-key.');
    console.log('Get one at https://livetennisapi.com/#pricing');
    return 2;
  }

  const client = new LiveTennisAPI({ apiKey: args.apiKey, baseUrl: args.baseUrl });
  const show = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  try {
    switch (args.command) {
      case 'health':
        show(await client.health());
        return 0;

      case 'live': {
        const page = await client.listMatches({ status: args.status, limit: args.limit ?? 50 });
        if (args.json) return show(page), 0;
        table(
          `${args.status} matches (${page.data.length})`,
          ['ID', 'Tournament', 'Rd', 'Players', 'Score'],
          page.data.map((m) => {
            const [a, b] = names(m);
            return [
              m.id ?? '-',
              (m.tournament ?? '-').slice(0, 34),
              m.round ?? '-',
              `${serverMark(m.score, 1)}${a} / ${serverMark(m.score, 2)}${b}`,
              formatScore(m.score),
            ];
          }),
        );
        return 0;
      }

      case 'match': {
        const id = Number(args.positional[0]);
        if (!Number.isFinite(id)) return console.log('usage: livetennis match <id>'), 1;
        const m = await client.getMatch(id);
        if (args.json) return show(m), 0;
        const [a, b] = names(m);
        const rows: (string | number)[][] = [
          ['ID', m.id ?? '-'],
          ['Tournament', m.tournament ?? '-'],
          ['Round', m.round ?? '-'],
          ['Surface', `${m.surface ?? '-'}${m.indoor ? ' (indoor)' : ''}`],
          ['Status', m.status ?? '-'],
          ['Players', `${a} vs ${b}`],
          ['Score', formatScore(m.score)],
        ];
        if (m.winner) rows.push(['Winner', m.winner === 1 ? a : b]);
        if (m.score?.win_probability_p1 != null) {
          rows.push(['Win prob (p1)', `${(m.score.win_probability_p1 * 100).toFixed(1)}%`]);
        }
        if (m.score?.danger != null) rows.push(['Danger', m.score.danger.toFixed(3)]);
        if (m.market) rows.push(['Market', m.market.question ?? '-']);
        table('Match', ['Field', 'Value'], rows);
        return 0;
      }

      case 'score': {
        const id = Number(args.positional[0]);
        if (!Number.isFinite(id)) return console.log('usage: livetennis score <id>'), 1;
        const score = await client.getMatchScore(id);
        if (args.json) return show(score), 0;
        console.log(formatScore(score));
        return 0;
      }

      case 'players': {
        const query = args.positional[0];
        if (!query) return console.log('usage: livetennis players <query>'), 1;
        const page = await client.searchPlayers(query, { limit: args.limit ?? 25 });
        if (args.json) return show(page), 0;
        table(
          `Players matching "${query}"`,
          ['ID', 'Name', 'Country', 'Rank', 'Tour'],
          page.data.map((p: Player) => [
            p.id ?? '-',
            p.name ?? '-',
            p.country ?? '-',
            p.ranking ?? '-',
            p.tour ?? '-',
          ]),
        );
        return 0;
      }

      case 'fixtures': {
        const page = await client.listFixtures({ limit: args.limit ?? 25 });
        if (args.json) return show(page), 0;
        table(
          `Upcoming fixtures (${page.data.length})`,
          ['Date', 'Tournament', 'Rd', 'Players'],
          page.data.map((f) => [
            f.event_date ?? '-',
            (f.tournament ?? '-').slice(0, 30),
            f.round ?? '-',
            `${f.player1_name ?? '?'} vs ${f.player2_name ?? '?'}`,
          ]),
        );
        return 0;
      }

      case 'history': {
        const page = await client.listCompletedMatches({ limit: args.limit ?? 25 });
        if (args.json) return show(page), 0;
        table(
          `Completed matches (${page.data.length})`,
          ['ID', 'Tournament', 'Players', 'Score', 'Winner'],
          page.data.map((m) => {
            const [a, b] = names(m);
            return [
              m.id ?? '-',
              (m.tournament ?? '-').slice(0, 30),
              `${a} vs ${b}`,
              formatScore(m.score),
              m.winner === 1 ? a : m.winner === 2 ? b : '-',
            ];
          }),
        );
        return 0;
      }

      case 'watch': {
        const { LiveScoreStream } = await import('./ws.js');
        const topics = args.match ? [`match:${args.match}`] : ['live-scores'];
        console.log(`subscribing to ${topics[0]} — Ctrl-C to stop`);
        const stream = new LiveScoreStream({ apiKey: client.apiKey, baseUrl: client.baseUrl, topics });
        process.on('SIGINT', () => {
          stream.close();
          process.exit(130);
        });
        for await (const update of stream) {
          if (args.json) console.log(JSON.stringify(update));
          else console.log(`[${update.match_id}] ${formatScore(update)}`);
        }
        return 0;
      }

      default:
        console.log(`unknown command: ${args.command}\n`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof Unauthorized) {
      console.log('Unauthorized — the key is missing, unknown, or disabled.');
      return 2;
    }
    if (err instanceof UpgradeRequired) {
      console.log(
        `This endpoint needs the ${err.requiredTier ?? 'a higher'} tier. See https://livetennisapi.com/#pricing`,
      );
      return 3;
    }
    if (err instanceof RateLimited) {
      console.log(`Rate limited.${err.retryAfter ? ` Retry after ${err.retryAfter}s.` : ''}`);
      return 4;
    }
    if (err instanceof LiveTennisAPIError) {
      console.log(`Error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
