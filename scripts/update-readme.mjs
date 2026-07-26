// Regenerates the activity section of README.md and the metrics.svg stats card.
// Zero dependencies: Node >= 20 built-in fetch. Auth via GITHUB_TOKEN.

import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.GH_USERNAME ?? "debo";
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_LINES = 8;
const ACTIVITY_DAYS = 14;
const README = "README.md";
const SVG = "metrics.svg";
const START = "<!--START_SECTION:activity-->";
const END = "<!--END_SECTION:activity-->";

if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

const gh = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
};

const graphql = async (query, variables) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`graphql ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  if (json.errors) throw new Error(`graphql: ${JSON.stringify(json.errors)}`);
  return json.data;
};

// ---- activity ------------------------------------------------------------

const link = (nameWithOwner, url) => `[${nameWithOwner}](${url})`;
const plural = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;

// Public per-repo contribution counts, matching the profile's activity timeline.
const CONTRIB_QUERY = `query($login: String!, $from: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from) {
      restrictedContributionsCount
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner url isPrivate } contributions { totalCount }
      }
      pullRequestContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner url isPrivate } contributions { totalCount }
      }
      pullRequestReviewContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner url isPrivate } contributions { totalCount }
      }
      issueContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner url isPrivate } contributions { totalCount }
      }
    }
  }
}`;

// Issue comments aren't "contributions", so they only exist in the events stream.
function commentEntries(events) {
  const byRepo = new Map();
  for (const e of events) {
    if (e.type !== "IssueCommentEvent" || e.public === false) continue;
    byRepo.set(e.repo.name, (byRepo.get(e.repo.name) ?? 0) + 1);
  }
  return [...byRepo].map(
    ([name, n]) => `🗣 Left ${plural(n, "comment")} in ${link(name, `https://github.com/${name}`)}`
  );
}

async function activityBlock() {
  const from = new Date(Date.now() - ACTIVITY_DAYS * 86400000).toISOString();
  const [events, data] = await Promise.all([
    gh(`/users/${USER}/events?per_page=100`),
    graphql(CONTRIB_QUERY, { login: USER, from }),
  ]);
  const c = data.user.contributionsCollection;
  const pub = (list) => list.filter((r) => !r.repository.isPrivate);
  const entry = (verb, noun) => (r) =>
    `${verb} ${plural(r.contributions.totalCount, noun)} in ${link(r.repository.nameWithOwner, r.repository.url)}`;

  const entries = [
    ...pub(c.commitContributionsByRepository).map(
      (r) => `⬆️ Pushed ${plural(r.contributions.totalCount, "commit")} to ${link(r.repository.nameWithOwner, r.repository.url)}`
    ),
    ...pub(c.pullRequestContributionsByRepository).map(entry("💪 Opened", "PR")),
    ...pub(c.pullRequestReviewContributionsByRepository).map(entry("👀 Reviewed", "PR")),
    ...pub(c.issueContributionsByRepository).map(entry("❗️ Opened", "issue")),
    ...commentEntries(events),
  ];
  if (c.restrictedContributionsCount > 0) {
    entries.push(
      `🔒 ${plural(c.restrictedContributionsCount, "contribution")} in private repos that would return \`404\` for you`
    );
  }

  const lines = entries.slice(0, MAX_LINES).map((e, i) => `${i + 1}. ${e}`);
  return lines.length ? lines.join("\n") : "1. No recent activity";
}

// ---- stats card ----------------------------------------------------------

const kfmt = (n) => (typeof n === "string" ? n : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// github-readme-stats rank: weighted percentile -> letter grade (S, A+, ... C).
const expCdf = (x) => 1 - 2 ** -x;
const logNormalCdf = (x) => x / (1 + x);
function calcRank({ commits, prs, issues, reviews, stars, followers }) {
  const W = { commits: 2, prs: 3, issues: 1, reviews: 1, stars: 4, followers: 1 };
  const M = { commits: 1000, prs: 50, issues: 25, reviews: 2, stars: 50, followers: 10 };
  const total = Object.values(W).reduce((a, b) => a + b, 0);
  const score =
    1 -
    (W.commits * expCdf(commits / M.commits) +
      W.prs * expCdf(prs / M.prs) +
      W.issues * expCdf(issues / M.issues) +
      W.reviews * expCdf(reviews / M.reviews) +
      W.stars * logNormalCdf(stars / M.stars) +
      W.followers * logNormalCdf(followers / M.followers)) /
      total;
  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
  const percentile = score * 100;
  return { level: LEVELS[THRESHOLDS.findIndex((t) => percentile <= t)], percentile };
}

async function stats() {
  const data = await graphql(
    `query($login: String!) {
      user(login: $login) {
        name
        followers { totalCount }
        contributionsCollection {
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
        }
        publicRepos: repositories(privacy: PUBLIC, ownerAffiliations: OWNER) {
          totalCount
        }
        privateRepos: repositories(privacy: PRIVATE, ownerAffiliations: OWNER) {
          totalCount
        }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
          nodes { stargazerCount }
        }
      }
    }`,
    { login: USER }
  );
  const u = data.user;
  const c = u.contributionsCollection;
  const stars = u.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);

  // All-time authored commits (matches GRS include_all_commits); fall back to last year.
  let commits = c.totalCommitContributions;
  try {
    const search = await gh(`/search/commits?q=author:${USER}&per_page=1`);
    if (typeof search.total_count === "number") commits = search.total_count;
  } catch {
    // search API unavailable (rate limit); keep the last-year figure
  }

  const rank = calcRank({
    commits,
    prs: c.totalPullRequestContributions,
    issues: c.totalIssueContributions,
    reviews: c.totalPullRequestReviewContributions,
    stars,
    followers: u.followers.totalCount,
  });
  return {
    name: u.name ?? USER,
    rank,
    rows: [
      ["Total stars earned", stars],
      ["Total commits", commits],
      ["Public repos", u.publicRepos.totalCount],
      ["Private repos", u.privateRepos.totalCount],
    ],
  };
}

// github_dark palette
const BG = "#0d1117";
const BORDER = "#30363d";
const TEXT = "#c9d1d9";
const VALUE = "#58a6ff";

function renderSvg({ name, rows, rank }) {
  const W = 430;
  const H = 180;
  const padX = 24;
  const valX = 250;
  const first = 54;
  const step = 34;
  const rowsSvg = rows
    .map(([label, value], i) => {
      const y = first + i * step;
      return `  <text x="${padX}" y="${y}" class="l">${label}</text>
  <text x="${valX}" y="${y}" class="v" text-anchor="end">${kfmt(value)}</text>`;
    })
    .join("\n");

  const cx = 350;
  const cy = 88;
  const r = 44;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, (100 - rank.percentile) / 100) * circ;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${name}'s GitHub statistics, rank ${rank.level}">
  <style>
    .bg { fill: ${BG}; stroke: ${BORDER}; }
    text { font-family: 'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif; }
    .l { fill: ${TEXT}; font-size: 14px; }
    .v { fill: ${VALUE}; font-size: 14px; font-weight: 700; }
    .rank { fill: ${VALUE}; font-size: 30px; font-weight: 700; }
    .rlabel { fill: ${TEXT}; font-size: 12px; }
  </style>
  <rect class="bg" x="0.5" y="0.5" rx="6" width="${W - 1}" height="${H - 1}"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${BORDER}" stroke-width="8"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${VALUE}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${filled.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy + 10}" text-anchor="middle" class="rank">${rank.level}</text>
  <text x="${cx}" y="${cy + r + 22}" text-anchor="middle" class="rlabel">Rank</text>
${rowsSvg}
</svg>
`;
}

// ---- main ----------------------------------------------------------------

const [block, s] = await Promise.all([activityBlock(), stats()]);

const readme = await readFile(README, "utf8");
const re = new RegExp(`${START}[\\s\\S]*${END}`);
const updated = readme.replace(re, `${START}\n${block}\n${END}`);
if (updated !== readme) await writeFile(README, updated);

await writeFile(SVG, renderSvg(s));
console.log(`activity: ${block.split("\n").length} lines | stars: ${s.rows[0][1]}`);
