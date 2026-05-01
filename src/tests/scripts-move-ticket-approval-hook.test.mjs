import test from "node:test";
import assert from "node:assert";
import path from "path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";

// Import the real function from the actual module
import { updateApprovalFilesHook } from "../scripts/move-ticket.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const MOVE_TICKET_PATH = path.join(PROJECT_ROOT, "src", "scripts", "move-ticket.js");

// Helper to create a mock fs module
function createMockFs() {
  const fileStore = new Map();

  return {
    existsSync: (dir) => fileStore.has(dir),
    readdirSync: (dir) => {
      if (!fileStore.has(dir)) return [];
      const files = fileStore.get(dir);
      return files instanceof Map ? Array.from(files.keys()) : [];
    },
    readFileSync: (filePath, encoding) => {
      const dir = path.dirname(filePath);
      const file = path.basename(filePath);
      if (!fileStore.has(dir)) throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      const files = fileStore.get(dir);
      if (!files.has(file)) throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      const content = files.get(file);
      if (content instanceof Error) throw content;
      return content;
    },
    writeFileSync: (filePath, content, encoding) => {
      const dir = path.dirname(filePath);
      const file = path.basename(filePath);
      if (!fileStore.has(dir)) {
        fileStore.set(dir, new Map());
      }
      const files = fileStore.get(dir);
      files.set(file, content);
    },
    _setDir: (dir) => {
      if (!fileStore.has(dir)) {
        fileStore.set(dir, new Map());
      }
    },
    _setFile: (filePath, content) => {
      const dir = path.dirname(filePath);
      const file = path.basename(filePath);
      if (!fileStore.has(dir)) {
        fileStore.set(dir, new Map());
      }
      const files = fileStore.get(dir);
      files.set(file, content);
    },
    _getFile: (filePath) => {
      const dir = path.dirname(filePath);
      const file = path.basename(filePath);
      if (!fileStore.has(dir)) return null;
      const files = fileStore.get(dir);
      return files.has(file) ? files.get(file) : null;
    },
    _getFileStore: () => fileStore,
  };
}

// Helper to create temp workflow structure for subprocess tests
function createTempWorkflow(baseDir, { ready = [], inProgress = [], review = [], done = [], blocked = [] } = {}) {
  const workflowDir = path.join(baseDir, ".workflow");
  const ticketsDir = path.join(workflowDir, "tickets");
  const approvalsDir = path.join(workflowDir, "approvals");

  for (const dir of ["ready", "in-progress", "review", "done", "blocked", "archive", "backlog"]) {
    fs.mkdirSync(path.join(ticketsDir, dir), { recursive: true });
  }
  fs.mkdirSync(approvalsDir, { recursive: true });
  fs.mkdirSync(path.join(workflowDir, "plans", "current"), { recursive: true });

  function writeTicket(status, ticketId, extra = "") {
    const content = `---\nid: ${ticketId}\ntitle: Test ${ticketId}\npriority: 2\ntype: impl\ncreated_at: "2026-04-01T00:00:00Z"\nupdated_at: "2026-04-01T00:00:00Z"\nparent_plan: plans/current/PLAN-TEST.md\nconditions: []\ndependencies: []\ntags: []\n${extra}---\n\n## Описание\n\nTest ticket.\n`;
    fs.writeFileSync(path.join(ticketsDir, status, `${ticketId}.md`), content, "utf8");
  }

  for (const id of ready) writeTicket("ready", id);
  for (const id of inProgress) writeTicket("in-progress", id);
  for (const id of review) writeTicket("review", id);
  for (const id of done) writeTicket("done", id);
  for (const id of blocked) writeTicket("blocked", id, "blocked_reason: test reason\n");
}

// Helper to run move-ticket.js as subprocess
function runMoveTicket(workdir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MOVE_TICKET_PATH, ...args], {
      cwd: workdir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
    child.on("error", (err) => { reject(err); });

    setTimeout(() => reject(new Error("Timeout: move-ticket exceeded 5s")), 5000);
  });
}

function parseResult(stdout) {
  const marker = "---RESULT---";
  const startIdx = stdout.indexOf(marker);
  const endIdx = stdout.indexOf(marker, startIdx + marker.length);
  if (startIdx === -1 || endIdx === -1) return null;
  const block = stdout.substring(startIdx + marker.length, endIdx).trim();
  const data = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) data[match[1].trim()] = match[2].trim();
  }
  return data;
}

// ============================================================================
// Hook unit tests (direct import with mock fs)
// ============================================================================

test("Scenario 1: Move to review with pending approval file", () => {
  const mockFs = createMockFs();
  const workflowDir = ".workflow";
  const approvalsDir = path.join(workflowDir, "approvals");
  const ticketId = "IMPL-001";
  const target = "review";

  mockFs._setDir(approvalsDir);
  const approvalFile = path.join(approvalsDir, `${ticketId}_manual-gate-test_001.json`);
  const pendingData = { status: "pending", ticket_id: ticketId, created_at: new Date().toISOString() };
  mockFs._setFile(approvalFile, JSON.stringify(pendingData, null, 2));

  updateApprovalFilesHook(ticketId, target, mockFs, workflowDir);

  const updated = JSON.parse(mockFs._getFile(approvalFile));
  assert.equal(updated.status, "approved", "File status should be approved");
  assert.equal(updated.decided_by, "move-ticket", "decided_by should be move-ticket");
  assert.match(updated.comment, /auto-approved on move to review/, "comment should contain target");
  assert(updated.updated_at, "updated_at should be set");
});

test("Scenario 2: Move to review without approval file (no-op)", () => {
   const mockFs = createMockFs();
   const workflowDir = ".workflow";
   const approvalsDir = path.join(workflowDir, "approvals");
   const ticketId = "IMPL-002";

   mockFs._setDir(approvalsDir);

   assert.doesNotThrow(() => {
     updateApprovalFilesHook(ticketId, "review", mockFs, workflowDir);
   }, "Hook should not throw when no approval file exists");

   const files = mockFs.readdirSync(approvalsDir);
   assert.equal(files.length, 0, "No files should be created");
 });

test("Scenario 3: Move to in-progress with pending approval file", () => {
  const mockFs = createMockFs();
  const workflowDir = ".workflow";
  const approvalsDir = path.join(workflowDir, "approvals");
  const ticketId = "IMPL-003";

  mockFs._setDir(approvalsDir);
  const approvalFile = path.join(approvalsDir, `${ticketId}_manual-gate-test_001.json`);
  mockFs._setFile(approvalFile, JSON.stringify({ status: "pending", ticket_id: ticketId, created_at: new Date().toISOString() }, null, 2));

  updateApprovalFilesHook(ticketId, "in-progress", mockFs, workflowDir);

  const updated = JSON.parse(mockFs._getFile(approvalFile));
  assert.equal(updated.status, "approved", "File status should be approved");
});

test("Scenario 4: Corrupt JSON approval file (WARN + continue)", () => {
  const mockFs = createMockFs();
  const workflowDir = ".workflow";
  const approvalsDir = path.join(workflowDir, "approvals");
  const ticketId = "IMPL-004";

  mockFs._setDir(approvalsDir);
  const approvalFile = path.join(approvalsDir, `${ticketId}_manual-gate-test_001.json`);
  mockFs._setFile(approvalFile, "{ invalid json }");

  assert.doesNotThrow(() => {
    updateApprovalFilesHook(ticketId, "review", mockFs, workflowDir);
  }, "Hook should not throw on corrupt JSON");

  const fileContent = mockFs._getFile(approvalFile);
  assert.equal(fileContent, "{ invalid json }", "Corrupt file should remain unchanged");
});

test("Scenario 5: Nonexistent approvalsDir (no-op)", () => {
  const mockFs = createMockFs();
  const ticketId = "IMPL-005";

  assert.doesNotThrow(() => {
    updateApprovalFilesHook(ticketId, "review", mockFs, ".workflow");
  }, "Hook should not throw when approvalsDir does not exist");
});

test("Additional: Already approved file is skipped (idempotency)", () => {
  const mockFs = createMockFs();
  const workflowDir = ".workflow";
  const approvalsDir = path.join(workflowDir, "approvals");
  const ticketId = "IMPL-006";

  mockFs._setDir(approvalsDir);
  const approvalFile = path.join(approvalsDir, `${ticketId}_manual-gate-test_001.json`);
  const approvedData = { status: "approved", ticket_id: ticketId, decided_by: "manual", comment: "manually approved", updated_at: "2026-04-29T10:00:00.000Z" };
  mockFs._setFile(approvalFile, JSON.stringify(approvedData, null, 2));

  updateApprovalFilesHook(ticketId, "review", mockFs, workflowDir);

  const updated = JSON.parse(mockFs._getFile(approvalFile));
  assert.equal(updated.status, "approved");
  assert.equal(updated.decided_by, "manual");
  assert.equal(updated.updated_at, "2026-04-29T10:00:00.000Z", "updated_at should not change");
});

test("Additional: Multiple pending files for one ticket all become approved", () => {
  const mockFs = createMockFs();
  const workflowDir = ".workflow";
  const approvalsDir = path.join(workflowDir, "approvals");
  const ticketId = "IMPL-007";

  mockFs._setDir(approvalsDir);
  for (let i = 1; i <= 3; i++) {
    const approvalFile = path.join(approvalsDir, `${ticketId}_manual-gate-test_00${i}.json`);
    mockFs._setFile(approvalFile, JSON.stringify({ status: "pending", ticket_id: ticketId, gate: `gate-${i}` }, null, 2));
  }

  updateApprovalFilesHook(ticketId, "done", mockFs, workflowDir);

  const fileStore = mockFs._getFileStore();
  const files = fileStore.get(approvalsDir);
  let approvedCount = 0;
  for (const [filename, content] of files.entries()) {
    if (filename.startsWith(ticketId)) {
      const data = JSON.parse(content);
      if (data.status === "approved") approvedCount++;
    }
  }
  assert.equal(approvedCount, 3, "All three files should be approved");
});

test("Additional: Files not matching pattern are not processed", () => {
  const mockFs = createMockFs();
  const workflowDir = ".workflow";
  const approvalsDir = path.join(workflowDir, "approvals");
  const ticketId = "IMPL-008";

  mockFs._setDir(approvalsDir);
  const otherFile = path.join(approvalsDir, "OTHER-TICKET_manual-gate-test_001.json");
  mockFs._setFile(otherFile, JSON.stringify({ status: "pending", ticket_id: "OTHER-TICKET" }, null, 2));

  updateApprovalFilesHook(ticketId, "review", mockFs, workflowDir);

  const otherUpdated = JSON.parse(mockFs._getFile(otherFile));
  assert.equal(otherUpdated.status, "pending", "Other ticket's file should remain pending");
});

// ============================================================================
// Subprocess tests for moveTicket (cover more branches)
// ============================================================================

test("Subprocess: Move ticket from ready to in-progress (success)", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, { ready: ["IMPL-S01"] });

    const result = await runMoveTicket(tempDir, ["IMPL-S01", "in-progress"]);
    const data = parseResult(result.stdout);

    assert.equal(data?.status, "moved", "Status should be moved");
    assert.equal(data?.from, "ready", "From should be ready");
    assert.equal(data?.to, "in-progress", "To should be in-progress");
    assert(!fs.existsSync(path.join(tempDir, ".workflow", "tickets", "ready", "IMPL-S01.md")), "Ticket should not be in ready/ anymore");
    assert(fs.existsSync(path.join(tempDir, ".workflow", "tickets", "in-progress", "IMPL-S01.md")), "Ticket should be in in-progress/");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Move ticket from review to done", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, { review: ["IMPL-S02"] });

    const result = await runMoveTicket(tempDir, ["IMPL-S02", "done"]);
    const data = parseResult(result.stdout);

    assert.equal(data?.status, "moved", "Status should be moved");
    assert.equal(data?.from, "review", "From should be review");
    assert.equal(data?.to, "done", "To should be done");
    assert(fs.existsSync(path.join(tempDir, ".workflow", "tickets", "done", "IMPL-S02.md")), "Ticket should be in done/");

    // Verify completed_at was added
    const content = fs.readFileSync(path.join(tempDir, ".workflow", "tickets", "done", "IMPL-S02.md"), "utf8");
    assert(content.includes("completed_at:"), "completed_at should be set in done ticket");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Move ticket from blocked to ready (removes blocked_reason)", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, { blocked: ["IMPL-S03"] });

    const result = await runMoveTicket(tempDir, ["IMPL-S03", "ready"]);
    const data = parseResult(result.stdout);

    assert.equal(data?.status, "moved", "Status should be moved");
    assert.equal(data?.from, "blocked");
    assert.equal(data?.to, "ready");

    const content = fs.readFileSync(path.join(tempDir, ".workflow", "tickets", "ready", "IMPL-S03.md"), "utf8");
    assert(!content.includes("blocked_reason:"), "blocked_reason should be removed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Ticket not found returns error", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, {});

    const result = await runMoveTicket(tempDir, ["NONEXISTENT-999", "in-progress"]);
    const data = parseResult(result.stdout);

    assert.equal(data?.status, "error", "Status should be error");
    assert(result.code !== 0, "Exit code should be non-zero");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Invalid transition returns error", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, { ready: ["IMPL-S04"] });

    // ready → done is an invalid transition
    const result = await runMoveTicket(tempDir, ["IMPL-S04", "done"]);
    const data = parseResult(result.stdout);

    assert.equal(data?.status, "error", "Status should be error for invalid transition");
    assert(result.code !== 0, "Exit code should be non-zero");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Move via pipeline context (single arg)", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, { ready: ["IMPL-S05"] });

    const pipelineContext = "move-ticket\n\nContext:\n  ticket_id: IMPL-S05\n  target: in-progress\n";
    const result = await runMoveTicket(tempDir, [pipelineContext]);
    const data = parseResult(result.stdout);

    assert.equal(data?.status, "moved", "Should parse pipeline context and move ticket");
    assert.equal(data?.from, "ready");
    assert.equal(data?.to, "in-progress");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Move with approval file present (hook runs)", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, { ready: ["IMPL-S06"] });
    const approvalsDir = path.join(tempDir, ".workflow", "approvals");
    const approvalFile = path.join(approvalsDir, "IMPL-S06_manual-gate-human_0.json");
    fs.writeFileSync(approvalFile, JSON.stringify({ status: "pending", ticket_id: "IMPL-S06", created_at: new Date().toISOString() }, null, 2), "utf8");

    await runMoveTicket(tempDir, ["IMPL-S06", "in-progress"]);

    const updated = JSON.parse(fs.readFileSync(approvalFile, "utf8"));
    assert.equal(updated.status, "approved", "Approval file should be approved after move");
    assert.equal(updated.decided_by, "move-ticket");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: No arguments shows usage error", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, {});
    const result = await runMoveTicket(tempDir, []);
    assert(result.code !== 0, "Exit code should be non-zero");
    assert(result.stderr.includes("Usage:"), "Should print usage message");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Subprocess: Invalid pipeline context shows error", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "move-ticket-sub-"));
  try {
    createTempWorkflow(tempDir, {});
    const invalidContext = "move-ticket\n\nContext:\n  ticket_id: \n  target: ";
    const result = await runMoveTicket(tempDir, [invalidContext]);
    assert(result.code !== 0, "Exit code should be non-zero");
    assert(result.stdout.includes("Missing ticket_id or target"), "Should show parsing error");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
