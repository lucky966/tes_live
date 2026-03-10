const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Menentukan lokasi file database
const dbPath = path.resolve(__dirname, '../database.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Gagal terhubung ke database SQLite:', err.message);
    } else {
        console.log('Berhasil terhubung ke database SQLite.');

        // db.serialize memastikan pembuatan tabel dilakukan satu per satu (berurutan)
        db.serialize(() => {

            // 1. Membuat Tabel Videos
            db.run(`CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                filename TEXT NOT NULL,
                filepath TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            // 2. Membuat Tabel Streams (Jadwal & Setting Live)
            db.run(`CREATE TABLE IF NOT EXISTS streams (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER,
                platform_name TEXT NOT NULL,  -- Contoh: 'YouTube', 'Facebook'
                stream_url TEXT NOT NULL,     -- URL Server RTMP
                stream_key TEXT NOT NULL,     -- Kunci Streaming rahasia
                status TEXT DEFAULT 'pending', -- Status: pending, live, finished
                scheduled_time DATETIME,      -- Waktu jadwal live
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (video_id) REFERENCES videos(id)
            )`);

            console.log('Tabel database (videos & streams) berhasil diperiksa/disiapkan.');
        });
    }
});

module.exports = db;