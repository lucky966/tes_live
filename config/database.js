const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Gagal terhubung ke database SQLite:', err.message);
    } else {
        console.log('Berhasil terhubung ke database SQLite.');
        db.serialize(() => {
            // 1. Buat Tabel Video (Lengkap dengan Niche & Account ID)
            db.run(`CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL, niche TEXT, account_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

            // 2. Buat Tabel Akun (Lengkap dengan Default Text & Niche)
            db.run(`CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_name TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expiry_date INTEGER, default_title TEXT, default_desc TEXT, default_tags TEXT, niche TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

            // 3. Buat Tabel Tugas Stream
            db.run(`CREATE TABLE IF NOT EXISTS streams (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id INTEGER, account_id INTEGER, yt_title TEXT, yt_desc TEXT, platform_name TEXT NOT NULL, stream_url TEXT NOT NULL, stream_key TEXT NOT NULL, status TEXT DEFAULT 'pending', scheduled_time DATETIME, end_time DATETIME, is_daily INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (video_id) REFERENCES videos(id))`);

            // 4. Buat Tabel Kategori / Niche Khusus
            db.run(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`, () => {
                // Masukkan kategori standar saat pertama kali dibuat
                const defaults = [''];
                defaults.forEach(cat => {
                    db.run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [cat]);
                });
            });

            // (Opsional) Penjaga aman jika tabel lama tanpa kolom baru masih nyangkut
            db.run(`ALTER TABLE accounts ADD COLUMN default_title TEXT`, () => { });
            db.run(`ALTER TABLE accounts ADD COLUMN default_desc TEXT`, () => { });
            db.run(`ALTER TABLE accounts ADD COLUMN default_tags TEXT`, () => { });
            db.run(`ALTER TABLE accounts ADD COLUMN niche TEXT`, () => { });
            db.run(`ALTER TABLE videos ADD COLUMN niche TEXT`, () => { });
            db.run(`ALTER TABLE videos ADD COLUMN account_id INTEGER`, () => { });
            db.run(`ALTER TABLE accounts ADD COLUMN profile_image_url TEXT`, () => { });
        });
    }
});
module.exports = db;