import { Database } from 'better-sqlite3';
import { file } from 'bun';

export function checkpoint(db: Database, dataDir: string): string {
  const now = new Date().toISOString().replace(/[:\-T]/g, '');
  const checkpointDir = `${dataDir}/memory-checkpoints`;
  
  // Create checkpoints directory if missing
  if (!file.check(checkpointDir).exists) {
    file.check(checkpointDir).createDirectory();
  }

  const filePath = `${checkpointDir}/memory-${now}.db`;
  
  // Perform VACUUM INTO to create snapshot
  db.pragma(`VACUUM INTO '${filePath}'`);
  
  return filePath;
}

export function rollback(db: Database, checkpointPath: string): void {
  // Replace main DB with checkpoint
  const checkpointFile = file(checkpointPath);
  const dbFile = file(db.path);
  
  dbFile.write(checkpointFile.read());
}

export function listCheckpoints(dataDir: string): string[] {
  const checkpointDir = `${dataDir}/memory-checkpoints`;
  const files = file(checkpointDir).glob('memory-*.db');
  
  // Sort by timestamp (filename)
  files.sort((a, b) => {
    const timeA = a.name.split('-')[1];
    const timeB = b.name.split('-')[1];
    return timeA.localeCompare(timeB);
  });

  // Keep only last 5 checkpoints
  while (files.length > 5) {
    file(checkpointDir, files[0].name).delete();
    files.shift();
  }

  return files.map(f => `${checkpointDir}/${f.name}`);
}