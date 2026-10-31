'use strict';

/**
 * migrations.js — 版本化 schema 迁移（1.6–1.9 骨架）。
 *
 * 现有 `ensureRecordColumns()` 是“缺列就补”的惰性迁移；新增表/字段更多之后，
 * 每个模块各写一套判断迟早会出现半迁移状态。这里提供一个最小、可回放的版本：
 *  - `schema_meta` 记录已执行到的版本；
 *  - 每个 migration 只向前、在事务里执行；
 *  - 重复启动不重复执行；
 *  - 任何一步失败都会回滚该 migration，不会留下半张表。
 *
 * ⚠️ 迁移只负责结构与索引；不写业务数据。业务回填放到各自模块的幂等函数里。
 */

const CURRENT_VERSION = 6;

const MIGRATIONS = [
  {
    version: 1,
    name: 'upcoming-feature-tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS puzzles (
          id         TEXT PRIMARY KEY,
          type       TEXT NOT NULL,
          sfen       TEXT NOT NULL,
          solution   TEXT NOT NULL,
          difficulty INTEGER,
          tags       TEXT,
          source     TEXT,
          license    TEXT,
          status     TEXT NOT NULL DEFAULT 'active',
          createdAt  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_puzzles_status ON puzzles(status, createdAt);

        CREATE TABLE IF NOT EXISTS puzzle_attempts (
          playerId  TEXT NOT NULL,
          puzzleId  TEXT NOT NULL,
          day       TEXT NOT NULL,
          ok        INTEGER NOT NULL DEFAULT 0,
          attempts  INTEGER NOT NULL DEFAULT 0,
          firstAt   INTEGER,
          solvedAt  INTEGER,
          PRIMARY KEY (playerId, puzzleId, day)
        );
        CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_player ON puzzle_attempts(playerId, day);

        CREATE TABLE IF NOT EXISTS friendships (
          a         TEXT NOT NULL,
          b         TEXT NOT NULL,
          status    TEXT NOT NULL,
          createdAt INTEGER,
          updatedAt INTEGER,
          PRIMARY KEY (a, b)
        );
        CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships(b, status);

        CREATE TABLE IF NOT EXISTS follows (
          followerId TEXT NOT NULL,
          followeeId TEXT NOT NULL,
          createdAt  INTEGER,
          PRIMARY KEY (followerId, followeeId)
        );
        CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followeeId);

        CREATE TABLE IF NOT EXISTS blocks (
          a         TEXT NOT NULL,
          b         TEXT NOT NULL,
          createdAt INTEGER,
          PRIMARY KEY (a, b)
        );

        CREATE TABLE IF NOT EXISTS challenges (
          id          TEXT PRIMARY KEY,
          fromId      TEXT NOT NULL,
          toId        TEXT NOT NULL,
          timeControl TEXT,
          handicap    TEXT,
          rated       INTEGER NOT NULL DEFAULT 0,
          createdAt   INTEGER,
          expiresAt   INTEGER,
          status      TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_challenges_to ON challenges(toId, status, expiresAt);

        CREATE TABLE IF NOT EXISTS account_tokens (
          id        TEXT PRIMARY KEY,
          accountId TEXT NOT NULL,
          purpose   TEXT NOT NULL,
          tokenHash TEXT NOT NULL UNIQUE,
          expiresAt INTEGER NOT NULL,
          usedAt    INTEGER,
          createdAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_account_tokens_account ON account_tokens(accountId, purpose);

        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id        TEXT PRIMARY KEY,
          playerId  TEXT NOT NULL,
          endpoint  TEXT NOT NULL UNIQUE,
          keys      TEXT,
          createdAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_player ON push_subscriptions(playerId);

        CREATE TABLE IF NOT EXISTS corr_games (
          id             TEXT PRIMARY KEY,
          startSfen      TEXT NOT NULL,
          moves          TEXT NOT NULL DEFAULT '[]',
          playerB        TEXT NOT NULL,
          playerW        TEXT NOT NULL,
          timePerMoveMs  INTEGER NOT NULL,
          deadlineB      INTEGER,
          deadlineW      INTEGER,
          status         TEXT NOT NULL DEFAULT 'playing',
          result         TEXT,
          createdAt      INTEGER,
          updatedAt      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_corr_games_status ON corr_games(status, updatedAt);
        CREATE INDEX IF NOT EXISTS idx_corr_games_deadlineB ON corr_games(status, deadlineB);
        CREATE INDEX IF NOT EXISTS idx_corr_games_deadlineW ON corr_games(status, deadlineW);

        CREATE TABLE IF NOT EXISTS seasons (
          id        TEXT PRIMARY KEY,
          name      TEXT NOT NULL,
          startsAt  INTEGER,
          endsAt    INTEGER,
          data      TEXT,
          createdAt INTEGER
        );

        CREATE TABLE IF NOT EXISTS studies (
          id         TEXT PRIMARY KEY,
          ownerId    TEXT NOT NULL,
          title      TEXT NOT NULL,
          visibility TEXT NOT NULL DEFAULT 'private',
          createdAt  INTEGER,
          updatedAt  INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_studies_owner ON studies(ownerId, updatedAt);

        CREATE TABLE IF NOT EXISTS study_items (
          studyId  TEXT NOT NULL,
          recordId TEXT NOT NULL,
          ply      INTEGER NOT NULL DEFAULT 0,
          note     TEXT,
          sort     INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (studyId, recordId, ply)
        );
        CREATE INDEX IF NOT EXISTS idx_study_items_study ON study_items(studyId, sort);
      `);
    },
  },
  {
    version: 2,
    name: 'challenge-room-link',
    up(db) {
      // 约战接受后记录自动创建的私人房，双方都靠它跳转到对局页。
      const cols = new Set(db.prepare('PRAGMA table_info(challenges)').all().map((c) => c.name));
      if (!cols.has('roomId')) db.exec('ALTER TABLE challenges ADD COLUMN roomId TEXT');
      if (!cols.has('code')) db.exec('ALTER TABLE challenges ADD COLUMN code TEXT');
    },
  },
  {
    version: 3,
    name: 'correspondence-result-detail',
    up(db) {
      const cols = new Set(db.prepare('PRAGMA table_info(corr_games)').all().map((c) => c.name));
      if (!cols.has('resultDetail')) db.exec('ALTER TABLE corr_games ADD COLUMN resultDetail TEXT');
    },
  },
  {
    version: 4,
    name: 'notification-center',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id         TEXT PRIMARY KEY,
          playerId   TEXT NOT NULL,
          type       TEXT NOT NULL,
          title      TEXT NOT NULL,
          body       TEXT,
          data       TEXT,
          dedupeKey  TEXT,
          readAt     INTEGER,
          createdAt  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_player ON notifications(playerId, createdAt);
        CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(playerId, readAt, createdAt);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
          ON notifications(playerId, dedupeKey) WHERE dedupeKey IS NOT NULL;
      `);
    },
  },
  {
    version: 5,
    name: 'correspondence-draw-offer',
    up(db) {
      const cols = new Set(db.prepare('PRAGMA table_info(corr_games)').all().map((c) => c.name));
      if (!cols.has('drawOfferBy')) db.exec('ALTER TABLE corr_games ADD COLUMN drawOfferBy TEXT');
      if (!cols.has('drawOfferedAt')) db.exec('ALTER TABLE corr_games ADD COLUMN drawOfferedAt INTEGER');
    },
  },
  {
    version: 6,
    name: 'season-status',
    up(db) {
      const cols = new Set(db.prepare('PRAGMA table_info(seasons)').all().map((c) => c.name));
      if (!cols.has('status')) db.exec("ALTER TABLE seasons ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
      if (!cols.has('closedAt')) db.exec('ALTER TABLE seasons ADD COLUMN closedAt INTEGER');
    },
  },
];

function apply(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
  let current = row ? Number(row.value) : 0;
  if (!Number.isFinite(current) || current < 0) current = 0;
  const applied = [];
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(m.version));
    });
    run();
    current = m.version;
    applied.push({ version: m.version, name: m.name });
  }
  return { from: row ? Number(row.value) : 0, to: current, applied };
}

module.exports = { CURRENT_VERSION, MIGRATIONS, apply };
