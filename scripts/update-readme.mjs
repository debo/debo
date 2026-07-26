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
    case "IssueCommentEvent":
      return "🔒 Commented on an issue in a repo that `404`s for you";
    case "IssuesEvent":
      return p.action === "opened" ? "🔒 Opened an issue in a repo that `404`s for you" : null;
    case "PullRequestEvent":
      if (p.action === "opened") return "🔒 Opened a PR in a repo that `404`s for you";
      if (p.action === "closed" && p.pull_request.merged)
        return "🔒 Merged a PR in a repo that `404`s for you";
      return null;
    case "ReleaseEvent":
      return "🔒 Published a release in a repo that `404`s for you";
    default:
      return null;
  }
}

function renderEvent(e) {
  if (e.public === false) return renderPrivate(e);
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
  const lines = [];
  const seen = new Set();
  for (const e of events) {
    const line = renderEvent(e);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(`${lines.length + 1}. ${line}`);
    if (lines.length === MAX_LINES) break;
  }
  return lines.length ? lines.join("\n") : "1. No recent activity";
}

// ---- stats card ----------------------------------------------------------

const kfmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

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
          restrictedContributionsCount
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
  return {
    name: u.name ?? USER,
    rows: [
      ["Total stars earned", stars],
      ["Commits (last year)", c.totalCommitContributions + c.restrictedContributionsCount],
      ["Total PRs", c.totalPullRequestContributions],
      ["Total issues", c.totalIssueContributions],
      ["Reviews (last year)", c.totalPullRequestReviewContributions],
      ["Followers", u.followers.totalCount],
    ],
  };
}

// github_dark palette
const BG = "#0d1117";
const BORDER = "#30363d";
const TITLE = "#58a6ff";
const TEXT = "#c9d1d9";
const VALUE = "#58a6ff";

function renderSvg({ name, rows }) {
  const W = 340;
  const top = 62;
  const step = 28;
  const H = top + rows.length * step - step + 34;
  const items = rows
    .map(([label, value], i) => {
      const y = top + i * step;
      return `  <text x="24" y="${y}" class="l">${label}</text>
  <text x="${W - 24}" y="${y}" class="v" text-anchor="end">${kfmt(value)}</text>`;
    })
    .join("\n");
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${name}'s GitHub statistics">
  <style>
    .bg { fill: ${BG}; stroke: ${BORDER}; }
    text { font-family: 'Segoe UI', Ubuntu, Helvetica, Arial, sans-serif; }
    .t { fill: ${TITLE}; font-size: 16px; font-weight: 600; }
    .l { fill: ${TEXT}; font-size: 14px; }
    .v { fill: ${VALUE}; font-size: 14px; font-weight: 700; }
  </style>
  <rect class="bg" x="0.5" y="0.5" rx="6" width="${W - 1}" height="${H - 1}"/>
  <text x="24" y="34" class="t">${name}'s GitHub Stats</text>
  <line x1="24" y1="46" x2="${W - 24}" y2="46" stroke="${BORDER}"/>
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
