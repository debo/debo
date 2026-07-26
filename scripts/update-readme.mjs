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

// Private events are anonymized and grouped per repo, so we only tally them.
const NOUNS = {
  push: ["push", "pushes"],
  pr: ["PR", "PRs"],
  review: ["review", "reviews"],
  issue: ["issue", "issues"],
  comment: ["comment", "comments"],
  release: ["release", "releases"],
};
const NOUN_ORDER = ["push", "pr", "review", "issue", "comment", "release"];

function privateKey(e) {
  const p = e.payload;
  switch (e.type) {
    case "PushEvent":
      return "push";
    case "PullRequestEvent":
      return p.action === "opened" || (p.action === "closed" && p.pull_request.merged) ? "pr" : null;
    case "PullRequestReviewEvent":
      return "review";
    case "IssuesEvent":
      return p.action === "opened" ? "issue" : null;
    case "IssueCommentEvent":
      return "comment";
    case "ReleaseEvent":
      return "release";
    default:
      return null;
  }
}

function summarize(counts) {
  const parts = NOUN_ORDER.filter((k) => counts[k]).map(
    (k) => `${counts[k]} ${NOUNS[k][counts[k] === 1 ? 0 : 1]}`
  );
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} & ${parts.at(-1)}`;
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

  // Tally private activity per repo (repo id, kept opaque in the output).
  const privateCounts = new Map();
  for (const e of events) {
    if (e.public !== false) continue;
    const key = privateKey(e);
    if (!key) continue;
    const counts = privateCounts.get(e.repo.id) ?? {};
    counts[key] = (counts[key] ?? 0) + 1;
    privateCounts.set(e.repo.id, counts);
  }

  const lines = [];
  const seenPublic = new Set();
  const emittedRepo = new Set();
  for (const e of events) {
    let line;
    if (e.public === false) {
      if (emittedRepo.has(e.repo.id)) continue;
      const summary = summarize(privateCounts.get(e.repo.id) ?? {});
      if (!summary) continue;
      emittedRepo.add(e.repo.id);
      line = `🔒 ${summary} in a repo that would return \`404\` for you`;
    } else {
      line = renderEvent(e);
      if (!line || seenPublic.has(line)) continue;
      seenPublic.add(line);
    }
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
