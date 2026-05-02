import { findTicketPathForId } from './ticket-finder.mjs';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

// Create a temporary test directory
const testRoot = join(process.cwd(), 'temp-test');
const ticketsDir = join(testRoot, '.workflow', 'tickets');

// Clean up any existing test directory
if (existsSync(testRoot)) {
  rmSync(testRoot, { recursive: true, force: true });
}

// Create test directory structure
mkdirSync(ticketsDir, { recursive: true });
['in-progress', 'review', 'ready', 'backlog', 'blocked', 'done', 'archive'].forEach(dir => {
  mkdirSync(join(ticketsDir, dir), { recursive: true });
});

// Test 1: Ticket found in in-progress (highest priority)
const testTicketId1 = 'IMPL-84';
const inProgressPath1 = join(ticketsDir, 'in-progress', `${testTicketId1}.md`);
writeFileSync(inProgressPath1, '---\nid: IMPL-84\n---\n');

const result1 = findTicketPathForId(testTicketId1, testRoot);
console.log('Test 1 - Ticket in in-progress:', result1 === inProgressPath1 ? 'PASS' : 'FAIL');
console.log('Expected:', inProgressPath1);
console.log('Got:', result1);

// Clean up after test 1
rmSync(inProgressPath1);

// Test 2: Ticket found in review (should ignore done)
const testTicketId2 = 'IMPL-85';
const reviewPath2 = join(ticketsDir, 'review', `${testTicketId2}.md`);
writeFileSync(reviewPath2, '---\nid: IMPL-85\n---\n');
const donePath2 = join(ticketsDir, 'done', `${testTicketId2}.md`);
writeFileSync(donePath2, '---\nid: IMPL-85\n---\n');

const result2 = findTicketPathForId(testTicketId2, testRoot);
console.log('\nTest 2 - Ticket in review and done (should pick review):', result2 === reviewPath2 ? 'PASS' : 'FAIL');
console.log('Expected:', reviewPath2);
console.log('Got:', result2);

// Clean up after test 2
rmSync(reviewPath2);
rmSync(donePath2);

// Test 3: Ticket not found anywhere
const testTicketId3 = 'NONEXISTENT-123';
const result3 = findTicketPathForId(testTicketId3, testRoot);
console.log('\nTest 3 - Non-existent ticket:', result3 === null ? 'PASS' : 'FAIL');
console.log('Expected: null');
console.log('Got:', result3);

// Clean up
rmSync(testRoot, { recursive: true, force: true });
console.log('\nTest cleanup completed.');