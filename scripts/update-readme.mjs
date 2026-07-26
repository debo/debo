// Regenerates the activity section of README.md and the metrics.svg stats card.
// Zero dependencies: Node >= 20 built-in fetch. Auth via GITHUB_TOKEN.

import { readFile, writeFile } from "node:fs/promises";

const USER = process.env.GH_USERNAME ?? "debo";
const TOKEN = process.env.GITHUB_TOKEN;
const MAX_LINES = 5;
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

const repoLink = (name) => `[${name}](https://github.com/${name})`;

// Private events are anonymized: no repo name, number, or link.
function renderPrivate(e) {
  const p = e.payload;
  switch (e.type) {
    case "PushEvent":
      return "🔒 Pushed commits to a repo that would return `404` for you";
    case "PullRequestEvent":
      if (p.action === "opened") return "🔒 Opened a PR in a repo that would return `404` for you";
      if (p.action === "closed" && p.pull_request.merged)
        return "🔒 Merged a PR in a repo that would return `404` for you";
      return null;
    case "PullRequestReviewEvent":
      return "🔒 Reviewed a PR in a repo that would return `404` for you";
    case "IssuesEvent":
      return p.action === "opened" ? "🔒 Opened an issue in a repo that would return `404` for you" : null;
    case "IssueCommentEvent":
      return "🔒 Commented on an issue in a repo that would return `404` for you";
    case "ReleaseEvent":
      return "🔒 Published a release in a repo that would return `404` for you";
    default:
      return null;
  }
}

function renderEvent(e) {
  const repo = repoLink(e.repo.name);
  const p = e.payload;
  switch (e.type) {
    case "IssueCommentEvent":
      return `🗣 Commented on [#${p.issue.number}](${p.comment.html_url}) in ${repo}`;
    case "IssuesEvent":
      return p.action === "opened"
        ? `❗️ Opened issue [#${p.issue.number}](${p.issue.html_url}) in ${repo}`
        : null;
    case "PullRequestEvent":
      if (p.action === "opened")
        return `💪 Opened PR [#${p.pull_request.number}](${p.pull_request.html_url}) in ${repo}`;
      if (p.action === "closed" && p.pull_request.merged)
        return `🎉 Merged PR [#${p.pull_request.number}](${p.pull_request.html_url}) in ${repo}`;
      return null;
    case "ReleaseEvent":
      return `🚀 Released [${p.release.tag_name}](${p.release.html_url}) in ${repo}`;
    default:
      return null;
  }
}

async function activityBlock() {
  // /events includes private events when the token authenticates as USER.
  const events = await gh(`/users/${USER}/events?per_page=100`);

  // Pushes are grouped per repo (public: linked, private: anonymized) with a count.
  const privateKey = (e, msg) => `${e.repo.id} ${msg}`;
  const privateCounts = new Map();
  const pushCounts = new Map();
  for (const e of events) {
    if (e.type === "PushEvent" && e.public !== false) {
      pushCounts.set(e.repo.id, (pushCounts.get(e.repo.id) ?? 0) + 1);
    }
    if (e.public === false) {
      const msg = renderPrivate(e);
      if (msg) privateCounts.set(privateKey(e, msg), (privateCounts.get(privateKey(e, msg)) ?? 0) + 1);
    }
  }
  const times = (n) => (n > 1 ? ` (${n} times)` : "");

  const lines = [];
  const seen = new Set();
  for (const e of events) {
    let line;
    if (e.public === false) {
      const msg = renderPrivate(e);
      if (!msg) continue;
      const key = privateKey(e, msg);
      if (seen.has(key)) continue;
      seen.add(key);
      line = `${msg}${times(privateCounts.get(key))}`;
    } else if (e.type === "PushEvent") {
      const key = `push ${e.repo.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      line = `⬆️ Pushed commits to ${repoLink(e.repo.name)}${times(pushCounts.get(e.repo.id))}`;
    } else {
      line = renderEvent(e);
      if (!line || seen.has(line)) continue;
      seen.add(line);
    }
    lines.push(`${lines.length + 1}. ${line}`);
    if (lines.length === MAX_LINES) break;
  }
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
  return LEVELS[THRESHOLDS.findIndex((t) => score * 100 <= t)];
}

async function stats() {
  const data = await graphql(
    `query($login: String!) {
      user(login: $login) {
        name
        followers { totalCount }
        following { totalCount }
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
    rows: [
      ["Rank", rank],
      ["Total stars earned", stars],
      ["Public repos", u.publicRepos.totalCount],
      ["Private repos", u.privateRepos.totalCount],
      ["Following", u.following.totalCount],
    ],
  };
}

// github_dark palette
const BG = "#0d1117";
const BORDER = "#30363d";
const TEXT = "#c9d1d9";
const VALUE = "#58a6ff";

function renderSvg({ name, rows }) {
  const W = 300;
  const padX = 22;
  const first = 40;
  const step = 30;
  const H = first + (rows.length - 1) * step + 24;
  const items = rows
    .map(([label, value], i) => {
      const y = first + i * step;
      return `  <text x="${padX}" y="${y}" class="l">${label}</text>
  <text x="${W - padX}" y="${y}" class="v" text-anchor="end">${kfmt(value)}</text>`;
    })
    .join("\n");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${name}'s GitHub statistics">
  <style>
    .bg { fill: ${BG}; stroke: ${BORDER}; }
    text { font-family: 'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif; }
    .l { fill: ${TEXT}; font-size: 14px; }
    .v { fill: ${VALUE}; font-size: 14px; font-weight: 700; }
  </style>
  <rect class="bg" x="0.5" y="0.5" rx="6" width="${W - 1}" height="${H - 1}"/>
${items}
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
