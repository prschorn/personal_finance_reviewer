// Folds the write-ahead log back into db/finance.db so the file copied into the
// Docker image is a complete, consistent snapshot. Run before `docker compose build`.
import Database from 'better-sqlite3';

const path = process.env.FINANCE_DB_PATH ?? 'db/finance.db';
const db = new Database(path);
const [[busy, log, checkpointed]] = db.pragma('wal_checkpoint(TRUNCATE)').map(Object.values);
db.close();

if (busy) {
  console.error(`Could not fully checkpoint ${path}: another process is writing to it.`);
  console.error('Stop the dev server and run this again.');
  process.exit(1);
}
console.log(`Checkpointed ${path} (${checkpointed}/${log} WAL pages folded in).`);
