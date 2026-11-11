// Minimal start: a stockpile of tickets (all in Next) + a 1.0 release already running in production. Nothing else.
// Usage: delete data.json, start the server, then: node seed-minimal.js
const API = process.env.API || "http://localhost:4010";
const call = async (path, method = "GET", body) => {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${j.error}`); return j;
};
if ((await call("/jira/issues")).length) { console.log("Issues already exist, not seeding."); process.exit(0); }
const mk = (b) => call("/jira/issues", "POST", { assignee: "nate", ...b });
const auth = await mk({ type: "Feature", title: "Authentication", description: "Register, log in, stay logged in, edit profile." });
const art = await mk({ type: "Feature", title: "Articles", description: "Create, read, edit, delete and list articles, with tags and pagination." });
const soc = await mk({ type: "Feature", title: "Comments & favorites", description: "Readers can comment on and favorite articles." });
for (const [p, type, title] of [
  [auth, "Spike", "Spike: JWT refresh vs. long-lived tokens"], [auth, "Story", "User can register with email, username and password"], [auth, "Story", "User can log in and out"],
  [auth, "Defect", "Login error message shows raw 422 JSON"], [auth, "Story", "User can edit profile (bio, image, password)"],
  [art, "Story", "Author can publish an article with tags"], [art, "Story", "Reader can view an article by slug"], [art, "Story", "Paginate the feed 10 per page"],
  [art, "Defect", "Global feed is slow with 10k+ articles"], [art, "Defect", "Tag with '&' breaks the tag filter URL"], [art, "Spike", "Spike: full-text search options"],
  [soc, "Story", "Reader can favorite / unfavorite an article"], [soc, "Story", "Reader can comment on an article"],
]) await mk({ type, title, parent: p.key });
// baseline: 1.0 already released and serving in production
await call("/bitbucket/repos/impact/pullrequests", "POST", { title: "Release 1.0", source: "release/1.0", destination: "master", author: "jo", reviewers: ["nate"], draft: false }).then(async (p) => {
  await call("/bitbucket/repos/impact/commits", "POST", { branch: "release/1.0", message: "Bump version to 1.0", author: "jo" });
  for (const st of ["APPROVED", "MERGED"]) await call(`/bitbucket/repos/impact/pullrequests/${p.id}`, "PATCH", { state: st, by: st === "MERGED" ? "jo" : "nate" });
});
await call("/bitbucket/repos/impact/pipelines", "POST", { environment: "production", autoSwitch: true });
console.log("Seeded: stockpile only.");
