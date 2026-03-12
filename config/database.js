const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, '../database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Gagal terhubung ke database SQLite:', err.message);
    } else {
        console.log('Berhasil terhubung ke database SQLite.');
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // TABEL STREAMS DIPERBARUI: Tambah end_time dan is_daily
            db.run(`CREATE TABLE IF NOT EXISTS streams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER,
                platform_name TEXT NOT NULL,
                stream_url TEXT NOT NULL,
                stream_key TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                scheduled_time DATETIME,
                end_time DATETIME,
                is_daily INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (video_id) REFERENCES videos(id)
            )`);
        });
    }
});
module.exports = db;