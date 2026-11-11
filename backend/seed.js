// Seeds the running mock with a sample project (RealWorld "Conduit", a Medium clone).
// Usage: node seed.js   (server must be running; refuses if issues already exist)
// Everything is walked through the real allowed transitions, so history looks like it would have happened.
const API = process.env.API || "http://localhost:4010";
const call = async (path, method = "GET", body) => {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`);
  return j;
};
if ((await call("/jira/issues")).length) { console.log("Issues already exist, not seeding. Delete backend/data.json and restart to reset."); process.exit(0); }

const ISSUE_PATH = ["Dev WIP", "Dev Done", "Verification", "Done"];
const issue = async (b, status = "Next") => {
  const i = await call("/jira/issues", "POST", b);
  if (status !== "Next") for (const st of ISSUE_PATH.slice(0, ISSUE_PATH.indexOf(status) + 1)) await call(`/jira/issues/${i.key}`, "PATCH", { status: st });
  console.log(i.key.padEnd(8), b.type.padEnd(8), status.padEnd(13), b.title);
  return i;
};
const PR_PATH = { OPEN: [], APPROVED: ["APPROVED"], CHANGES_REQUESTED: ["CHANGES_REQUESTED"], MERGED: ["APPROVED", "MERGED"] };
// commits = messages pushed to the PR's branch before it moves on
const pr = async (repo, b, state, commits = []) => {
  const p = await call(`/bitbucket/repos/${repo}/pullrequests`, "POST", b);
  for (const message of commits) await call(`/bitbucket/repos/${repo}/commits`, "POST", { branch: b.source, message, author: b.author });
  for (const st of PR_PATH[state] ?? []) await call(`/bitbucket/repos/${repo}/pullrequests/${p.id}`, "PATCH", { state: st, by: st === "MERGED" ? b.author : (b.reviewers?.[0] ?? b.author) });
  console.log(`  PR ${repo}#${p.id}`.padEnd(18), (state || "DRAFT").padEnd(18), b.title);
  return p;
};

// ----- Features -----
const auth = await issue({ assignee: "nate", type: "Feature", title: "Authentication", description: "Register, log in, stay logged in, edit profile." }, "Dev WIP");
const articles = await issue({ assignee: "jo", type: "Feature", title: "Articles", description: "Create, read, edit, delete and list articles, with tags and pagination." }, "Dev WIP");
const social = await issue({ assignee: "nate", type: "Feature", title: "Comments & favorites", description: "Readers can comment on and favorite articles, and follow authors." });

// ----- Authentication -----
const spikeJwt = await issue({ assignee: "nate", type: "Spike", parent: auth.key, title: "Spike: JWT refresh vs. long-lived tokens", description: "Timebox 1 day. Decide how sessions survive page reloads without hurting security." }, "Done");
const s1 = await issue({ assignee: "nate", type: "Story", parent: auth.key, spawnedFrom: spikeJwt.key, title: "Issue short-lived access token + refresh cookie", description: "From spike: 15 min access token, httpOnly refresh cookie." }, "Dev WIP");
const s2 = await issue({ assignee: "jo", type: "Story", parent: auth.key, spawnedFrom: spikeJwt.key, title: "Silent token refresh on the client", description: "From spike: refresh before expiry, retry the failed request once." });
const reg = await issue({ assignee: "jo", type: "Story", parent: auth.key, title: "User can register with email, username and password", description: "Validate uniqueness; show field-level errors." }, "Done");
const login = await issue({ assignee: "nate", type: "Story", parent: auth.key, title: "User can log in and out", description: "Header shows Sign in / Sign up or the user's name." }, "Verification");
const loginDefect = await issue({ assignee: "jo", type: "Defect", parent: auth.key, title: "Login error message shows raw 422 JSON", description: "Wrong password renders the whole response body instead of 'email or password is invalid'." }, "Dev Done");
const profile = await issue({ assignee: "nate", type: "Story", parent: auth.key, title: "User can edit profile (bio, image, password)" });

// ----- Articles -----
const feed = await issue({ assignee: "jo", type: "Defect", parent: articles.key, title: "Global feed is slow with 10k+ articles", description: "Started as a spike: 'why is the feed slow?'. Turned out to be a missing index and an N+1 on authors." }, "Dev WIP");
const create = await issue({ assignee: "nate", type: "Story", parent: articles.key, title: "Author can publish an article with tags", description: "Markdown body, comma-separated tags, slug generated from the title." }, "Dev Done");
const view = await issue({ assignee: "jo", type: "Story", parent: articles.key, title: "Reader can view an article by slug" }, "Done");
const paginate = await issue({ type: "Story", parent: articles.key, title: "Paginate the feed 10 per page", description: "Page links under the list, keep the page in the URL." });
await issue({ type: "Defect", parent: articles.key, title: "Tag with '&' breaks the tag filter URL" });
const spikeSearch = await issue({ assignee: "nate", type: "Spike", parent: articles.key, title: "Spike: full-text search options (Postgres FTS vs. external)", description: "Outcome should be new Stories under Articles, or a recommendation to not do it." });

// ----- Social -----
await issue({ assignee: "jo", type: "Story", parent: social.key, title: "Reader can favorite / unfavorite an article" });
await issue({ type: "Story", parent: social.key, title: "Reader can comment on an article" });

// ----- Branches, commits and pull requests -----
// impact = my project (Jo is the 2nd dev). pagaboplus + sypro are unrelated products; I only code-review there (low on engineers).
// Each repo already has a 1.0 release merged to master. Only impact is mine, so only impact has environments and deploys.
for (const repo of ["impact", "pagaboplus", "sypro"]) {
  await pr(repo, { title: "Release 1.0", source: "release/1.0", destination: "master", author: "jo", reviewers: ["nate"], draft: false }, "MERGED", ["Bump version to 1.0"]);
  if (repo === "impact") await call(`/bitbucket/repos/${repo}/pipelines`, "POST", { environment: "production" });
}
// the spike's branch: commits, but never a PR
await call("/bitbucket/repos/impact/branches", "POST", { name: "spike/jwt-refresh", issue: spikeJwt.key });
for (const message of ["Prototype long-lived token", "Prototype refresh-token cookie", "Notes: comparison and recommendation"])
  await call("/bitbucket/repos/impact/commits", "POST", { branch: "spike/jwt-refresh", message });

await pr("impact", { title: `${s1.key} Refresh-token cookie`, source: "feat/refresh-token", issue: s1.key, author: "nate", reviewers: ["jo"], draft: true }, "DRAFT", ["Add refresh token table", "Set httpOnly cookie on login", "Rotate refresh token on use"]);
await pr("impact", { title: `${feed.key} Index articles.created_at, fix N+1`, source: "fix/feed-perf", issue: feed.key, author: "jo", reviewers: ["nate"], draft: false }, "OPEN", ["Add index on created_at", "Batch-load authors"]);
await pr("impact", { title: `${create.key} POST /articles with tags`, source: "feat/create-article", issue: create.key, author: "nate", reviewers: ["jo"], draft: false }, "APPROVED", ["Article model + migration", "POST /articles", "Tag parsing and slug generation"]);
await pr("impact", { title: `${login.key} Login endpoint + session cookie`, source: "feat/login", issue: login.key, author: "nate", reviewers: ["jo"], draft: false }, "MERGED", ["POST /users/login", "Session cookie"]);
await pr("impact", { title: `${loginDefect.key} Return friendly login errors`, source: "fix/login-errors", issue: loginDefect.key, author: "jo", reviewers: ["nate"], draft: false }, "OPEN", ["Map 422 to a friendly message"]);
await pr("pagaboplus", { title: "Fix pagination off-by-one on result lists", source: "fix/pagination", author: "sam", reviewers: ["nate", "priya"], draft: false }, "OPEN", ["Fix page offset"]);
await pr("pagaboplus", { title: "Add CSV export to reports", source: "feat/csv-export", author: "priya", reviewers: ["nate"], draft: false }, "OPEN", ["CSV writer", "Download button"]);
await pr("pagaboplus", { title: "Bump dependencies and fix lockfile", source: "chore/deps", author: "sam", reviewers: ["nate"], draft: false }, "MERGED", ["Bump deps"]);
await pr("sypro", { title: "Retry failed sync jobs with backoff", source: "feat/sync-retry", author: "priya", reviewers: ["nate"], draft: false }, "OPEN", ["Backoff helper", "Retry failed jobs"]);
await pr("sypro", { title: "Move config to environment variables", source: "chore/env-config", author: "sam", reviewers: ["nate", "priya"], draft: false }, "CHANGES_REQUESTED", ["Read config from env"]);
await pr("sypro", { title: "WIP: audit trail", source: "feat/audit-trail", author: "priya", reviewers: [], draft: true }, "DRAFT");

// ----- My laptop: worktrees + docker stacks -----
const wt = async (b) => { const w = await call("/local/worktrees", "POST", b); console.log(`  WT ${w.id} ${w.repo}`.padEnd(22), w.docker.status.padEnd(8), w.path); };
await wt({ repo: "impact", branch: "feat/refresh-token", path: "~/work/impact-wt/PROJ-5", issue: s1.key, dockerStatus: "running", dockerPort: "3105" });
await wt({ repo: "impact", branch: "feat/create-article", path: "~/work/impact-wt/PROJ-12", issue: create.key, dockerStatus: "stopped", dockerPort: "3112" });
await wt({ repo: "impact", branch: "feat/login", path: "~/work/impact-wt/PROJ-8", issue: login.key, dockerStatus: "running", dockerPort: "3108" });
await wt({ repo: "impact", branch: "fix/feed-perf", path: "~/work/impact-wt/review-jo-feed", issue: feed.key, dockerStatus: "stopped", dockerPort: "3111", notes: "reviewing Jo's PR" });
await wt({ repo: "pagaboplus", branch: "fix/pagination", path: "~/work/pagaboplus-wt/review-pagination", dockerStatus: "running", dockerPort: "4201", notes: "code review" });
await wt({ repo: "sypro", branch: "feat/sync-retry", path: "~/work/sypro-wt/review-sync-retry", dockerStatus: "stopped", dockerPort: "5301", notes: "code review" });
await wt({ repo: "impact", branch: "spike/jwt-refresh", path: "~/work/impact-wt/PROJ-4-spike", issue: spikeJwt.key, dockerStatus: "stopped", dockerPort: "3104", notes: "prototype of both token approaches" });

// ----- Claude sessions: each one can touch many tickets and PRs -----
const sess = async (b) => { const x = await call("/local/sessions", "POST", { sessionId: crypto.randomUUID(), ...b }); console.log(`  SESSION ${x.id} ${x.status}`.padEnd(24), (x.longLived ? "LONG-LIVED " : "           ") + x.name); };
await sess({ name: "Authentication: whole feature context", issues: [auth.key, spikeJwt.key, s1.key, s2.key, reg.key, login.key, loginDefect.key, profile.key], prs: ["impact#2", "impact#5", "impact#6"], longLived: true, status: "idle", notes: "Long-lived. Knows the token design and every Auth ticket." });
await sess({ name: "JWT refresh spike", issues: [spikeJwt.key, s1.key, s2.key], worktree: "wt-7", status: "idle", notes: "Compared both approaches, wrote the recommendation, spawned two stories." });
await sess({ name: "Refresh-token cookie", issues: [s1.key], prs: ["impact#2"], worktree: "wt-1", status: "active" });
await sess({ name: "Login staging verification", issues: [login.key], prs: ["impact#5"], worktree: "wt-3", status: "idle", notes: "Resumed to test on staging." });
await sess({ name: "Articles: publish + feed", issues: [create.key, feed.key, view.key, paginate.key, spikeSearch.key], prs: ["impact#3", "impact#4"], worktree: "wt-2", status: "idle" });
await sess({ name: "Review day", issues: [], prs: ["pagaboplus#2", "pagaboplus#3", "sypro#2", "sypro#3", "impact#3", "impact#6"], worktree: "wt-5", status: "idle" });
console.log("\nSeeded.");
