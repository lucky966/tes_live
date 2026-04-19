const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Gagal terhubung ke database:', err.message); } 
    else {
        db.serialize(() => {
            // (Tabel lama tetap ada di sini: videos, accounts, streams, categories)
            db.run(`CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL, niche TEXT, account_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_name TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expiry_date INTEGER, default_title TEXT, default_desc TEXT, default_tags TEXT, niche TEXT, project_id INTEGER, profile_image_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
            db.run(`CREATE TABLE IF NOT EXISTS streams (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER, account_id INTEGER, yt_title TEXT, yt_desc TEXT, platform_name TEXT NOT NULL, stream_url TEXT NOT NULL, stream_key TEXT NOT NULL, status TEXT DEFAULT 'pending', scheduled_time DATETIME, end_time DATETIME, is_daily INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (video_id) REFERENCES videos(id))`);
            db.run(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`);

            // TABEL BARU: Menyimpan Daftar API Google Cloud
            db.run(`CREATE TABLE IF NOT EXISTS google_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT NOT NULL, redirect_uri TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

            // MENGHUBUNGKAN AKUN KE API PROJECT
            db.run(`ALTER TABLE accounts ADD COLUMN project_id INTEGER`, () => {});
        });
    }
});
module.exports = db;