-- WriteChat database schema for Cloudflare D1.
-- Run this once in the D1 console after creating the database.

CREATE TABLE IF NOT EXISTS users (
  key TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  token TEXT,
  created INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT, recipient TEXT, text TEXT, ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender, recipient);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY, name TEXT, created_by TEXT, created INTEGER
);

CREATE TABLE IF NOT EXISTS group_members (
  gid TEXT, userkey TEXT, PRIMARY KEY (gid, userkey)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gid TEXT, sender TEXT, from_name TEXT, text TEXT, ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gmsg ON group_messages(gid);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, ts INTEGER
);

CREATE TABLE IF NOT EXISTS avatars (userkey TEXT PRIMARY KEY, image TEXT);
CREATE TABLE IF NOT EXISTS presence (userkey TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE IF NOT EXISTS reads (scope TEXT, userkey TEXT, ts INTEGER, PRIMARY KEY (scope, userkey));
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, used_by TEXT);
