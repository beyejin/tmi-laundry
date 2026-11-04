import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DRIZZLE = new URL('../drizzle/', import.meta.url);

// drizzle/ 마이그레이션을 _journal.json 순서대로 적용한 메모리 DB를 만들어요. 테스트가 손으로 쓴 스키마와 어긋나지 않게 해요.
export function createDb() {
  const db = new DatabaseSync(':memory:');
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', DRIZZLE), 'utf8'));
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, DRIZZLE), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement);
    }
  }
  return db;
}
