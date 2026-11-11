// Mock Jira + Bitbucket. Zero dependencies. State is persisted to data.json.
// Run: node backend/server.js   (PORT env var overrides 4010)
import http from "node:http";
import fs from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.DATA_FILE || path.join(DIR, "data.json");
const PORT = Number(process.env.PORT || 4010);

const ISSUE_STATUSES = ["Next", "Dev WIP", "Dev Done", "Verification", "Done"];
// Allowed status moves. Edit these tables if the real workflow differs.
const ISSUE_TRANSITIONS = {
  Next: ["Dev WIP"],
  "Dev WIP": ["Dev Done", "Next"],
  "Dev Done": ["Dev WIP", "Verification"],
  Verification: ["Dev WIP", "Done"],
  Done: ["Dev WIP"],
};
const PR_TRANSITIONS = {
  DRAFT: ["OPEN", "DECLINED"],
  OPEN: ["APPROVED", "CHANGES_REQUESTED", "DECLINED", "DRAFT"],
  CHANGES_REQUESTED: ["OPEN", "DECLINED"],
  APPROVED: ["MERGED", "CHANGES_REQUESTED", "DECLINED"],
  MERGED: [],
  DECLINED: [],
};
const ISSUE_TYPES = ["Feature", "Story", "Defect", "Spike"];
// Git + deploy model. Merge to develop auto-deploys staging. Merge to master does nothing until you run the prod pipeline by hand.
const BRANCH_FOR_ENV = { staging: "develop", production: "master" };
const ENVS = Object.keys(BRANCH_FOR_ENV);
const STEPS = ["Build image", "Push image to ECR", "Register task definition", "Update ECS service", "Wait for service to stabilize"];
const STEP_MS = Number(process.env.STEP_MS || 4000); // simulated time per pipeline step
const SESSION_STATES = ["active", "idle", "archived"];
const DOCKER_STATES = ["running", "stopped", "none"];
const PR_STATES = ["DRAFT", "OPEN", "APPROVED", "CHANGES_REQUESTED", "DECLINED", "MERGED"];

// ---------- store ----------
const DEFAULT_USERS = [
  { id: "nate", name: "Nathan" },
  { id: "jo", name: "Jo" },
  { id: "sam", name: "Sam" },
  { id: "priya", name: "Priya" },
];
const ACCOUNT = "123456789012", REGION = "us-east-1"; // made up
const WAIT_STEP = "Wait for service to stabilize";
// One simulated ECS service per environment (rolling-update deployment controller, circuit breaker with rollback enabled).
const newService = (slug, env) => ({
  clusterName: `${slug}-${env}`, serviceName: `${slug}-service`, family: `${slug}-${env}`,
  desiredCount: env === "production" ? 2 : 1, nextRevision: 1,
  taskDefinitions: [], deployments: [], history: [], events: [],
});
const emptyGit = (slug) => ({ branches: [], commits: [], pipelines: [], nextPipelineId: 1, services: Object.fromEntries(ENVS.map((e) => [e, newService(slug, e)])) });
function seed() {
  return {
    me: "nate",
    users: DEFAULT_USERS,
    jira: { project: "PROJ", nextNumber: 1, issues: [] },
    bitbucket: {
      repos: ["impact", "pagaboplus", "sypro"].map((slug) => ({ slug, role: slug === "impact" ? "mine" : "review", nextPrId: 1, pullrequests: [], ...emptyGit(slug) })),
    },
  };
}
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return seed(); }
}
let db = load();
db.me ??= "nate";
db.users ??= DEFAULT_USERS;
db.worktrees ??= [];
db.nextWorktreeId ??= 1;
db.sessions ??= [];
db.bills ??= [];  db.nextBillId ??= 1;
db.releases ??= []; db.nextReleaseId ??= 1;
db.world ??= { plots: {}, orders: [], hand: null, work: {}, roster: { humans: {}, mechs: {} }, bread: 0, done: {}, nextOrderId: 1 };
delete db.plan;
db.nextSessionId ??= 1;
for (const x of db.sessions) { if ("issue" in x) { x.issues = x.issue ? [x.issue] : []; delete x.issue; } x.issues ??= []; x.prs ??= []; x.longLived ??= x.keep ?? false; delete x.keep; }
for (const r of db.bitbucket.repos) { r.role ??= r.slug === "impact" ? "mine" : "review"; for (const [k, v] of Object.entries(emptyGit(r.slug))) r[k] ??= v; }
function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic, so a crash can't corrupt the file
}

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const now = () => new Date().toISOString();
// Mock-only: the page can say who is acting via the X-Actor header, so "me" and the offered actions follow that person.
let REQ_ACTOR = null;
let REQ_ORIGIN = "";
const viewer = () => REQ_ACTOR || db.me;
const str = (v, field, { required = false, max = 10000 } = {}) => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, `${field} is too long`);
  return v;
};
const userId = (v, field) => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !db.users.some((u) => u.id === v)) throw new HttpError(400, `${field}: unknown user "${v}"`);
  return v;
};
const userIds = (v, field) => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${field} must be an array of user ids`);
  return [...new Set(v.map((x) => userId(x, field)).filter(Boolean))];
};
const canMove = (table, from, to, what) => {
  if (!table[from].includes(to)) throw new HttpError(400, `${what} can't go from ${from} to ${to}. Allowed from ${from}: ${table[from].join(", ") || "nothing"}`);
};
const actor = (b) => userId(b.by || b.author || viewer(), "by");
const oneOf = (v, list, field) => {
  if (!list.includes(v)) throw new HttpError(400, `${field} must be one of: ${list.join(", ")}`);
  return v;
};

// ---------- jira ----------
const findIssue = (key) => {
  const i = db.jira.issues.find((x) => x.key === key);
  if (!i) throw new HttpError(404, `Issue ${key} not found`);
  return i;
};
const checkParent = (type, parent) => {
  if (!parent) return;
  if (type === "Feature") throw new HttpError(400, "A Feature cannot have a parent");
  if (findIssue(parent).type !== "Feature") throw new HttpError(400, `${parent} is not a Feature`);
};
const jira = {
  list: (q) => db.jira.issues.filter((i) => ["status", "type", "parent", "assignee"].every((f) => !q.get(f) || i[f] === (q.get(f) === "me" ? viewer() : q.get(f)))).map(viewIssue),
  create: (b) => {
    const type = b.type ? oneOf(b.type, ISSUE_TYPES, "type") : "Story";
    const spawnedFrom = str(b.spawnedFrom, "spawnedFrom", { max: 50 });
    let parent = str(b.parent, "parent", { max: 50 });
    if (spawnedFrom) {
      const spike = findIssue(spawnedFrom);
      if (spike.type !== "Spike") throw new HttpError(400, `${spawnedFrom} is not a Spike`);
      if (type === "Feature" || type === "Spike") throw new HttpError(400, "A Spike can only spawn Stories or Defects");
      parent = parent ?? spike.parent;
    }
    checkParent(type, parent);
    const issue = {
      key: `${db.jira.project}-${db.jira.nextNumber++}`,
      title: str(b.title, "title", { required: true, max: 300 }),
      description: str(b.description, "description") ?? "",
      type,
      parent: parent ?? null,
      assignee: userId(b.assignee, "assignee"),
      spawnedFrom: spawnedFrom ?? null,
      status: "Next",
      comments: [],
      created: now(),
      updated: now(),
      history: [{ at: now(), by: actor(b), from: null, to: "Next" }],
    };
    db.jira.issues.push(issue);
    save();
    return viewIssue(issue);
  },
  get: (key) => viewIssue(findIssue(key)),
  patch: (key, b) => {
    const i = findIssue(key);
    if (b.title !== undefined) i.title = str(b.title, "title", { required: true, max: 300 });
    if (b.description !== undefined) i.description = str(b.description, "description") ?? "";
    if (b.type !== undefined && b.type !== i.type) {
      if (i.type !== "Spike" || !["Story", "Defect"].includes(b.type))
        throw new HttpError(400, "Only a Spike can change type, and only to Story or Defect");
      i.history.push({ at: now(), by: actor(b), field: "type", from: i.type, to: b.type });
      i.type = b.type;
    }
    if (b.assignee !== undefined) i.assignee = userId(b.assignee, "assignee");
    if (b.parent !== undefined) {
      const parent = b.parent === null ? undefined : str(b.parent, "parent", { max: 50 });
      checkParent(i.type, parent);
      i.parent = parent ?? null;
    }
    if (b.status !== undefined && b.status !== i.status) {
      oneOf(b.status, ISSUE_STATUSES, "status");
      canMove(ISSUE_TRANSITIONS, i.status, b.status, "A ticket");
      i.history.push({ at: now(), by: actor(b), from: i.status, to: b.status });
      i.status = b.status;
    }
    i.updated = now();
    save();
    return viewIssue(i);
  },
  comment: (key, b) => {
    const i = findIssue(key);
    const c = { id: i.comments.length + 1, body: str(b.body, "body", { required: true }), author: actor(b), at: now() };
    i.comments.push(c);
    i.updated = now();
    save();
    return c;
  },
};

// ---------- bitbucket ----------
const findRepo = (slug) => {
  const r = db.bitbucket.repos.find((x) => x.slug === slug);
  if (!r) throw new HttpError(404, `Repo ${slug} not found`);
  return r;
};
const findPr = (slug, id) => {
  const pr = findRepo(slug).pullrequests.find((p) => p.id === Number(id));
  if (!pr) throw new HttpError(404, `PR #${id} not found in ${slug}`);
  return pr;
};
const who = (v) => (v === "me" ? viewer() : v);
const filterPrs = (prs, q) =>
  prs.filter(
    (p) =>
      (!q.get("state") || p.state === q.get("state")) &&
      (q.get("open") !== "true" || !["MERGED", "DECLINED"].includes(p.state)) &&
      (!q.get("author") || p.author === who(q.get("author"))) &&
      (!q.get("reviewer") || p.reviewers.includes(who(q.get("reviewer"))))
  );
const bb = {
  repos: () => db.bitbucket.repos.map((r) => ({ slug: r.slug, role: r.role, openPullRequests: r.pullrequests.filter((p) => !["MERGED", "DECLINED"].includes(p.state)).length })),
  list: (slug, q) => filterPrs(findRepo(slug).pullrequests, q).map(viewPr),
  listAll: (q) => filterPrs(db.bitbucket.repos.flatMap((r) => r.pullrequests), q).map(viewPr),
  create: (slug, b) => {
    const repo = findRepo(slug);
    const pr = {
      id: repo.nextPrId++,
      repo: slug,
      title: str(b.title, "title", { required: true, max: 300 }),
      description: str(b.description, "description") ?? "",
      source: str(b.source, "source", { required: true, max: 200 }),
      destination: oneOf(str(b.destination, "destination", { max: 200 }) ?? "develop", Object.values(BRANCH_FOR_ENV), "destination"),
      issue: str(b.issue, "issue", { max: 50 }),
      author: actor(b),
      reviewers: userIds(b.reviewers, "reviewers"),
      state: b.draft === false ? "OPEN" : "DRAFT",
      comments: [],
      created: now(),
      updated: now(),
      history: [],
    };
    pr.history.push({ at: now(), by: pr.author, from: null, to: pr.state });
    repo.pullrequests.push(pr);
    recordBranch(repo, pr.source, pr.issue);
    save();
    return viewPr(pr);
  },
  get: (slug, id) => viewPr(findPr(slug, id)),
  patch: (slug, id, b) => {
    const pr = findPr(slug, id);
    if (b.title !== undefined) pr.title = str(b.title, "title", { required: true, max: 300 });
    if (b.description !== undefined) pr.description = str(b.description, "description") ?? "";
    if (b.reviewers !== undefined) pr.reviewers = userIds(b.reviewers, "reviewers");
    if (b.checks !== undefined) pr.checks = oneOf(b.checks, ["none", "running", "passed", "failed"], "checks");
    if (b.addReviewer) pr.reviewers = [...new Set([...pr.reviewers, ...userIds([b.addReviewer], "addReviewer")])];
    if (b.state !== undefined && b.state !== pr.state) {
      oneOf(b.state, PR_STATES, "state");
      canMove(PR_TRANSITIONS, pr.state, b.state, "A PR");
      pr.history.push({ at: now(), by: actor(b), from: pr.state, to: b.state });
      pr.state = b.state;
      if (b.state === "MERGED") mergePr(findRepo(slug), pr);
    }
    pr.updated = now();
    save();
    return viewPr(pr);
  },
  comment: (slug, id, b) => {
    const pr = findPr(slug, id);
    const c = { id: pr.comments.length + 1, body: str(b.body, "body", { required: true }), author: actor(b), at: now() };
    pr.comments.push(c);
    pr.updated = now();
    save();
    return c;
  },
};


// ---------- git / pipelines / environments ----------
const sha = () => randomBytes(4).toString("hex").slice(0, 7);
function mergePr(repo, pr) {
  const commit = { sha: sha(), branch: pr.destination, message: pr.title, prId: pr.id, issue: pr.issue ?? null, author: pr.author, at: now() };
  repo.commits.push(commit);
  if (repo.role === "mine" && pr.destination === BRANCH_FOR_ENV.staging) startPipeline(repo, "staging", commit.sha, "merge");
}
function startPipeline(repo, environment, commitSha, trigger, gated = true) {
  const p = {
    id: repo.nextPipelineId++, repo: repo.slug, environment, branch: BRANCH_FOR_ENV[environment], sha: commitSha, trigger,
    status: "QUEUED", gated, held: false, released: false, steps: STEPS.map((name) => ({ name, status: "PENDING" })),
    taskRevision: null, created: now(), startedAt: null, finishedAt: null,
  };
  repo.pipelines.push(p);
  return p;
}
// ---------- simulated ECS ----------
// DescribeServices-shaped: service.deployments[] with status PRIMARY | ACTIVE | INACTIVE and rolloutState IN_PROGRESS | COMPLETED | FAILED.
// A separate history of ServiceDeployment records (SUCCESSFUL | ROLLBACK_SUCCESSFUL | ROLLBACK_FAILED ...) is kept like ECS's service deployment history.
const arn = (kind, name) => `arn:aws:ecs:${REGION}:${ACCOUNT}:${kind}/${name}`;
const tdArn = (svc, rev) => arn("task-definition", `${svc.family}:${rev}`);
const TASK_START_MS = Math.round(STEP_MS * 0.6); // simulated time for one new task to go PENDING -> RUNNING
const BREAKER_THRESHOLD = 10;
const taskId = () => randomBytes(16).toString("hex");
function ecsEvent(svc, message) {
  svc.events.unshift({ id: randomUUID(), createdAt: now(), message });
  svc.events.length = Math.min(svc.events.length, 100);
}
function registerTaskDefinition(repo, env, p) {
  const svc = repo.services[env];
  const revision = svc.nextRevision++;
  svc.taskDefinitions.push({ family: svc.family, revision, arn: tdArn(svc, revision), image: `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${repo.slug}:${p.sha}`, registeredAt: now(), pipelineId: p.id });
  p.taskRevision = revision;
}
function updateService(repo, env, p) {
  const svc = repo.services[env];
  const prev = svc.deployments.find((d) => d.status === "PRIMARY");
  if (prev) prev.status = "ACTIVE";
  const id = `ecs-svc/${Date.now()}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
  const dep = {
    id, status: "PRIMARY", taskDefinition: tdArn(svc, p.taskRevision), launchType: "FARGATE",
    desiredCount: svc.desiredCount, pendingCount: svc.desiredCount, runningCount: 0, failedTasks: 0,
    rolloutState: "IN_PROGRESS", rolloutStateReason: `ECS deployment ${id} in progress.`, createdAt: now(), updatedAt: now(),
  };
  svc.deployments.unshift(dep);
  svc.history.unshift({
    serviceDeploymentArn: arn("service-deployment", `${svc.clusterName}/${svc.serviceName}/${id.split("/")[1]}`), deploymentId: id,
    status: "IN_PROGRESS", statusReason: null, createdAt: now(), startedAt: now(), finishedAt: null,
    targetServiceRevision: { taskDefinition: dep.taskDefinition, requestedTaskCount: dep.desiredCount, runningTaskCount: 0, pendingTaskCount: dep.desiredCount },
    sourceServiceRevisions: prev ? [{ taskDefinition: prev.taskDefinition, requestedTaskCount: prev.desiredCount, runningTaskCount: prev.runningCount, pendingTaskCount: 0 }] : [],
    deploymentCircuitBreaker: { status: "MONITORING", failureCount: 0, threshold: BREAKER_THRESHOLD }, rollback: null, pipelineId: p.id,
  });
  svc.history.length = Math.min(svc.history.length, 20);
  p.ecsDeploymentId = id;
}
const historyOf = (svc, id) => svc.history.find((h) => h.deploymentId === id);
// New tasks start one by one; each running new task lets one old task stop (min healthy 100%, max 200%).
function ecsTick(svc) {
  const dep = svc.deployments.find((d) => d.status === "PRIMARY" && d.rolloutState === "IN_PROGRESS");
  if (!dep) return false;
  const target = Math.min(dep.desiredCount, Math.floor((Date.now() - Date.parse(dep.createdAt)) / TASK_START_MS));
  if (target <= dep.runningCount) return false;
  const old = svc.deployments.find((d) => d.status === "ACTIVE");
  while (dep.runningCount < target) {
    dep.runningCount++; dep.pendingCount = dep.desiredCount - dep.runningCount;
    ecsEvent(svc, `(service ${svc.serviceName}) has started 1 tasks: (task ${taskId()}).`);
    if (old && old.runningCount > 0) { old.runningCount--; old.desiredCount = old.runningCount; ecsEvent(svc, `(service ${svc.serviceName}) has stopped 1 running tasks: (task ${taskId()}).`); }
  }
  dep.updatedAt = now();
  const h = historyOf(svc, dep.id);
  h.targetServiceRevision.runningTaskCount = dep.runningCount; h.targetServiceRevision.pendingTaskCount = dep.pendingCount;
  if (dep.runningCount === dep.desiredCount) {
    dep.rolloutState = "COMPLETED"; dep.rolloutStateReason = `ECS deployment ${dep.id} completed.`;
    if (old) { old.status = "INACTIVE"; old.runningCount = old.pendingCount = old.desiredCount = 0; }
    svc.deployments = svc.deployments.filter((d) => d.status !== "INACTIVE");
    h.status = "SUCCESSFUL"; h.finishedAt = now(); h.deploymentCircuitBreaker.status = "MONITORING_COMPLETE";
    ecsEvent(svc, `(service ${svc.serviceName}) has reached a steady state.`);
  }
  return true;
}
// Circuit breaker: the new deployment is FAILED, and with rollback on, the last COMPLETED deployment becomes PRIMARY again.
function failEcsDeployment(svc, p) {
  const dep = svc.deployments.find((d) => d.id === p.ecsDeploymentId && d.rolloutState === "IN_PROGRESS");
  if (!dep) return;
  const h = historyOf(svc, dep.id);
  const reason = "ECS deployment circuit breaker: tasks failed to start.";
  dep.rolloutState = "FAILED"; dep.rolloutStateReason = reason; dep.failedTasks = BREAKER_THRESHOLD; dep.updatedAt = now();
  h.deploymentCircuitBreaker = { status: "TRIGGERED", failureCount: BREAKER_THRESHOLD, threshold: BREAKER_THRESHOLD };
  h.statusReason = reason; h.finishedAt = now();
  ecsEvent(svc, `(service ${svc.serviceName}) (deployment ${dep.id}) deployment failed: tasks failed to start.`);
  const old = svc.deployments.find((d) => d.status === "ACTIVE");
  if (old) {
    dep.status = "INACTIVE"; dep.runningCount = dep.pendingCount = dep.desiredCount = 0;
    old.status = "PRIMARY"; old.desiredCount = old.runningCount = svc.desiredCount; old.pendingCount = 0;
    svc.deployments = svc.deployments.filter((d) => d.status !== "INACTIVE");
    h.status = "ROLLBACK_SUCCESSFUL"; h.rollback = { reason, startedAt: now(), serviceRevisionArn: old.taskDefinition };
    ecsEvent(svc, `(service ${svc.serviceName}) rolling back to deployment ${old.id}.`);
    ecsEvent(svc, `(service ${svc.serviceName}) has reached a steady state.`);
  } else { // nothing COMPLETED to roll back to: the deployment stays FAILED and launches no tasks
    h.status = "ROLLBACK_FAILED"; h.statusReason = `${reason} No COMPLETED deployment to roll back to.`;
  }
}
function describeService(repo, env) {
  const svc = repo.services[env];
  const primary = svc.deployments.find((d) => d.status === "PRIMARY");
  const sum = (k) => svc.deployments.reduce((n, d) => n + d[k], 0);
  return {
    serviceName: svc.serviceName, serviceArn: arn("service", `${svc.clusterName}/${svc.serviceName}`), clusterArn: arn("cluster", svc.clusterName),
    status: "ACTIVE", launchType: "FARGATE", desiredCount: svc.desiredCount, runningCount: sum("runningCount"), pendingCount: sum("pendingCount"),
    taskDefinition: primary?.taskDefinition ?? null,
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, maximumPercent: 200, minimumHealthyPercent: 100 },
    deployments: svc.deployments, events: svc.events.slice(0, 10),
  };
}

function tick() {
  let changed = false;
  for (const repo of db.bitbucket.repos) {
    if (repo.role !== "mine") continue;
    for (const env of ENVS) {
      const svc = repo.services[env];
      if (ecsTick(svc)) changed = true;
      const ps = repo.pipelines.filter((p) => p.environment === env);
      let p = ps.find((x) => x.status === "RUNNING");
      if (!p) { // one pipeline per environment at a time; the rest queue
        p = ps.find((x) => x.status === "QUEUED");
        if (!p) continue;
        p.status = "RUNNING"; p.startedAt = now();
        p.steps[0].status = "RUNNING"; p.steps[0].startedAt = now();
        changed = true; continue;
      }
      const step = p.steps.find((x) => x.status === "RUNNING");
      if (!step) continue;
      if (step.name === WAIT_STEP) { // done when ECS says the deployment is COMPLETED (or it failed)
        const h = historyOf(svc, p.ecsDeploymentId);
        if (!h || h.status === "IN_PROGRESS") continue;
        if (h.status !== "SUCCESSFUL") {
          step.status = "FAILED"; step.finishedAt = now(); p.status = "FAILED"; p.finishedAt = now(); changed = true; continue;
        }
      } else if (Date.now() - Date.parse(step.startedAt) < STEP_MS) continue;
      step.status = "SUCCESS"; step.finishedAt = now();
      if (step.name === "Register task definition") registerTaskDefinition(repo, env, p);
      if (step.name === "Update ECS service") updateService(repo, env, p);
      const next = p.steps.find((x) => x.status === "PENDING");
      if (next && next.name === "Update ECS service" && p.gated && !p.released) { p.held = true; changed = true; continue; } // the image is made and registered; the switch waits for a person
      if (next) { next.status = "RUNNING"; next.startedAt = now(); }
      else { p.status = "SUCCESS"; p.finishedAt = now(); }
      changed = true;
    }
  }
  if (changed) save();
}
setInterval(() => { try { tick(); } catch (e) { console.error("tick", e); } }, 500).unref?.();

const findPipeline = (slug, id) => {
  const p = findRepo(slug).pipelines.find((x) => x.id === Number(id));
  if (!p) throw new HttpError(404, `Pipeline ${id} not found in ${slug}`);
  return p;
};
function envView(repo, env) {
  const branch = BRANCH_FOR_ENV[env];
  const ps = repo.pipelines.filter((p) => p.environment === env);
  const latest = ps.at(-1) ?? null;
  const lastOk = [...ps].reverse().find((p) => p.status === "SUCCESS") ?? null;
  const commits = repo.commits.filter((c) => c.branch === branch);
  const idx = lastOk ? commits.findIndex((c) => c.sha === lastOk.sha) : -1;
  return {
    repo: repo.slug, environment: env, branch,
    pipelineStatus: latest?.status ?? null, // QUEUED | RUNNING | SUCCESS | FAILED, or null if no pipeline has run
    current: lastOk && { sha: lastOk.sha, taskRevision: lastOk.taskRevision, pipelineId: lastOk.id, deployedAt: lastOk.finishedAt },
    latestPipeline: latest,
    actions: envActions(repo, env, latest),
    service: describeService(repo, env),
    deploymentHistory: repo.services[env].history.slice(0, 10),
    taskDefinitions: repo.services[env].taskDefinitions.slice(-5).reverse(),
    deployedCommits: commits.slice(0, idx + 1).slice(-5).reverse(),
    notDeployed: commits.slice(idx + 1).reverse(),
  };
}
function deployState(repo, env, commitSha) {
  const commits = repo.commits.filter((c) => c.branch === BRANCH_FOR_ENV[env]);
  const i = commits.findIndex((c) => c.sha === commitSha);
  const ps = repo.pipelines.filter((p) => p.environment === env && commits.findIndex((x) => x.sha === p.sha) >= i);
  const ok = ps.find((p) => p.status === "SUCCESS");
  const active = ps.find((p) => p.status === "RUNNING" || p.status === "QUEUED");
  const failed = ps.filter((p) => p.status === "FAILED").at(-1);
  const hit = ok ?? active ?? failed;
  return { state: ok ? "deployed" : active ? active.status.toLowerCase() : failed ? "failed" : "none", pipelineId: hit?.id ?? null };
}
function deploymentsFor(key) {
  const out = [];
  for (const repo of db.bitbucket.repos) for (const env of ENVS) {
    for (const c of repo.commits) {
      if (c.branch !== BRANCH_FOR_ENV[env] || c.issue !== key) continue;
      out.push({ repo: repo.slug, environment: env, sha: c.sha, ...deployState(repo, env, c.sha) });
    }
  }
  return out;
}
const slim = ({ id, name, status }) => ({ id, name, status });
function issueArtifacts(key) {
  const repos = db.bitbucket.repos;
  const prs = repos.flatMap((r) => r.pullrequests).filter((p) => p.issue === key);
  const wts = db.worktrees.filter((w) => w.issue === key);
  const seen = new Set(), branches = [];
  const add = (repo, name) => { if (!seen.has(repo + "|" + name)) { seen.add(repo + "|" + name); branches.push({ repo, name }); } };
  for (const r of repos) r.branches.filter((b) => b.issue === key).forEach((b) => add(r.slug, b.name));
  prs.forEach((p) => add(p.repo, p.source));
  wts.forEach((w) => add(w.repo, w.branch));
  const commits = repos.flatMap((r) => r.commits.filter((c) => c.issue === key || seen.has(r.slug + "|" + c.branch)).map((c) => ({ repo: r.slug, ...c })));
  return {
    branches, commits: commits.sort((a, b) => a.at.localeCompare(b.at)),
    pullRequests: prs.map((p) => ({ repo: p.repo, id: p.id, title: p.title, state: p.state })),
    worktrees: wts.map(({ id, repo, branch, path }) => ({ id, repo, branch, path })),
    sessions: db.sessions.filter((x) => x.issues.includes(key)).map(slim),
  };
}
const viewIssue = (i) => ({ ...i, deployments: deploymentsFor(i.key), spawned: db.jira.issues.filter((x) => x.spawnedFrom === i.key).map((x) => x.key), artifacts: issueArtifacts(i.key), actions: issueActions(i) });
function viewPr(p) {
  const repo = findRepo(p.repo);
  const merge = repo.commits.find((c) => c.prId === p.id && c.branch === p.destination);
  const env = ENVS.find((e) => BRANCH_FOR_ENV[e] === p.destination);
  return {
    ...p,
    actions: prActions(p),
    artifacts: {
      branch: p.source,
      commits: repo.commits.filter((c) => c.branch === p.source || c.sha === merge?.sha),
      deployment: merge && repo.role === "mine" ? { environment: env, sha: merge.sha, ...deployState(repo, env, merge.sha) } : null,
      worktrees: db.worktrees.filter((w) => w.repo === p.repo && w.branch === p.source).map(({ id, path }) => ({ id, path })),
      sessions: db.sessions.filter((x) => x.prs.some((r) => r.repo === p.repo && r.id === p.id)).map(slim),
    },
  };
}
const recordBranch = (repo, name, issue) => {
  if (Object.values(BRANCH_FOR_ENV).includes(name)) return;
  const b = repo.branches.find((x) => x.name === name);
  if (!b) repo.branches.push({ name, issue: issue ?? null, created: now() });
  else if (issue && !b.issue) b.issue = issue;
};
const branchApi = {
  list: (slug) => [...Object.values(BRANCH_FOR_ENV).map((name) => ({ name, issue: null, longLived: true })), ...findRepo(slug).branches],
  create: (slug, b) => {
    const repo = findRepo(slug);
    const name = str(b.name, "name", { required: true, max: 200 });
    const issue = str(b.issue, "issue", { max: 50 });
    if (issue) findIssue(issue);
    if (Object.values(BRANCH_FOR_ENV).includes(name) || repo.branches.some((x) => x.name === name)) throw new HttpError(400, `Branch ${name} already exists`);
    const br = { name, issue: issue ?? null, created: now() };
    repo.branches.push(br);
    save();
    return br;
  },
  commit: (slug, b) => {
    const repo = findRepo(slug);
    const branch = str(b.branch, "branch", { required: true, max: 200 });
    if (Object.values(BRANCH_FOR_ENV).includes(branch)) throw new HttpError(400, `${branch} only gets commits through merged PRs`);
    const br = repo.branches.find((x) => x.name === branch);
    if (!br) throw new HttpError(400, `Branch ${branch} isn't recorded in ${slug} yet`);
    const issue = str(b.issue, "issue", { max: 50 }) ?? br.issue;
    if (issue) findIssue(issue);
    const c = { sha: sha(), branch, message: str(b.message, "message", { required: true, max: 500 }), prId: null, issue: issue ?? null, author: actor(b), at: now() };
    repo.commits.push(c);
    save();
    return c;
  },
};
const mineRepo = (slug) => {
  const r = findRepo(slug);
  if (r.role !== "mine") throw new HttpError(400, `${slug} is review-only for you: no environments or deploys are tracked`);
  return r;
};
const allEnvs = () => db.bitbucket.repos.filter((r) => r.role === "mine").flatMap((r) => ENVS.map((e) => envView(r, e)));
const deployApi = {
  run: (slug, b) => {
    const repo = mineRepo(slug);
    const env = oneOf(b.environment, ENVS, "environment");
    const head = repo.commits.filter((c) => c.branch === BRANCH_FOR_ENV[env]).at(-1);
    if (!head) throw new HttpError(400, `Nothing has been merged to ${BRANCH_FOR_ENV[env]} yet`);
    return startPipeline(repo, env, head.sha, "manual", !b.autoSwitch);
  },
  switch: (slug, id) => {
    const p = findPipeline(slug, id); if (!p.held) throw new HttpError(400, "This pipeline isn't waiting for the switch");
    p.released = true; p.held = false; const next = p.steps.find((x) => x.status === "PENDING"); next.status = "RUNNING"; next.startedAt = now(); save(); return p;
  },
  fail: (slug, id) => {
    const p = findPipeline(slug, id);
    if (p.status !== "RUNNING") throw new HttpError(400, `Pipeline is ${p.status}, only a RUNNING pipeline can be failed`);
    if (p.steps.find((st) => st.status === "RUNNING")?.name === WAIT_STEP) failEcsDeployment(findRepo(slug).services[p.environment], p);
    for (const st of p.steps) {
      if (st.status === "RUNNING") { st.status = "FAILED"; st.finishedAt = now(); }
      else if (st.status === "PENDING") st.status = "SKIPPED";
    }
    p.status = "FAILED"; p.finishedAt = now();
    save();
    return p;
  },
};


// ---------- local (my laptop): git worktrees + their docker stacks ----------
// Recorded by hand. Just a record of what exists locally and what it is linked to.
function worktreeView(w) {
  const pr = findRepo(w.repo).pullrequests.filter((p) => p.source === w.branch).at(-1) ?? null;
  const issue = w.issue ? db.jira.issues.find((i) => i.key === w.issue) : null;
  const slug = String(w.issue || w.branch).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { ...w, url: w.url ?? `http://${slug}.${w.repo}.localhost`, pr: pr && { id: pr.id, state: pr.state, title: pr.title }, issueStatus: issue?.status ?? null, sessions: db.sessions.filter((x) => x.worktree === w.id).map(slim), actions: worktreeActions(w) };
}
const findWt = (id) => {
  const w = db.worktrees.find((x) => x.id === id);
  if (!w) throw new HttpError(404, `Worktree ${id} not found`);
  return w;
};
const dockerOf = (b, cur = { status: "none", port: null }) => ({
  status: b.dockerStatus !== undefined ? oneOf(b.dockerStatus, DOCKER_STATES, "dockerStatus") : cur.status,
  port: b.dockerPort !== undefined ? str(b.dockerPort, "dockerPort", { max: 20 }) ?? null : cur.port,
});
const local = {
  list: () => db.worktrees.map(worktreeView),
  create: (b) => {
    const repo = findRepo(str(b.repo, "repo", { required: true }));
    const issue = str(b.issue, "issue", { max: 50 });
    if (issue) findIssue(issue);
    const w = {
      id: `wt-${db.nextWorktreeId++}`, repo: repo.slug,
      branch: str(b.branch, "branch", { required: true, max: 200 }),
      path: str(b.path, "path", { required: true, max: 500 }),
      issue: issue ?? null, docker: dockerOf(b), notes: str(b.notes, "notes", { max: 1000 }) ?? "", created: now(),
    };
    db.worktrees.push(w);
    recordBranch(repo, w.branch, w.issue);
    save();
    return worktreeView(w);
  },
  patch: (id, b) => {
    const w = findWt(id);
    if (b.branch !== undefined) w.branch = str(b.branch, "branch", { required: true, max: 200 });
    if (b.path !== undefined) w.path = str(b.path, "path", { required: true, max: 500 });
    if (b.issue !== undefined) { const k = str(b.issue, "issue", { max: 50 }); if (k) findIssue(k); w.issue = k ?? null; }
    if (b.notes !== undefined) w.notes = str(b.notes, "notes", { max: 1000 }) ?? "";
    w.docker = dockerOf(b, w.docker);
    save();
    return worktreeView(w);
  },
  remove: (id) => { findWt(id); db.worktrees = db.worktrees.filter((x) => x.id !== id); save(); return { deleted: id }; },
};


// ---------- claude sessions: also local, also tied to a ticket (or a whole Feature), sometimes worth keeping alive ----------
const findSession = (id) => {
  const x = db.sessions.find((v) => v.id === id);
  if (!x) throw new HttpError(404, `Session ${id} not found`);
  return x;
};
function sessionView(x) {
  return {
    ...x,
    actions: sessionActions(x),
    resume: x.sessionId ? `claude --resume ${x.sessionId}` : null,
    issues: x.issues.map((k) => { const i = db.jira.issues.find((v) => v.key === k); return { key: k, type: i?.type ?? null, status: i?.status ?? null, title: i?.title ?? null }; }),
    prs: x.prs.map((r) => { const p = db.bitbucket.repos.find((v) => v.slug === r.repo)?.pullrequests.find((v) => v.id === r.id); return { ...r, state: p?.state ?? null, title: p?.title ?? null }; }),
  };
}
const bool = (v, f) => { if (typeof v !== "boolean") throw new HttpError(400, `${f} must be true or false`); return v; };
const keyList = (v, f) => {
  if (!Array.isArray(v)) throw new HttpError(400, `${f} must be an array of ticket keys`);
  return [...new Set(v.map((k) => { if (typeof k !== "string") throw new HttpError(400, `${f}: keys must be strings`); findIssue(k); return k; }))];
};
const prList = (v, f) => {
  if (!Array.isArray(v)) throw new HttpError(400, `${f} must be an array like ["impact#2"]`);
  const out = new Map();
  for (const ref of v) {
    const m = typeof ref === "string" && /^([^#]+)#(\d+)$/.exec(ref);
    if (!m) throw new HttpError(400, `${f}: "${ref}" isn't repo#number`);
    findPr(m[1], m[2]);
    out.set(ref, { repo: m[1], id: Number(m[2]) });
  }
  return [...out.values()];
};
const worktreeRef = (v) => { const w = str(v, "worktree", { max: 50 }); if (w) findWt(w); return w ?? null; };
// Read-only tail of a real Claude Code transcript (~/.claude/projects/*/<sessionId>.jsonl). Local data: only our own frontend origin may ask.
const transcript = (id) => {
  if (REQ_ORIGIN && !/^http:\/\/(localhost|127\.0\.0\.1):4020$/.test(REQ_ORIGIN)) throw new HttpError(403, "Transcripts are only served to the local frontend");
  const x = findSession(id);
  if (!x.sessionId || !/^[0-9a-fA-F-]{8,64}$/.test(x.sessionId)) return { messages: [], note: "No Claude session id linked yet." };
  const root = path.join(os.homedir(), ".claude", "projects"); let file = null;
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, x.sessionId + ".jsonl"); if (fs.existsSync(f)) { file = f; break; } } } catch {}
  if (!file) return { messages: [], note: "No transcript found on this machine for that session id." };
  const size = fs.statSync(file).size, len = Math.min(size, 400000), buf = Buffer.alloc(len), fd = fs.openSync(file, "r");
  fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
  const out = [];
  for (const l of buf.toString("utf8").split("\n").slice(size > len ? 1 : 0)) {
    if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    if (!["user", "assistant"].includes(j.type)) continue;
    const c = j.message?.content, parts = typeof c === "string" ? [c] : Array.isArray(c) ? c.map((q) => q.type === "text" ? q.text : q.type === "tool_use" ? `🔧 ${q.name}` : q.type === "tool_result" ? "↳ result" : "").filter(Boolean) : [];
    if (parts.length) out.push({ role: j.type, at: j.timestamp, text: parts.join("\n").slice(0, 600) });
  }
  return { messages: out.slice(-16), file: path.basename(file), mtime: fs.statSync(file).mtime };
};
const sessions = {
  list: () => db.sessions.map(sessionView),
  create: (b) => {
    const x = {
      id: `sess-${db.nextSessionId++}`, name: str(b.name, "name", { required: true, max: 200 }),
      sessionId: str(b.sessionId, "sessionId", { max: 100 }) ?? null,
      issues: keyList(b.issues ?? [], "issues"), prs: prList(b.prs ?? [], "prs"), worktree: worktreeRef(b.worktree),
      longLived: b.longLived === undefined ? false : bool(b.longLived, "longLived"),
      status: b.status ? oneOf(b.status, SESSION_STATES, "status") : "active",
      notes: str(b.notes, "notes", { max: 2000 }) ?? "", created: now(),
    };
    db.sessions.push(x);
    save();
    return sessionView(x);
  },
  patch: (id, b) => {
    const x = findSession(id);
    if (b.name !== undefined) x.name = str(b.name, "name", { required: true, max: 200 });
    if (b.sessionId !== undefined) x.sessionId = str(b.sessionId, "sessionId", { max: 100 }) ?? null;
    if (b.issues !== undefined) x.issues = keyList(b.issues, "issues");
    if (b.prs !== undefined) x.prs = prList(b.prs, "prs");
    if (b.addIssue) x.issues = [...new Set([...x.issues, ...keyList([b.addIssue], "addIssue")])];
    if (b.addPr) { const have = new Set(x.prs.map((r) => `${r.repo}#${r.id}`)); x.prs = [...x.prs, ...prList([b.addPr], "addPr").filter((r) => !have.has(`${r.repo}#${r.id}`))]; }
    if (b.worktree !== undefined) x.worktree = worktreeRef(b.worktree);
    if (b.longLived !== undefined) x.longLived = bool(b.longLived, "longLived");
    if (b.status !== undefined) x.status = oneOf(b.status, SESSION_STATES, "status");
    if (b.notes !== undefined) x.notes = str(b.notes, "notes", { max: 2000 }) ?? "";
    if (b.heartbeat) x.lastSeen = now();
    save();
    return sessionView(x);
  },
  remove: (id) => { findSession(id); db.sessions = db.sessions.filter((v) => v.id !== id); save(); return { deleted: id }; },
};


// ---------- actions: what can be done to each thing right now ----------
// Plain descriptors, so any front-end can render them. Each one is a manual click that records a fact; nothing is automatic.
// "{name}" in a path is filled from the input of that name.
const act = (name, label, method, path, extra = {}) => ({ name, label, method, path, ...extra });
const userOptions = (blank, exclude = []) => [...(blank ? [{ value: "", label: blank }] : []), ...db.users.filter((u) => !exclude.includes(u.id)).map((u) => ({ value: u.id, label: u.name }))];
const repoOptions = () => db.bitbucket.repos.filter((r) => r.role === "mine").map((r) => ({ value: r.slug, label: r.slug }));
const PR_LABELS = {
  "DRAFT>OPEN": "Mark ready for review", "DRAFT>DECLINED": "Decline",
  "OPEN>APPROVED": "Approve", "OPEN>CHANGES_REQUESTED": "Request changes", "OPEN>DECLINED": "Decline", "OPEN>DRAFT": "Convert to draft",
  "CHANGES_REQUESTED>OPEN": "Re-request review", "CHANGES_REQUESTED>DECLINED": "Decline",
  "APPROVED>MERGED": "Merge", "APPROVED>CHANGES_REQUESTED": "Request changes", "APPROVED>DECLINED": "Decline",
};
const text = (name, label, value) => ({ name, label, kind: "text", ...(value ? { value } : {}) });
const select = (name, label, options) => ({ name, label, kind: "select", options });
function issueActions(i) {
  const path = `/jira/issues/${i.key}`;
  const out = ISSUE_TRANSITIONS[i.status].map((to) => act(`move:${to}`, `Move to ${to}`, "PATCH", path, { body: { status: to } }));
  out.push(act("assign", "Assign", "PATCH", path, { inputs: [select("assignee", "Assign to", userOptions("(unassigned)"))] }));
  out.push(act("comment", "Comment", "POST", `${path}/comments`, { inputs: [text("body", "Comment")] }));
  if (i.type === "Spike") {
    for (const t of ["Story", "Defect"]) out.push(act(`convert:${t}`, `Convert to ${t}`, "PATCH", path, { body: { type: t } }));
    out.push(act("spawn", "Spawn a ticket", "POST", "/jira/issues", { body: { spawnedFrom: i.key }, inputs: [text("title", "Title"), select("type", "Type", ["Story", "Defect"].map((v) => ({ value: v, label: v })))] }));
  }
  if (i.type === "Feature") out.push(act("child", "Add a child ticket", "POST", "/jira/issues", { body: { parent: i.key }, inputs: [text("title", "Title"), select("type", "Type", ["Story", "Defect", "Spike"].map((v) => ({ value: v, label: v })))] }));
  else out.push(act("openPr", "Open a PR", "POST", "/bitbucket/repos/{repo}/pullrequests", { body: { issue: i.key }, inputs: [select("repo", "Repo", repoOptions()), text("title", "PR title", `${i.key} ${i.title}`), text("source", "Source branch", `${i.type === "Defect" ? "fix" : "feat"}/${i.key.toLowerCase()}`), select("destination", "Into", Object.values(BRANCH_FOR_ENV).map((v) => ({ value: v, label: v })))] }));
  return out;
}
// The author drives a PR forward; everyone else on it is a reviewer: approve, request changes, decline, comment.
const AUTHOR_MOVES = new Set(["DRAFT>OPEN", "DRAFT>DECLINED", "OPEN>DRAFT", "OPEN>DECLINED", "CHANGES_REQUESTED>OPEN", "CHANGES_REQUESTED>DECLINED", "APPROVED>MERGED", "APPROVED>DECLINED"]);
const REVIEWER_MOVES = new Set(["OPEN>APPROVED", "OPEN>CHANGES_REQUESTED", "OPEN>DECLINED", "APPROVED>CHANGES_REQUESTED", "APPROVED>DECLINED", "CHANGES_REQUESTED>DECLINED"]);
function prActions(p) {
  const path = `/bitbucket/repos/${p.repo}/pullrequests/${p.id}`;
  const isAuthor = p.author === viewer();
  const allowed = isAuthor ? AUTHOR_MOVES : REVIEWER_MOVES;
  const out = PR_TRANSITIONS[p.state].filter((to) => allowed.has(`${p.state}>${to}`)).map((to) => act(`move:${to}`, PR_LABELS[`${p.state}>${to}`], "PATCH", path, { body: { state: to } }));
  if (isAuthor && !["MERGED", "DECLINED"].includes(p.state)) {
    out.push(act("reviewer", "Add reviewer", "PATCH", path, { inputs: [select("addReviewer", "Reviewer", userOptions(null, [p.author, ...p.reviewers]))] }));
    out.push(act("commit", "Record a commit", "POST", `/bitbucket/repos/${p.repo}/commits`, { body: { branch: p.source, issue: p.issue ?? undefined }, inputs: [text("message", "Commit message")] }));
  }
  if (!["MERGED", "DECLINED"].includes(p.state)) for (const [c, label] of [["running", "CI started"], ["passed", "CI passed"], ["failed", "CI failed"]]) if ((p.checks || "none") !== c) out.push(act(`ci:${c}`, label, "PATCH", path, { body: { checks: c }, mock: true }));
  out.push(act("comment", "Comment", "POST", `${path}/comments`, { inputs: [text("body", "Comment")] }));
  return out;
}
function envActions(repo, env, latest) {
  const out = [act("deploy", "Run deploy", "POST", `/bitbucket/repos/${repo.slug}/pipelines`, { body: { environment: env } })];
  if (latest?.status === "RUNNING") out.push(act("fail", "Simulate a failure", "POST", `/bitbucket/repos/${repo.slug}/pipelines/${latest.id}/fail`, { mock: true }));
  return out;
}
function worktreeActions(w) {
  const path = `/local/worktrees/${w.id}`;
  const out = [];
  if (w.docker.status !== "running") out.push(act("dockerUp", "Start docker", "PATCH", path, { body: { dockerStatus: "running" } }));
  if (w.docker.status === "running") out.push(act("dockerStop", "Stop docker", "PATCH", path, { body: { dockerStatus: "stopped" } }));
  if (w.docker.status !== "none") out.push(act("dockerGone", "Remove docker stack", "PATCH", path, { body: { dockerStatus: "none" } }));
  out.push(act("link", "Link to ticket", "PATCH", path, { inputs: [text("issue", "Ticket key")] }));
  out.push(act("remove", "Remove record", "DELETE", path));
  return out;
}
function sessionActions(x) {
  const path = `/local/sessions/${x.id}`;
  const set = (status, label) => act(`status:${status}`, label, "PATCH", path, { body: { status } });
  const out = x.status === "archived" ? [set("idle", "Unarchive")] : [x.status === "active" ? set("idle", "Mark idle") : set("active", "Mark active"), set("archived", "Archive")];
  out.push(act("longLived", x.longLived ? "Unmark long-lived" : "Mark long-lived", "PATCH", path, { body: { longLived: !x.longLived } }));
  out.push(act("linkIssue", "Link ticket", "PATCH", path, { inputs: [text("addIssue", "Ticket key")] }));
  out.push(act("linkPr", "Link PR", "PATCH", path, { inputs: [text("addPr", "PR (repo#number)")] }));
  out.push(act("remove", "Remove record", "DELETE", path));
  return out;
}

// ---------- routes ----------

// ---------- shared world: where rooms stand, queued orders, who is doing what, work priorities, roster, tallies ----------
// Everything the UI used to keep in the browser. Orders are the only way a change happens: a worker claims one, goes there, and finishing it runs the action here.
function dispatch(method, pathname, body = {}, query = new URLSearchParams()) {
  for (const r of routes) {
    const m = r.re.exec(pathname); if (!m || r.method !== method) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const out = r.fn(params, body, query);
    return Array.isArray(out) && typeof out[0] === "number" ? out : [200, out];
  }
  throw new HttpError(404, `No route for ${method} ${pathname}`);
}
db.world.log ??= []; db.world.drops ??= []; db.world.reviews ??= []; db.world.pickups ??= []; db.world.nextDropId ??= 1;
const dayKey = () => new Date().toDateString();
const findOrder = (id) => { const o = db.world.orders.find((x) => x.id === id); if (!o) throw new HttpError(404, `Order ${id} not found (already done?)`); return o; };
const world = {
  get: () => ({ ...db.world, today: dayKey(), doneToday: db.world.done[dayKey()] ?? 0 }),
  settings(b) {
    const w = db.world;
    if ("hand" in b) w.hand = b.hand ?? null;
    if (b.work && typeof b.work === "object") w.work = b.work;
    if (b.roster && typeof b.roster === "object") w.roster = { humans: b.roster.humans ?? {}, mechs: b.roster.mechs ?? {} };
    save(); return world.get();
  },
  setPlot(key, b) { const x = Number(b.x), y = Number(b.y); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, "x and y must be numbers"); db.world.plots[key] = { x, y }; save(); return db.world.plots[key]; },
  delPlot(key) { delete db.world.plots[key]; save(); return { deleted: key }; },
  addOrder(b) {
    const a = b.a; if (!a || typeof a.path !== "string" || typeof a.method !== "string") throw new HttpError(400, "order needs an action {method, path}");
    const same = db.world.orders.find((o) => o.key === b.key && o.a.method === a.method && o.a.path === a.path && JSON.stringify(o.a.body || {}) === JSON.stringify(a.body || {}));
    if (same) return same;
    const o = { id: `o${db.world.nextOrderId++}`, label: str(b.label, "label", { required: true, max: 200 }), key: str(b.key, "key", { required: true, max: 100 }), type: b.type || "build", dur: Number(b.dur) || 3, carry: b.carry || null, workerKind: ["mech", "human"].includes(b.workerKind) ? b.workerKind : null, bill: b.bill ?? null, then: Array.isArray(b.then) ? b.then.slice(0, 4).map((t) => ({ label: String(t.label || ""), type: t.type || "build", dur: Number(t.dur) || 3, a: t.a })) : [], a: { name: a.name, label: a.label, method: a.method, path: a.path, body: a.body || {} }, worker: null, created: now() };
    db.world.orders.push(o); save(); return o;
  },
  patchOrder(id, b) {
    const o = findOrder(id);
    if ("worker" in b) { if (b.worker && o.worker && o.worker !== b.worker) throw new HttpError(409, `Order already claimed by ${o.worker}`); o.worker = b.worker ?? null; }
    save(); return o;
  },
  cancel(id) { findOrder(id); db.world.orders = db.world.orders.filter((o) => o.id !== id); save(); return { cancelled: id }; },
  // the worker has arrived and finished: now (and only now) the change is made
  complete(id, b = {}) {
    const o = findOrder(id); db.world.orders = db.world.orders.filter((x) => x.id !== id);
    let result = null, error = null;
    try {
      const body = { ...(o.a.body || {}) }; // fill "{name}" placeholders in the path from the body, as the action descriptors intend
      const apath = o.a.path.replace(/\{(\w+)\}/g, (_m, k) => { const v = body[k]; delete body[k]; return encodeURIComponent(v); });
      const [, out] = dispatch(o.a.method, apath, body);
      result = out;
      if (o.a.method === "POST" && o.a.path === "/local/worktrees" && out?.id) // Claude already started on this ticket moves into the new room
        for (const x of db.sessions) if (x.status !== "archived" && !x.worktree && x.issues.includes(o.a.body?.issue)) x.worktree = out.id;
      if (out?.id) for (const t of o.then || []) world.addOrder({ ...t, key: "wt:" + out.id, a: { ...t.a, path: String(t.a.path).replace("{wt}", out.id) } }); // what follows once this is built
    } catch (e) { if (e instanceof HttpError) error = e.message; else throw e; }
    db.world.done[dayKey()] = (db.world.done[dayKey()] ?? 0) + (error ? 0 : 1);
    db.world.log.unshift({ at: now(), worker: typeof b.worker === "string" ? b.worker : null, label: o.label, ok: !error, error, bill: o.bill ?? null });
    db.world.log.length = Math.min(db.world.log.length, 200);
    save(); return { id, ok: !error, error, label: o.label };
  },
  // A quest accepted: a ship will bring it. Landing is when the ticket becomes real work, and the workshop sets itself up.
  drop(b) {
    if (b.kind === "review") {
      const key = str(b.key, "key", { required: true, max: 80 }), m = /^([^#]+)#(\d+)$/.exec(key); if (!m) throw new HttpError(400, "A review key looks like repo#number");
      const pr = findPr(m[1], m[2]); if (pr.state !== "OPEN" || !pr.reviewers.includes(viewer())) throw new HttpError(400, `${key} isn't waiting for your review`);
      if (db.world.reviews.some((r) => r.key === key && !r.done) || db.world.drops.some((d) => d.key === key)) throw new HttpError(400, `${key} is already accepted`);
      const d = { id: `d${db.world.nextDropId++}`, kind: "review", key, mode: b.mode === "claude" ? "claude" : "me", at: now() }; db.world.drops.push(d); save(); return d;
    }
    const key = str(b.key, "key", { required: true, max: 50 }), i = findIssue(key);
    if (i.status !== "Next") throw new HttpError(400, `${key} isn't waiting any more`);
    if (db.world.drops.some((d) => d.key === key)) throw new HttpError(400, `${key} is already on its way`);
    const d = { id: `d${db.world.nextDropId++}`, key, mode: b.mode === "claude" ? "claude" : "me", at: now() };
    db.world.drops.push(d); save(); return d;
  },
  land(id) {
    const d = db.world.drops.find((x) => x.id === id); if (!d) throw new HttpError(404, `Drop ${id} not found (already landed?)`);
    db.world.drops = db.world.drops.filter((x) => x.id !== id);
    if (d.kind === "review") {
      db.world.reviews.push({ key: d.key, mode: d.mode, at: now(), done: false });
      if (d.mode === "claude") sessions.create({ name: `Review ${d.key}`, prs: [d.key], notes: `ref:review:${d.key}`, status: "active" });
      db.world.log.unshift({ at: now(), worker: null, label: `Accepted review ${d.key} — ${d.mode === "claude" ? "Claude pre-reviews it" : "you review it"}`, ok: true, bill: null }); db.world.log.length = Math.min(db.world.log.length, 200); save(); return { landed: d.key };
    }
    const i = findIssue(d.key); dispatch("PATCH", `/jira/issues/${d.key}`, { status: "Dev WIP" });
    if (d.mode === "claude") sessions.create({ name: `${d.key} ${i.title}`.slice(0, 190), issues: [d.key], notes: `ref:bp:${d.key}`, status: "active" });
    world.addOrder({ label: `Build room · ${d.key}`, key: `bp:${d.key}`, type: "build", dur: 8, a: { name: "buildRoom", label: "Build room", method: "POST", path: "/local/worktrees", body: { repo: "impact", branch: `feat/${d.key.toLowerCase()}`, path: `~/work/impact-wt/${d.key}`, issue: d.key, dockerStatus: "none" } },
      then: [{ label: `Start docker · ${d.key}`, type: "build", dur: 3, a: { name: "dockerUp", label: "Start docker", method: "PATCH", path: "/local/worktrees/{wt}", body: { dockerStatus: "running" } } }] });
    db.world.log.unshift({ at: now(), worker: null, label: `Accepted ${d.key} — ${d.mode === "claude" ? "Claude takes it" : "you work on it"}`, ok: true, bill: null }); db.world.log.length = Math.min(db.world.log.length, 200);
    save(); return { landed: d.key };
  },
  // A quest completed: once its work is merged, a ship comes back for it. Collecting is when the ticket is Done and the workshop is taken down.
  pickup(b) {
    if (b.kind === "review") {
      const key = String(b.key), r = db.world.reviews.find((x) => x.key === key && !x.done), m = /^([^#]+)#(\d+)$/.exec(key); if (!r || !m) throw new HttpError(404, `${key} isn't an accepted review`);
      if (findPr(m[1], m[2]).state === "OPEN") throw new HttpError(400, "Make your decision first: approve, request changes or decline");
      if (db.world.pickups.some((u) => u.key === key)) throw new HttpError(400, `A ship is already on its way for ${key}`);
      const u = { id: `u${db.world.nextDropId++}`, kind: "review", key, at: now() }; db.world.pickups.push(u); save(); return u;
    }
    const key = str(b.key, "key", { required: true, max: 50 }), i = findIssue(key), wt = db.worktrees.find((w) => w.issue === key);
    const pr = wt ? findRepo(wt.repo).pullrequests.filter((p) => p.source === wt.branch && p.destination === "develop" && p.state !== "DECLINED").at(-1) : null;
    if (!["Dev WIP", "Dev Done", "Verification"].includes(i.status)) throw new HttpError(400, `${key} isn't in progress`);
    if (pr?.state !== "MERGED") throw new HttpError(400, `${key} isn't finished: its PR has to be merged first`);
    if (!images().some((m) => m.prId === pr.id && m.pushed)) throw new HttpError(400, `${key} isn't finished: its image hasn't been pushed to ECR yet`);
    if (db.world.pickups.some((u) => u.key === key)) throw new HttpError(400, `A ship is already on its way for ${key}`);
    const u = { id: `u${db.world.nextDropId++}`, key, at: now() }; db.world.pickups.push(u); save(); return u;
  },
  collect(id) {
    const u = db.world.pickups.find((x) => x.id === id); if (!u) throw new HttpError(404, `Pickup ${id} not found (already collected?)`);
    db.world.pickups = db.world.pickups.filter((x) => x.id !== id);
    if (u.kind === "review") {
      const r = db.world.reviews.find((x) => x.key === u.key && !x.done); if (r) { r.done = true; r.doneAt = now(); }
      for (const x of db.sessions) if (x.prs.some((q) => `${q.repo}#${q.id}` === u.key) && x.status !== "archived") x.status = "archived";
      db.world.orders = db.world.orders.filter((o) => o.key !== "pr:" + u.key);
      db.world.log.unshift({ at: now(), worker: null, label: `Review ${u.key} done — the ship collected the package`, ok: true, bill: null }); db.world.log.length = Math.min(db.world.log.length, 200); save(); return { collected: u.key };
    }
    const i = findIssue(u.key), order = ["Dev WIP", "Dev Done", "Verification", "Done"];
    for (const st of order.slice(order.indexOf(i.status) + 1)) dispatch("PATCH", `/jira/issues/${u.key}`, { status: st });
    for (const w of db.worktrees.filter((x) => x.issue === u.key)) { dispatch("PATCH", `/local/worktrees/${w.id}`, { dockerStatus: "none" }); dispatch("DELETE", `/local/worktrees/${w.id}`); }
    for (const x of db.sessions) if (x.issues.includes(u.key) && x.status !== "archived") x.status = "archived";
    for (const o of db.world.orders.filter((x) => x.key === "wt:" + (db.worktrees.find((w) => w.issue === u.key)?.id ?? "-"))) db.world.orders = db.world.orders.filter((y) => y !== o);
    db.world.log.unshift({ at: now(), worker: null, label: `Completed ${u.key} — the ship collected it`, ok: true, bill: null }); db.world.log.length = Math.min(db.world.log.length, 200);
    save(); return { collected: u.key };
  },
  bread() { db.world.bread++; save(); return { bread: db.world.bread }; },
  done() { db.world.done[dayKey()] = (db.world.done[dayKey()] ?? 0) + 1; save(); return world.get(); },
};

// ---------- releases: a bench with a bill. Branches are ingredients; the release is built once every one is ready ----------
// Staging is always `develop`. A release either ships all of develop ("develop" mode: develop is 100% releasable, merge it straight in)
// or is a fresh release/<name> branch holding only the chosen branches ("branch" mode). Develop may hold extra work: that's flagged as extras.
const findRel = (id) => { const r = db.releases.find((x) => x.id === id); if (!r) throw new HttpError(404, `Release ${id} not found`); return r; };
const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-|-$/g, "");
const prForBranch = (repo, branch) => repo.pullrequests.filter((p) => p.source === branch && p.destination === "develop").at(-1) ?? null;
const shippedIds = (slug) => new Set(db.releases.filter((x) => x.repo === slug && x.status === "built").flatMap((x) => x.shipped || []));
function releaseItem(pr, name) {
  const issue = pr?.issue ? db.jira.issues.find((i) => i.key === pr.issue) : null;
  const ing = { added: true, ci: pr?.checks === "passed", approved: !!pr && ["APPROVED", "MERGED"].includes(pr.state), merged: pr?.state === "MERGED", verified: issue ? issue.status === "Done" : null };
  return { branch: pr?.source ?? name, author: pr?.author ?? null, issue: pr?.issue ?? null, title: pr?.title ?? null, pr: pr && { id: pr.id, state: pr.state, checks: pr.checks || "none" }, ingredients: ing };
}
const MISSING = { ci: "CI to pass", approved: "approval", merged: "merging to develop", verified: "verification on staging" };
// The automatic "next release": there is always one. Every PR to develop joins it by itself, each gets its ingredients as it goes,
// and the system proposes the shape: ship all of develop when every merged PR is verified, otherwise cut a release branch with only the verified ones.
function ensureAuto() {
  for (const repo of db.bitbucket.repos.filter((x) => x.role === "mine")) {
    if (db.releases.some((x) => x.auto && x.status === "planning" && x.repo === repo.slug)) continue;
    const last = db.releases.filter((x) => x.repo === repo.slug && x.status === "built").at(-1), m = last && /^(\d+)\.(\d+)$/.exec(last.name);
    db.releases.push({ id: `rel-${db.nextReleaseId++}`, name: m ? `${m[1]}.${+m[2] + 1}` : last ? `${last.name}+` : "1.1", target: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), mode: "auto", auto: true, repo: repo.slug, branches: [], exclude: [], status: "planning", created: now() });
    save();
  }
}
function autoView(r) {
  const repo = findRepo(r.repo), shipped = shippedIds(r.repo), excl = new Set(r.exclude || []);
  const items = repo.pullrequests.filter((p) => p.destination === "develop" && p.state !== "DECLINED" && !shipped.has(p.id)).map((p) => releaseItem(p));
  const full = (i) => Object.values(i.ingredients).every((v) => v !== false);
  for (const i of items) i.fate = !i.ingredients.merged ? "progress" : excl.has(i.branch) || !full(i) ? "held" : "in";
  const merged = items.filter((i) => i.ingredients.merged), risky = merged.filter((i) => i.fate === "held");
  const mode = risky.length === 0 && merged.length > 0 ? "develop" : "branch", inc = items.filter((i) => i.fate === "in");
  const why = (i) => excl.has(i.branch) ? "held back by you" : i.fate === "progress" && !i.ingredients.merged && Object.entries(MISSING).filter(([k]) => k !== "merged" && i.ingredients[k] === false).length === 0 ? "waiting to be merged" : Object.entries(MISSING).filter(([k]) => i.ingredients[k] === false).map(([, t]) => t).join(", ");
  const waiting = items.filter((i) => i.fate !== "in").map((i) => `${i.branch}: ${why(i) || "in progress"}`);
  const days = r.target ? (Date.parse(r.target + "T12:00") - Date.now()) / 864e5 : null;
  const extras = risky.map((i) => ({ sha: null, message: i.title, prId: i.pr.id, issue: i.issue, author: i.author, branch: i.branch }));
  return { ...r, mode, proposal: mode, items, extras, waiting, ready: inc.length > 0, atRisk: days !== null && days <= 1 && waiting.length > 0, include: inc.map((i) => i.branch), held: risky.map((i) => i.branch) };
}
function releaseView(r) {
  if (r.auto && r.status === "planning") return autoView(r);
  const repo = findRepo(r.repo), shipped = shippedIds(r.repo), prById = (id) => repo.pullrequests.find((p) => p.id === id);
  const unreleased = repo.commits.filter((c) => c.branch === "develop" && c.prId && !shipped.has(c.prId)).map((c) => ({ c, pr: prById(c.prId) })).filter((x) => x.pr);
  let items;
  if (r.status === "built") items = (r.shipped || []).map(prById).filter(Boolean).map((p) => releaseItem(p));
  else if (r.mode === "develop") items = unreleased.map((x) => releaseItem(x.pr));
  else items = r.branches.map((n) => releaseItem(prForBranch(repo, n), n));
  const inc = new Set(items.map((i) => i.pr?.id).filter(Boolean));
  const extras = r.status === "planning" && r.mode === "branch" ? unreleased.filter((x) => !inc.has(x.pr.id)).map((x) => ({ sha: x.c.sha, message: x.c.message, prId: x.pr.id, issue: x.c.issue, author: x.c.author, branch: x.pr.source })) : [];
  const waiting = r.status === "planning" ? items.flatMap((i) => Object.entries(MISSING).filter(([k]) => i.ingredients[k] === false).map(([k, t]) => `${i.branch} needs ${t}`)) : [];
  if (r.status === "planning" && !items.length) waiting.push(r.mode === "develop" ? "nothing on develop to release" : "no branches added yet");
  return { ...r, items, extras, waiting, ready: r.status === "planning" && !waiting.length };
}
const releases = {
  list: () => { ensureAuto(); return db.releases.map(releaseView); },
  create(b) {
    const mine = db.bitbucket.repos.find((x) => x.role === "mine");
    const r = { id: `rel-${db.nextReleaseId++}`, name: str(b.name, "name", { required: true, max: 80 }), target: str(b.target, "target", { max: 20 }) ?? null, mode: b.mode === "develop" ? "develop" : "branch", repo: b.repo || mine.slug, branches: [], status: "planning", created: now() };
    findRepo(r.repo); db.releases.push(r); save(); return releaseView(r);
  },
  patch(id, b) {
    const r = findRel(id); if (r.status !== "planning") throw new HttpError(400, "A built release can't be edited");
    if (b.name !== undefined) r.name = str(b.name, "name", { required: true, max: 80 });
    if (b.target !== undefined) r.target = str(b.target, "target", { max: 20 }) ?? null;
    if (b.mode !== undefined && !r.auto) r.mode = b.mode === "develop" ? "develop" : "branch";
    if (Array.isArray(b.exclude)) r.exclude = b.exclude.map(String);
    save(); return releaseView(r);
  },
  remove(id) { const r = findRel(id); if (r.auto) throw new HttpError(400, "The next release is automatic and can't be deleted"); if (r.status !== "planning") throw new HttpError(400, "A built release can't be deleted"); db.releases = db.releases.filter((x) => x.id !== id); save(); return { deleted: id }; },
  addBranch(id, b) {
    const r = findRel(id); if (r.status !== "planning") throw new HttpError(400, "That release is already built");
    if (r.auto) throw new HttpError(400, "The next release fills itself; hold branches back instead");
    if (r.mode !== "branch") throw new HttpError(400, "This release ships all of develop; switch it to a release branch to choose branches");
    const branch = str(b.branch, "branch", { required: true, max: 200 }), repo = findRepo(r.repo);
    if (!repo.branches.some((x) => x.name === branch)) throw new HttpError(400, `Branch ${branch} isn't recorded in ${r.repo}`);
    const other = db.releases.find((x) => x.id !== id && x.status === "planning" && x.repo === r.repo && x.branches.includes(branch));
    if (other) throw new HttpError(400, `${branch} is already in ${other.name}`);
    if (!r.branches.includes(branch)) r.branches.push(branch);
    save(); return releaseView(r);
  },
  removeBranch(id, branch) { const r = findRel(id); r.branches = r.branches.filter((x) => x !== branch); save(); return releaseView(r); },
  // the worker builds it: a release branch (or develop itself) goes to master as a PR; from there it's the normal review, merge and deploy
  build(id) {
    const r = findRel(id); if (r.status !== "planning") throw new HttpError(400, "That release is already built");
    const v = releaseView(r); if (!v.ready) throw new HttpError(400, `Not ready: ${v.waiting.join("; ")}`);
    const items = r.auto ? v.items.filter((i) => i.fate === "in") : v.items, mode = r.auto ? v.mode : r.mode;
    let source = "develop";
    if (mode === "branch") {
      source = `release/${slugify(r.name)}`; branchApi.create(r.repo, { name: source });
      for (const i of items) branchApi.commit(r.repo, { branch: source, message: `Merge ${i.branch}`, issue: i.issue ?? undefined });
    }
    const pr = bb.create(r.repo, { title: `Release ${r.name}`, source, destination: "master", draft: false, description: items.map((i) => `- ${i.branch}${i.issue ? " (" + i.issue + ")" : ""}`).join("\n"), reviewers: db.users.filter((u) => u.id !== viewer()).slice(0, 1).map((u) => u.id) });
    Object.assign(r, { status: "built", releaseBranch: source, pr: { repo: r.repo, id: pr.id }, shipped: items.map((i) => i.pr.id), builtAt: now(), mode });
    save(); return releaseView(r);
  },
};

// ---------- bills: small standing jobs on a workshop (RimWorld's workbench bills). A bill never changes anything itself: when its condition holds it queues an ORDER, and a worker still has to do it. ----------
const BILL_KINDS = {
  docker: { name: "Keep docker running", mode: "forever", about: "Whenever this workshop's docker stack isn't running, queue an order to start it.", needs: "a worktree" },
  openpr: { name: "Open a draft PR once there are commits", mode: "once", about: "As soon as the branch has a commit and no PR, queue an order to open a draft PR.", needs: "at least one commit on the branch" },
  ready: { name: "Mark the PR ready when CI passes", mode: "once", about: "When the draft PR's CI has passed, queue an order to mark it ready for review.", needs: "a draft PR with CI passed" },
  merge: { name: "Merge when approved and CI passes", mode: "once", about: "When the PR is approved and CI has passed, queue an order to merge it. This sends code to develop, so it starts suspended.", needs: "an approved PR with CI passed", suspended: true },
};
function billCheck(b) {
  const w = db.worktrees.find((x) => x.id === b.wt); if (!w) return null;
  const repo = findRepo(w.repo), issue = w.issue ? db.jira.issues.find((i) => i.key === w.issue) : null;
  const pr = repo.pullrequests.filter((p) => p.source === w.branch && p.destination === "develop" && p.state !== "DECLINED").at(-1) ?? null;
  const commits = repo.commits.filter((c) => c.branch === w.branch).length, key = `wt:${w.id}`;
  const act = (name, label, method, path, body) => ({ name, label, method, path, body });
  if (b.kind === "docker") return w.docker.status !== "running" ? { key, type: "build", a: act("dockerUp", "Start docker", "PATCH", `/local/worktrees/${w.id}`, { dockerStatus: "running" }) } : false;
  if (b.kind === "openpr") return commits > 0 && !pr ? { key, type: "build", a: act("openPr", "Open draft PR", "POST", `/bitbucket/repos/${w.repo}/pullrequests`, { title: `${w.issue ? w.issue + " " : ""}${issue?.title ?? w.branch}`.slice(0, 280), source: w.branch, destination: "develop", issue: w.issue ?? undefined }) } : false;
  if (b.kind === "ready") return pr?.state === "DRAFT" && pr.checks === "passed" ? { key, type: "review", a: act("move:OPEN", "Mark ready for review", "PATCH", `/bitbucket/repos/${w.repo}/pullrequests/${pr.id}`, { state: "OPEN" }) } : false;
  if (b.kind === "merge") return pr?.state === "APPROVED" && pr.checks === "passed" ? { key, type: "deploy", a: act("move:MERGED", "Merge", "PATCH", `/bitbucket/repos/${w.repo}/pullrequests/${pr.id}`, { state: "MERGED" }) } : false;
  return false;
}
const billView = (b) => ({ ...b, ...BILL_KINDS[b.kind], mode: b.mode, state: billCheck(b) ? "ready" : "waiting" });
const bills = {
  list: (q) => db.bills.filter((b) => !q?.get("wt") || b.wt === q.get("wt")).map(billView),
  create(b) {
    const k = BILL_KINDS[b.kind]; if (!k) throw new HttpError(400, `Unknown bill kind ${b.kind}`);
    if (!db.worktrees.some((w) => w.id === b.wt)) throw new HttpError(404, "No such workshop");
    const x = { id: `bill-${db.nextBillId++}`, wt: b.wt, kind: b.kind, mode: k.mode, worker: "any", suspended: !!k.suspended, done: false, created: now() };
    db.bills.push(x); save(); return billView(x);
  },
  patch(id, b) {
    const x = db.bills.find((v) => v.id === id); if (!x) throw new HttpError(404, "No such bill");
    if (b.suspended !== undefined) x.suspended = !!b.suspended;
    if (b.mode !== undefined) { x.mode = b.mode === "forever" ? "forever" : "once"; if (x.mode === "forever") x.done = false; }
    if (b.worker !== undefined) x.worker = ["any", "mech", "human"].includes(b.worker) ? b.worker : "any";
    if (b.rearm) x.done = false;
    save(); return billView(x);
  },
  remove(id) { db.bills = db.bills.filter((x) => x.id !== id); save(); return { deleted: id }; },
  tick() {
    for (const x of db.bills) {
      if (x.suspended || x.done) continue;
      const c = billCheck(x); if (!c) continue;
      const before = db.world.orders.length;
      world.addOrder({ label: `${BILL_KINDS[x.kind].name} · ${c.key.slice(3)}`, key: c.key, type: c.type, dur: 3, a: c.a, workerKind: x.worker === "any" ? null : x.worker, bill: x.id });
      if (x.mode === "once" && db.world.orders.length > before) { x.done = true; save(); }
    }
  },
};
setInterval(() => { try { bills.tick(); } catch (e) { console.error("bills tick", e); } }, 2000).unref?.();

// ECR, as the pipelines see it: one image per pipeline run, made and pushed before anything is switched
const images = () => db.bitbucket.repos.filter((r) => r.role === "mine").flatMap((repo) => repo.pipelines.map((p) => {
  const c = repo.commits.find((x) => x.sha === p.sha), st = (n) => p.steps.find((x) => x.name === n)?.status;
  return { repo: repo.slug, pipelineId: p.id, environment: p.environment, sha: p.sha, message: c?.message ?? null, prId: c?.prId ?? null, issue: c?.issue ?? null, built: st("Build image") === "SUCCESS", pushed: st("Push image to ECR") === "SUCCESS", registered: st("Register task definition") === "SUCCESS", held: !!p.held, switched: p.status === "SUCCESS", status: p.status, taskRevision: p.taskRevision, at: p.created };
}));
const routes = [
  ["GET", "/health", () => ({ ok: true })],
  ["GET", "/meta", () => ({ issueStatuses: ISSUE_STATUSES, dockerStates: DOCKER_STATES, sessionStates: SESSION_STATES, environments: ENVS, pipelineSteps: STEPS, stepMs: STEP_MS, issueTypes: ISSUE_TYPES, prStates: PR_STATES, issueTransitions: ISSUE_TRANSITIONS, prTransitions: PR_TRANSITIONS })],
  ["GET", "/bitbucket/environments", () => allEnvs()],
  ["GET", "/bitbucket/pipelines", (_p, _b, q) => db.bitbucket.repos.flatMap((r) => r.pipelines).filter((p) => !q.get("status") || p.status === q.get("status"))],
  ["GET", "/bitbucket/repos/:repo/environments", (p) => ENVS.map((e) => envView(mineRepo(p.repo), e))],
  ["GET", "/bitbucket/repos/:repo/environments/:env/service", (p) => describeService(mineRepo(p.repo), oneOf(p.env, ENVS, "environment"))],
  ["GET", "/bitbucket/repos/:repo/environments/:env/deployments", (p) => mineRepo(p.repo).services[oneOf(p.env, ENVS, "environment")].history],
  ["GET", "/bitbucket/repos/:repo/commits", (p, _b, q) => findRepo(p.repo).commits.filter((c) => !q.get("branch") || c.branch === q.get("branch"))],
  ["POST", "/bitbucket/repos/:repo/commits", (p, b) => [201, branchApi.commit(p.repo, b)]],
  ["GET", "/bitbucket/repos/:repo/branches", (p) => branchApi.list(p.repo)],
  ["POST", "/bitbucket/repos/:repo/branches", (p, b) => [201, branchApi.create(p.repo, b)]],
  ["GET", "/bitbucket/repos/:repo/pipelines", (p) => findRepo(p.repo).pipelines],
  ["POST", "/bitbucket/repos/:repo/pipelines", (p, b) => [201, deployApi.run(p.repo, b)]],
  ["GET", "/bitbucket/repos/:repo/pipelines/:id", (p) => findPipeline(p.repo, p.id)],
  ["POST", "/bitbucket/repos/:repo/pipelines/:id/switch", (p) => deployApi.switch(p.repo, p.id)],
  ["GET", "/images", () => images()],
  ["POST", "/bitbucket/repos/:repo/pipelines/:id/fail", (p) => deployApi.fail(p.repo, p.id)],
  ["GET", "/local/worktrees", () => local.list()],
  ["POST", "/local/worktrees", (_p, b) => [201, local.create(b)]],
  ["PATCH", "/local/worktrees/:id", (p, b) => local.patch(p.id, b)],
  ["DELETE", "/local/worktrees/:id", (p) => local.remove(p.id)],
  ["GET", "/local/sessions", () => sessions.list()],
  ["GET", "/local/sessions/:id/transcript", (p) => transcript(p.id)],
  ["POST", "/local/sessions", (_p, b) => [201, sessions.create(b)]],
  ["PATCH", "/local/sessions/:id", (p, b) => sessions.patch(p.id, b)],
  ["DELETE", "/local/sessions/:id", (p) => sessions.remove(p.id)],
  ["GET", "/bills", (_p, _b, q) => bills.list(q)],
  ["POST", "/bills", (_p, b) => [201, bills.create(b)]],
  ["PATCH", "/bills/:id", (p, b) => bills.patch(p.id, b)],
  ["DELETE", "/bills/:id", (p) => bills.remove(p.id)],
  ["GET", "/releases", () => releases.list()],
  ["POST", "/releases", (_p, b) => [201, releases.create(b)]],
  ["PATCH", "/releases/:id", (p, b) => releases.patch(p.id, b)],
  ["DELETE", "/releases/:id", (p) => releases.remove(p.id)],
  ["POST", "/releases/:id/branches", (p, b) => releases.addBranch(p.id, b)],
  ["DELETE", "/releases/:id/branches/:branch", (p) => releases.removeBranch(p.id, p.branch)],
  ["POST", "/releases/:id/build", (p) => releases.build(p.id)],
  ["GET", "/world", () => world.get()],
  ["PATCH", "/world", (_p, b) => world.settings(b)],
  ["PATCH", "/world/plots/:key", (p, b) => world.setPlot(p.key, b)],
  ["DELETE", "/world/plots/:key", (p) => world.delPlot(p.key)],
  ["POST", "/world/orders", (_p, b) => [201, world.addOrder(b)]],
  ["PATCH", "/world/orders/:id", (p, b) => world.patchOrder(p.id, b)],
  ["DELETE", "/world/orders/:id", (p) => world.cancel(p.id)],
  ["POST", "/world/orders/:id/complete", (p, b) => world.complete(p.id, b)],
  ["POST", "/world/drops", (_p, b) => [201, world.drop(b)]],
  ["POST", "/world/drops/:id/land", (p) => world.land(p.id)],
  ["POST", "/world/pickups", (_p, b) => [201, world.pickup(b)]],
  ["POST", "/world/pickups/:id/collect", (p) => world.collect(p.id)],
  ["POST", "/world/bread", () => world.bread()],
  ["POST", "/world/done", () => world.done()],
  ["GET", "/me", () => db.users.find((u) => u.id === db.me)],
  ["GET", "/users", () => db.users],
  ["GET", "/bitbucket/pullrequests", (_p, _b, q) => bb.listAll(q)],
  ["GET", "/jira/issues", (_p, _b, q) => jira.list(q)],
  ["POST", "/jira/issues", (_p, b) => [201, jira.create(b)]],
  ["GET", "/jira/issues/:key", (p) => jira.get(p.key)],
  ["PATCH", "/jira/issues/:key", (p, b) => jira.patch(p.key, b)],
  ["POST", "/jira/issues/:key/comments", (p, b) => [201, jira.comment(p.key, b)]],
  ["GET", "/bitbucket/repos", () => bb.repos()],
  ["GET", "/bitbucket/repos/:repo/pullrequests", (p, _b, q) => bb.list(p.repo, q)],
  ["POST", "/bitbucket/repos/:repo/pullrequests", (p, b) => [201, bb.create(p.repo, b)]],
  ["GET", "/bitbucket/repos/:repo/pullrequests/:id", (p) => bb.get(p.repo, p.id)],
  ["PATCH", "/bitbucket/repos/:repo/pullrequests/:id", (p, b) => bb.patch(p.repo, p.id, b)],
  ["POST", "/bitbucket/repos/:repo/pullrequests/:id/comments", (p, b) => [201, bb.comment(p.repo, p.id, b)]],
].map(([method, pattern, fn]) => {
  const names = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_m, n) => (names.push(n), "([^/]+)")) + "$");
  return { method, re, names, fn };
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) { reject(new HttpError(413, "Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        const v = JSON.parse(data);
        if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
        resolve(v);
      } catch { reject(new HttpError(400, "Body must be a JSON object")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Actor",
    });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  try {
    if (req.method === "OPTIONS") return send(204);
    const url = new URL(req.url, "http://x");
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      const body = req.method === "GET" ? {} : await readBody(req);
      const hdr = String(req.headers["x-actor"] || "");
      REQ_ORIGIN = String(req.headers.origin || "");
      REQ_ACTOR = db.users.some((u) => u.id === hdr) ? hdr : null;
      let out;
      try { out = r.fn(params, body, url.searchParams); } finally { REQ_ACTOR = null; }
      return Array.isArray(out) && typeof out[0] === "number" ? send(out[0], out[1]) : send(200, out);
    }
    send(pathMatched ? 405 : 404, { error: pathMatched ? "Method not allowed" : "Not found" });
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.message });
    console.error(e);
    send(500, { error: "Internal error" });
  }
});

process.on("uncaughtException", (e) => console.error("uncaught", e));
process.on("unhandledRejection", (e) => console.error("unhandled", e));
server.listen(PORT, () => console.log(`Mock Jira+Bitbucket on http://localhost:${PORT}`));
