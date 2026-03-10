require('dotenv').config();
const express = require('express');
const db = require('./config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

// --- PENGATURAN FFMPEG ---
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegInstaller);

// --- BUKU CATATAN PROSES FFMPEG (BARU) ---
// Digunakan untuk menyimpan remot kontrol agar bisa di-stop
const activeStreams = new Map();

const app = express();
const PORT = process.env.PORT || 7575;

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

app.use(express.static('public'));
// BARIS BARU: Mengizinkan frontend untuk memutar video di folder uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- KONFIGURASI MULTER ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, './uploads/');
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// --- RUTE UNTUK UPLOAD VIDEO ---
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    const file = req.file;
    const title = req.body.title;

    if (!file) return res.status(400).send('Tolong pilih file video terlebih dahulu.');

    const sql = `INSERT INTO videos (title, filename, filepath) VALUES (?, ?, ?)`;
    db.run(sql, [title, file.filename, file.path], function (err) {
        if (err) return res.status(500).send('Terjadi kesalahan database.');
        res.send(`<h3>Upload Berhasil!</h3><p>Video <b>${title}</b> tersimpan.</p><a href="/">Kembali</a>`);
    });
});

// --- RUTE UNTUK MENGAMBIL DAFTAR VIDEO ---
app.get('/api/videos', (req, res) => {
    db.all('SELECT * FROM videos ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ videos: rows });
    });
});

// --- RUTE UNTUK MELIHAT STREAMING YANG SEDANG AKTIF (BARU) ---
app.get('/api/active', (req, res) => {
    const sql = `
        SELECT streams.*, videos.title 
        FROM streams 
        JOIN videos ON streams.video_id = videos.id 
        WHERE streams.status = 'live'
    `;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ active: rows });
    });
});

// --- RUTE UNTUK MENGHENTIKAN STREAMING (BARU) ---
app.post('/api/stop/:videoId', (req, res) => {
    const videoId = parseInt(req.params.videoId);

    // Mengecek apakah remot kontrol FFmpeg-nya ada di buku catatan kita
    if (activeStreams.has(videoId)) {
        const command = activeStreams.get(videoId);
        command.kill('SIGKILL'); // Mematikan paksa FFmpeg
        activeStreams.delete(videoId); // Hapus dari buku catatan

        // Ubah status di database
        db.run(`UPDATE streams SET status = 'stopped' WHERE video_id = ? AND status = 'live'`, [videoId]);
        res.json({ message: 'Streaming berhasil dihentikan!' });
    } else {
        res.status(404).json({ message: 'Tidak ada streaming aktif untuk video ini di memori.' });
    }
});

// --- FUNGSI UNTUK MENJALANKAN FFMPEG (DIPERBARUI) ---
function jalankanStreaming(videoPath, streamDestination, videoTitle, videoId, streamId) {
    console.log(`[STREAMING] Memulai siaran untuk video: ${videoTitle}`);

    const command = ffmpeg(videoPath)
        .inputOptions(['-re', '-stream_loop', '-1'])
        .videoCodec('libx264')
        .audioCodec('aac')
        .format('flv')
        .outputOptions(['-preset veryfast', '-maxrate 2500k', '-bufsize 5000k', '-pix_fmt yuv420p', '-g 50'])
        .on('start', () => console.log(`[FFMPEG] Proses berjalan untuk: ${videoTitle}`))
        .on('error', (err) => {
            console.error('[FFMPEG ERROR/STOPPED]:', err.message);
            activeStreams.delete(videoId);
            db.run(`UPDATE streams SET status = 'error_or_stopped' WHERE id = ?`, [streamId]);
        })
        .on('end', () => {
            console.log(`[STREAMING] Selesai: ${videoTitle}`);
            activeStreams.delete(videoId);
            db.run(`UPDATE streams SET status = 'finished' WHERE id = ?`, [streamId]);
        });

    command.save(streamDestination);

    // Simpan remot kontrolnya ke dalam buku catatan (berdasarkan ID Video)
    activeStreams.set(videoId, command);
}

// --- RUTE UNTUK MENYIMPAN JADWAL STREAMING ---
app.post('/api/schedule/:id', (req, res) => {
    const videoId = req.params.id;
    const { rtmpUrl, streamKey, scheduledTime } = req.body;

    if (!streamKey || !scheduledTime) return res.status(400).send('Stream Key dan Waktu wajib diisi!');

    const sql = `INSERT INTO streams (video_id, platform_name, stream_url, stream_key, scheduled_time, status) 
                 VALUES (?, 'YouTube', ?, ?, ?, 'pending')`;

    db.run(sql, [videoId, rtmpUrl, streamKey, scheduledTime], function (err) {
        if (err) return res.status(500).send('Gagal menyimpan jadwal.');
        res.json({ message: `Jadwal berhasil disimpan untuk waktu: ${scheduledTime}` });
    });
});

// --- CRON JOB: PENGECEKAN JADWAL SETIAP MENIT ---
cron.schedule('* * * * *', () => {
    const sql = `
        SELECT streams.*, videos.filepath, videos.title 
        FROM streams 
        JOIN videos ON streams.video_id = videos.id 
        WHERE streams.status = 'pending' AND datetime(streams.scheduled_time) <= datetime('now', 'localtime')
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return console.error('[CRON ERROR]', err.message);

        rows.forEach(stream => {
            const videoPath = path.resolve(__dirname, stream.filepath);
            const streamDestination = `${stream.stream_url}/${stream.stream_key}`;

            db.run(`UPDATE streams SET status = 'live' WHERE id = ?`, [stream.id]);

            // Panggil FFmpeg dan kirim juga ID Video dan ID Stream
            jalankanStreaming(videoPath, streamDestination, stream.title, stream.video_id, stream.id);
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server berhasil berjalan di http://localhost:${PORT}`);
});