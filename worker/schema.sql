CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY, label TEXT, type TEXT, cluster TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS links(a TEXT, b TEXT, PRIMARY KEY(a,b));
CREATE TABLE IF NOT EXISTS works(
  id TEXT PRIMARY KEY, author TEXT, title TEXT, year INTEGER, kind TEXT,
  desc TEXT, dims TEXT, signals INTEGER DEFAULT 0, tasteMatch REAL DEFAULT 0, source TEXT);
CREATE INDEX IF NOT EXISTS works_author ON works(author);
CREATE TABLE IF NOT EXISTS releases(
  key TEXT PRIMARY KEY, title TEXT, url TEXT, date TEXT, source TEXT,
  kind TEXT, author TEXT, summary TEXT, fetched TEXT);
