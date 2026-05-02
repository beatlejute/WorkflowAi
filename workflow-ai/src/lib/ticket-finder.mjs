import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Find ticket file by ID with priority search across columns.
 * @param {string} ticketId - The ticket ID to search for (e.g., "IMPL-84")
 * @param {string} projectRoot - The root directory of the project
 * @returns {string|null} Absolute path to ticket file or null if not found
 */
export function findTicketPathForId(ticketId, projectRoot) {
  // Define search columns in priority order
  const columns = [
    'in-progress',
    'review',
    'ready',
    'backlog',
    'blocked',
    'done',
    'archive'
  ];

  // Construct filename to search for
  const fileName = `${ticketId}.md`;

  // Search each column in priority order
  for (const column of columns) {
    const ticketPath = join(projectRoot, '.workflow', 'tickets', column, fileName);
    if (existsSync(ticketPath)) {
      return ticketPath;
    }
  }

  // Ticket not found in any column
  return null;
}