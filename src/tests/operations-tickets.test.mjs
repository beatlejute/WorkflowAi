import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { pickNext, moveTicket, getNextId, createTicket } from '../lib/operations/tickets.mjs';
import { parseFrontmatter } from '../lib/utils.mjs';

describe('operations/tickets.mjs', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `workflow-tickets-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Create the standard ticket directories structure
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'backlog'), { recursive: true });
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'ready'), { recursive: true });
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'in-progress'), { recursive: true });
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'blocked'), { recursive: true });
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'review'), { recursive: true });
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'done'), { recursive: true });
    mkdirSync(join(projectRoot, '.workflow', 'tickets', 'archive'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('pickNext', () => {
    test('TC1: pickNext from empty ready/ returns {empty: true, reason}', async () => {
      const result = await pickNext(projectRoot);

      assert.equal(result.empty, true, 'Should have empty flag');
      assert.equal(result.reason, 'no_ready_tickets', 'Should have no_ready_tickets reason');
      assert.equal(result.ticket, undefined, 'Should not have ticket');
    });

    test('TC2: pickNext skips tickets with unmet dependencies', async () => {
      // Create a ticket with dependency on IMPL-001 (which doesn't exist in done/)
      const ticketContent = `---
id: IMPL-002
title: Task Two
priority: 1
type: impl
created_at: "2026-04-24T00:00:00Z"
dependencies:
  - IMPL-001
conditions: []
---
## Task Two`;

      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-002.md'),
        ticketContent
      );

      const result = await pickNext(projectRoot);

      assert.equal(result.empty, true, 'Should return empty when dependencies not met');
      assert.equal(result.reason, 'no_eligible_tickets', 'Should indicate no eligible tickets');
    });

    test('TC3: pickNext returns first eligible ticket with met dependencies', async () => {
      // Create dependency in done/
      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'done', 'IMPL-001.md'),
        `---
id: IMPL-001
title: Task One
---
## Task One`
      );

      // Create a ready ticket with satisfied dependencies
      const ticketContent = `---
id: IMPL-002
title: Task Two
priority: 1
type: impl
created_at: "2026-04-24T00:00:00Z"
dependencies:
  - IMPL-001
conditions: []
---
## Task Two`;

      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-002.md'),
        ticketContent
      );

      const result = await pickNext(projectRoot);

      assert.equal(result.ticket !== undefined, true, 'Should find eligible ticket');
      assert.equal(result.ticket.id, 'IMPL-002', 'Should return correct ticket ID');
      assert.equal(result.ticket.title, 'Task Two', 'Should return correct title');
    });

    test('TC4: pickNext skips human-type tickets', async () => {
      // Create a human-type ticket (should be skipped)
      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'HUMAN-001.md'),
        `---
id: HUMAN-001
title: Human Task
type: human
created_at: "2026-04-24T00:00:00Z"
---
## Human Task`
      );

      // Create an agent-type ticket (should be picked)
      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-001.md'),
        `---
id: IMPL-001
title: Agent Task
type: impl
priority: 2
created_at: "2026-04-24T00:00:00Z"
---
## Agent Task`
      );

      const result = await pickNext(projectRoot);

      assert.equal(result.ticket.id, 'IMPL-001', 'Should skip human ticket and pick agent task');
    });

    test('TC5: pickNext respects priority (lower number = higher priority)', async () => {
      // Create tickets with different priorities
      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-001.md'),
        `---
id: IMPL-001
title: Low Priority
priority: 3
type: impl
created_at: "2026-04-24T00:00:00Z"
---
## Low Priority`
      );

      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-002.md'),
        `---
id: IMPL-002
title: High Priority
priority: 1
type: impl
created_at: "2026-04-24T00:00:00Z"
---
## High Priority`
      );

      const result = await pickNext(projectRoot);

      assert.equal(result.ticket.id, 'IMPL-002', 'Should pick highest priority ticket');
    });

    test('TC6: pickNext picks oldest created_at among same priority', async () => {
      // Create two tickets with same priority but different creation dates
      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-001.md'),
        `---
id: IMPL-001
title: Newer Task
priority: 1
type: impl
created_at: "2026-04-24T12:00:00Z"
---
## Newer Task`
      );

      writeFileSync(
        join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-002.md'),
        `---
id: IMPL-002
title: Older Task
priority: 1
type: impl
created_at: "2026-04-24T10:00:00Z"
---
## Older Task`
      );

      const result = await pickNext(projectRoot);

      assert.equal(result.ticket.id, 'IMPL-002', 'Should pick oldest created ticket among same priority');
    });
  });

  describe('moveTicket', () => {
    test('TC3: moveTicket on valid transition moves file from backlog to ready', async () => {
      // Create a ticket in backlog
      const ticketPath = join(projectRoot, '.workflow', 'tickets', 'backlog', 'IMPL-001.md');
      const content = `---
id: IMPL-001
title: Task One
priority: 1
type: impl
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-24T00:00:00Z"
completed_at: ""
---
## Task One`;

      writeFileSync(ticketPath, content);

      // Move from backlog to ready
      const result = await moveTicket(projectRoot, 'IMPL-001', 'ready');

      assert.equal(result.from, 'backlog', 'Should show source status');
      assert.equal(result.to, 'ready', 'Should show target status');

      // Verify file was moved
      const newPath = join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-001.md');
      assert.equal(existsSync(ticketPath), false, 'Old file should not exist');
      assert.equal(existsSync(newPath), true, 'New file should exist');

      // Verify content was updated with new timestamp
      const movedContent = readFileSync(newPath, 'utf8');
      assert.match(movedContent, /updated_at:/, 'Should have updated_at field');
    });

    test('TC4: moveTicket on invalid transition throws INVALID_TRANSITION error', async () => {
      // Create a ticket in done
      const ticketPath = join(projectRoot, '.workflow', 'tickets', 'done', 'IMPL-001.md');
      writeFileSync(ticketPath, `---
id: IMPL-001
title: Task One
---
## Task One`);

      // Try to move from done to backlog (invalid transition)
      try {
        await moveTicket(projectRoot, 'IMPL-001', 'backlog');
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.equal(error.code, 'INVALID_TRANSITION', 'Should throw INVALID_TRANSITION error');
        assert.equal(error.from, 'done', 'Error should show source status');
        assert.equal(error.to, 'backlog', 'Error should show target status');
      }
    });

    test('TC5: moveTicket throws error when ticket doesn\'t exist', async () => {
      try {
        await moveTicket(projectRoot, 'IMPL-999', 'ready');
        assert.fail('Should have thrown an error');
      } catch (error) {
        assert.equal(error.code, 'INVALID_TRANSITION', 'Should throw INVALID_TRANSITION error');
        assert.equal(error.id, 'IMPL-999', 'Error should contain ticket ID');
      }
    });

    test('TC6: moveTicket sets completed_at when moving to done', async () => {
      // Create a ticket in in-progress
      const ticketPath = join(projectRoot, '.workflow', 'tickets', 'in-progress', 'IMPL-001.md');
      writeFileSync(ticketPath, `---
id: IMPL-001
title: Task One
priority: 1
type: impl
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-24T00:00:00Z"
completed_at: ""
---
## Task One`);

      // Move to done
      await moveTicket(projectRoot, 'IMPL-001', 'done');

      // Verify file has completed_at set
      const doneContent = readFileSync(join(projectRoot, '.workflow', 'tickets', 'done', 'IMPL-001.md'), 'utf8');
      assert.match(doneContent, /completed_at: "\d{4}-\d{2}-\d{2}T/, 'Should have completed_at set to ISO date');
    });

    test('TC7: moveTicket removes blocked_reason when leaving blocked status', async () => {
      // Create a ticket in blocked with blocked_reason
      const ticketPath = join(projectRoot, '.workflow', 'tickets', 'blocked', 'IMPL-001.md');
      writeFileSync(ticketPath, `---
id: IMPL-001
title: Task One
type: impl
created_at: "2026-04-24T00:00:00Z"
updated_at: "2026-04-24T00:00:00Z"
completed_at: ""
blocked_reason: "Waiting for dependency"
---
## Task One`);

      // Move from blocked to ready
      await moveTicket(projectRoot, 'IMPL-001', 'ready');

      // Verify blocked_reason was removed
      const readyContent = readFileSync(join(projectRoot, '.workflow', 'tickets', 'ready', 'IMPL-001.md'), 'utf8');
      assert.equal(readyContent.includes('blocked_reason'), false, 'Should remove blocked_reason');
    });
  });

  describe('getNextId', () => {
    test('TC8: getNextId returns first ID when directory is empty', async () => {
      const id = await getNextId(projectRoot, 'IMPL');

      assert.equal(id, 'IMPL-001', 'Should return first ID for empty directory');
    });

    test('TC9: getNextId returns next available ID after existing tickets', async () => {
      // Create some existing tickets
      writeFileSync(join(projectRoot, '.workflow', 'tickets', 'backlog', 'IMPL-001.md'), 'content');
      writeFileSync(join(projectRoot, '.workflow', 'tickets', 'backlog', 'IMPL-003.md'), 'content');

      const id = await getNextId(projectRoot, 'IMPL');

      assert.equal(id, 'IMPL-004', 'Should return next ID after highest existing');
    });

    test('TC10: getNextId works independently for different types', async () => {
      // Create tickets of different types
      writeFileSync(join(projectRoot, '.workflow', 'tickets', 'backlog', 'IMPL-001.md'), 'content');
      writeFileSync(join(projectRoot, '.workflow', 'tickets', 'backlog', 'QA-001.md'), 'content');
      writeFileSync(join(projectRoot, '.workflow', 'tickets', 'backlog', 'QA-002.md'), 'content');

      const implId = await getNextId(projectRoot, 'IMPL');
      const qaId = await getNextId(projectRoot, 'QA');

      assert.equal(implId, 'IMPL-002', 'Should return next IMPL ID');
      assert.equal(qaId, 'QA-003', 'Should return next QA ID');
    });
  });

  describe('createTicket', () => {
    test('TC11: createTicket creates file in backlog with auto-incremented ID', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'New Task',
        priority: 1
      });

      assert.equal(result.id, 'IMPL-001', 'Should return first ID');
      assert.equal(existsSync(result.path), true, 'File should exist');

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /id: IMPL-001/, 'Should have correct ID in frontmatter');
      assert.match(content, /title: New Task/, 'Should have correct title');
    });

    test('TC12: createTicket with type:human adds executor_type field', async () => {
      const result = await createTicket(projectRoot, {
        type: 'human',
        title: 'Manual Task'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /executor_type: human/, 'Should have executor_type: human');
    });

    test('TC13: createTicket without executor_type for agent type', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'Agent Task'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.equal(content.includes('executor_type'), false, 'Agent type should not have executor_type');
    });

    test('TC14: createTicket increments ID correctly', async () => {
      const result1 = await createTicket(projectRoot, {
        type: 'QA',
        title: 'Test One'
      });

      const result2 = await createTicket(projectRoot, {
        type: 'QA',
        title: 'Test Two'
      });

      assert.equal(result1.id, 'QA-001', 'First ticket should be QA-001');
      assert.equal(result2.id, 'QA-002', 'Second ticket should be QA-002');
    });

    test('TC15: createTicket writes the body it was given', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'With body',
        body: '## Описание\n\nПочинить разбор конфига.\n'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /Починить разбор конфига\./, 'Body must reach the file');
      assert.equal(
        content.includes('## Критерии готовности (Definition of Done)'),
        false,
        'Given body replaces the empty template, not appended to it'
      );
    });

    test('TC16: createTicket keeps the empty template when no body is given', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'No body'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /## Описание/, 'Template section must stay');
      assert.match(content, /## Критерии готовности \(Definition of Done\)/, 'DoD section must stay');
    });

    test('TC17: createTicket ignores a blank body', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'Blank body',
        body: '   \n\n'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /## Критерии готовности \(Definition of Done\)/, 'Blank body falls back to template');
    });

    test('TC18: createTicket records plan_id as parent_plan', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'Planned',
        plan_id: 'PLAN-007'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /parent_plan: PLAN-007/, 'plan_id must land in parent_plan');
    });

    // ListeningGlass 2026-09-30: тикет, заведённый через MCP с `plan_id: PLAN-001`,
    // получил `parent_plan: PLAN-001`, соседние — `plans/current/PLAN-001.md`, а тело с
    // записями check вышло без `dod_format: 2`, и проверки DoD не запустились бы.
    test('TC18a: plan_id of an existing plan becomes its path, current and archive', async () => {
      mkdirSync(join(projectRoot, '.workflow', 'plans', 'current'), { recursive: true });
      mkdirSync(join(projectRoot, '.workflow', 'plans', 'archive'), { recursive: true });
      writeFileSync(join(projectRoot, '.workflow', 'plans', 'current', 'PLAN-007.md'), '---\nid: PLAN-007\n---\n');
      writeFileSync(join(projectRoot, '.workflow', 'plans', 'archive', 'PLAN-002.md'), '---\nid: PLAN-002\n---\n');

      const current = await createTicket(projectRoot, { type: 'IMPL', title: 'Current', plan_id: 'PLAN-007' });
      const archived = await createTicket(projectRoot, { type: 'IMPL', title: 'Archived', plan_id: 'plan-2' });
      const given = await createTicket(projectRoot, { type: 'IMPL', title: 'Path', parent_plan: 'plans/current/PLAN-009.md' });

      assert.equal(parseFrontmatter(readFileSync(current.path, 'utf8')).frontmatter.parent_plan, 'plans/current/PLAN-007.md');
      assert.equal(parseFrontmatter(readFileSync(archived.path, 'utf8')).frontmatter.parent_plan, 'plans/archive/PLAN-002.md');
      assert.equal(parseFrontmatter(readFileSync(given.path, 'utf8')).frontmatter.parent_plan, 'plans/current/PLAN-009.md', 'a given path is kept as is');
    });

    test('TC18e: plan path forms — real file name, current before archive, backslashes and .workflow/ prefix', async () => {
      mkdirSync(join(projectRoot, '.workflow', 'plans', 'current'), { recursive: true });
      mkdirSync(join(projectRoot, '.workflow', 'plans', 'archive'), { recursive: true });
      writeFileSync(join(projectRoot, '.workflow', 'plans', 'current', 'plan-010.md'), '---\nid: PLAN-010\n---\n');
      writeFileSync(join(projectRoot, '.workflow', 'plans', 'current', 'PLAN-003.md'), '---\nid: PLAN-003\n---\n');
      writeFileSync(join(projectRoot, '.workflow', 'plans', 'archive', 'PLAN-003.md'), '---\nid: PLAN-003\n---\n');

      const planOf = async (ref) => {
        const { path: file } = await createTicket(projectRoot, { type: 'IMPL', title: String(ref), plan_id: ref });
        return parseFrontmatter(readFileSync(file, 'utf8')).frontmatter.parent_plan;
      };

      assert.equal(await planOf('PLAN-010'), 'plans/current/plan-010.md', 'the real file name, not one built from the ID');
      assert.equal(await planOf('PLAN-003'), 'plans/current/PLAN-003.md', 'current wins over archive');
      assert.equal(await planOf('plans\\current\\PLAN-003.md'), 'plans/current/PLAN-003.md');
      assert.equal(await planOf('.workflow/plans/current/PLAN-003.md'), 'plans/current/PLAN-003.md');
    });

    test('TC18b: body with DoD check records gets dod_format: 2', async () => {
      const body = '## Описание\n\nТекст.\n\n## Критерии готовности (Definition of Done)\n\n'
        + '- [ ] Скрипт запускает тесты\n  - check: `npm test`, expect: `exit 0`\n'
        + '- [ ] Текст понятен\n  - prose: `понятность командой не проверить`\n';
      const result = await createTicket(projectRoot, { type: 'FIX', title: 'Checks', body });

      assert.equal(parseFrontmatter(readFileSync(result.path, 'utf8')).frontmatter.dod_format, 2);
    });

    test('TC18c: prose-only DoD records also get dod_format: 2', async () => {
      const body = '## Критерии готовности (Definition of Done)\n\n- [ ] Текст понятен\n  - prose: `понятность командой не проверить`\n';
      const result = await createTicket(projectRoot, { type: 'DOCS', title: 'Prose', body });

      assert.equal(parseFrontmatter(readFileSync(result.path, 'utf8')).frontmatter.dod_format, 2);
    });

    test('TC18d: DoD without records, empty template and explicit dod_format', async () => {
      const plain = await createTicket(projectRoot, {
        type: 'IMPL', title: 'Plain', body: '## Критерии готовности (Definition of Done)\n\n- [ ] Сделано\n'
      });
      const empty = await createTicket(projectRoot, { type: 'IMPL', title: 'Empty' });
      const explicit = await createTicket(projectRoot, {
        type: 'IMPL', title: 'Explicit', dod_format: 1,
        body: '## Критерии готовности (Definition of Done)\n\n- [ ] Сделано\n  - check: `npm test`, expect: `exit 0`\n'
      });

      assert.equal('dod_format' in parseFrontmatter(readFileSync(plain.path, 'utf8')).frontmatter, false);
      assert.equal('dod_format' in parseFrontmatter(readFileSync(empty.path, 'utf8')).frontmatter, false);
      assert.equal(parseFrontmatter(readFileSync(explicit.path, 'utf8')).frontmatter.dod_format, 1, 'the caller decides');
    });

    // Формат 2 требует запись у каждого пункта: пункт без записи или с неполной
    // ревью проваливает на каждой попытке (verify-artifacts, dod_record_invalid).
    test('TC18f: dod_format 2 body with an item without a full record is rejected, no file written', async () => {
      const dod = '## Критерии готовности (Definition of Done)\n\n';
      const bodies = {
        mixed: dod + '- [ ] Скрипт\n  - check: `npm test`, expect: `exit 0`\n- [ ] Без записи\n',
        multiple: dod + '- [ ] Две формы\n  - check: `npm test`, expect: `exit 0`\n  - prose: `причина`\n',
        noExpect: dod + '- [ ] Без ожидания\n  - check: `npm test`\n'
      };
      for (const [name, body] of Object.entries(bodies)) {
        await assert.rejects(createTicket(projectRoot, { type: 'FIX', title: name, body }), { code: 'INVALID_DOD' }, name);
      }
      await assert.rejects(createTicket(projectRoot, { type: 'FIX', title: 'explicit, no items', dod_format: 2, body: '## Описание\n\nТекст.\n' }), { code: 'INVALID_DOD' });
      assert.equal(existsSync(join(projectRoot, '.workflow', 'tickets', 'backlog', 'FIX-001.md')), false, 'nothing written, the ID is not taken');
    });

    // Тип во frontmatter — строчными, как ключи `agents_by_type` раннера и
    // `task_types` конфига; префикс ID — прописными. До 2026-09-27 тип писался
    // как пришёл: `COACH` уводил тикет коуча мимо роли coach, `coach` давал
    // ID `coach-001`.
    test('TC20: lowercase type → frontmatter type lowercase, ID prefix uppercase', async () => {
      const result = await createTicket(projectRoot, { type: 'coach', title: 'Coach gap' });

      assert.equal(result.id, 'COACH-001');
      const { frontmatter } = parseFrontmatter(readFileSync(result.path, 'utf8'));
      assert.equal(frontmatter.id, 'COACH-001');
      assert.equal(frontmatter.type, 'coach');
    });

    test('TC21: uppercase type → the same: type lowercase, ID prefix uppercase, numbering shared', async () => {
      const first = await createTicket(projectRoot, { type: 'QA', title: 'Upper' });
      const second = await createTicket(projectRoot, { type: 'qa', title: 'Lower' });

      assert.equal(first.id, 'QA-001');
      assert.equal(second.id, 'QA-002', 'Both spellings continue one QA sequence');
      assert.equal(parseFrontmatter(readFileSync(first.path, 'utf8')).frontmatter.type, 'qa');
      assert.equal(parseFrontmatter(readFileSync(second.path, 'utf8')).frontmatter.type, 'qa');
    });

    test('TC22: type HUMAN in uppercase still gets executor_type human', async () => {
      const result = await createTicket(projectRoot, { type: 'HUMAN', title: 'Manual' });

      assert.equal(result.id, 'HUMAN-001');
      const { frontmatter } = parseFrontmatter(readFileSync(result.path, 'utf8'));
      assert.equal(frontmatter.type, 'human');
      assert.equal(frontmatter.executor_type, 'human');
    });

    test('TC23: no type → default impl, ID IMPL-001, no executor_type', async () => {
      const result = await createTicket(projectRoot, { title: 'No type' });

      assert.equal(result.id, 'IMPL-001', 'Default type used to give impl-001');
      const { frontmatter } = parseFrontmatter(readFileSync(result.path, 'utf8'));
      assert.equal(frontmatter.type, 'impl');
      assert.equal(frontmatter.executor_type, undefined);
    });

    test('TC19: explicit parent_plan wins over plan_id', async () => {
      const result = await createTicket(projectRoot, {
        type: 'IMPL',
        title: 'Both fields',
        parent_plan: 'PLAN-001',
        plan_id: 'PLAN-007'
      });

      const content = readFileSync(result.path, 'utf8');
      assert.match(content, /parent_plan: PLAN-001/, 'parent_plan is the primary field');
    });
  });
});
