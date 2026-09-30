CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  thread TEXT,
  refs TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  sender TEXT NOT NULL,
  envelope TEXT,
  delivered TEXT,
  recipient TEXT NOT NULL,
  cc TEXT,
  bcc TEXT,
  reply_to TEXT,
  sent_at TEXT,
  subject TEXT,
  text TEXT,
  html TEXT,
  code TEXT,
  link TEXT,
  category TEXT,
  confidence REAL,
  injection REAL,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL REFERENCES emails (id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  size INTEGER NOT NULL
);

CREATE INDEX emails_created ON emails (created_at DESC, id DESC);
CREATE INDEX emails_sender ON emails (sender, created_at DESC);
CREATE INDEX emails_thread ON emails (thread, created_at DESC);
CREATE INDEX emails_delivered ON emails (delivered, created_at DESC);
CREATE INDEX attachments_email ON attachments (email_id);
