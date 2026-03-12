require('dotenv').config();
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const db = require('./config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegInstaller); 
const activeStreams = new Map(); 

const app = express();
const PORT = process.env.PORT || 7575;

app.use(expressLayouts);
app.set('layout', 'layout'); 
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// --- RUTE HALAMAN (FRONTEND) ---
app.get('/', (req, res) => {
    const sql = `SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('live', 'pending') ORDER BY streams.scheduled_time ASC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).send('Database Error.');
        res.render('dashboard', { pageTitle: 'Dashboard Ringkasan', schedules: rows, currentPath: req.path });
    });
});
app.get('/lives', (req, res) => res.render('lives', { pageTitle: 'Manajemen Konten Live', currentPath: req.path }));
app.get('/videos', (req, res) => res.render('videos', { pageTitle: 'Koleksi Berkas Video', currentPath: req.path }));
app.get('/archives', (req, res) => res.render('archives', { pageTitle: 'Arsip & Riwayat Live', currentPath: req.path })); // HALAMAN BARU

// --- API CRUD ---
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    if (!req.file) return res.status(400).send('Pilih video!');
    db.run(`INSERT INTO videos (title, filename, filepath) VALUES (?, ?, ?)`, [req.body.title, req.file.filename, req.file.path], function (err) {
        if (err) return res.status(500).send('Error DB.');
        res.redirect('/videos'); 
    });
});
app.get('/api/videos', (req, res) => {
    db.all('SELECT * FROM videos ORDER BY created_at DESC', [], (err, rows) => res.json({ videos: rows }));
});
app.post('/api/schedule', (req, res) => {
    const { videoId, streamKey, scheduledTime, endTime, isDaily } = req.body;
    const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';
    if (!videoId || !streamKey || !scheduledTime || !endTime) return res.status(400).send('Lengkapi form!');
    db.run(`INSERT INTO streams (video_id, platform_name, stream_url, stream_key, scheduled_time, end_time, is_daily, status) VALUES (?, 'YouTube', ?, ?, ?, ?, ?, 'pending')`, 
    [videoId, rtmpUrl, streamKey, scheduledTime, endTime, isDaily ? 1 : 0], function (err) {
        if (err) return res.status(500).send('Gagal.');
        res.json({ message: 'Jadwal dibuat!' });
    });
});
app.get('/api/active-and-pending', (req, res) => {
    db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('live', 'pending') ORDER BY streams.scheduled_time ASC`, [], (err, rows) => res.json({ schedules: rows }));
});

// --- API BARU: ARSIP, EDIT, HAPUS ---
app.get('/api/archives', (req, res) => {
    db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('finished', 'stopped', 'error') ORDER BY streams.created_at DESC`, [], (err, rows) => res.json({ archives: rows }));
});
app.post('/api/update/:id', (req, res) => {
    const { streamKey, scheduledTime, endTime, isDaily } = req.body;
    db.run(`UPDATE streams SET stream_key = ?, scheduled_time = ?, end_time = ?, is_daily = ? WHERE id = ?`, 
    [streamKey, scheduledTime, endTime, isDaily ? 1 : 0, req.params.id], function (err) {
        if (err) return res.status(500).send('Gagal update.');
        res.json({ message: 'Jadwal diperbarui!' });
    });
});
app.post('/api/delete/:id', (req, res) => {
    db.run(`DELETE FROM streams WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).send('Gagal hapus.');
        res.json({ message: 'Riwayat dihapus!' });
    });
});
// ------------------------------------

app.post('/api/stop/:streamId', (req, res) => {
    const streamId = req.params.streamId;
    db.get('SELECT video_id FROM streams WHERE id = ?', [streamId], (err, row) => {
        if (row && activeStreams.has(row.video_id)) {
            activeStreams.get(row.video_id).kill('SIGKILL'); activeStreams.delete(row.video_id);
        }
        db.run(`UPDATE streams SET status = 'stopped' WHERE id = ?`, [streamId]);
        res.json({ message: 'Siaran dihentikan!' });
    });
});

// --- MESIN FFMPEG & CRON ---
function jalankanStreaming(videoPath, streamDestination, videoTitle, videoId, streamId) {
    console.log(`[START] Siaran: ${videoTitle}`);
    const command = ffmpeg(videoPath).inputOptions(['-re', '-stream_loop', '-1']).videoCodec('libx264').audioCodec('aac').format('flv')
        .outputOptions(['-preset veryfast', '-maxrate 2500k', '-bufsize 5000k', '-pix_fmt yuv420p', '-g 50'])
        .on('error', (err) => { activeStreams.delete(videoId); db.run(`UPDATE streams SET status = 'error' WHERE id = ?`, [streamId]); })
        .on('end', () => activeStreams.delete(videoId));
    command.save(streamDestination); activeStreams.set(videoId, command);
}
cron.schedule('* * * * *', () => {
    db.all(`SELECT streams.*, videos.filepath, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status = 'pending' AND datetime(streams.scheduled_time) <= datetime('now', 'localtime')`, [], (err, rows) => {
        rows.forEach(stream => {
            db.run(`UPDATE streams SET status = 'live' WHERE id = ?`, [stream.id]);
            jalankanStreaming(path.resolve(__dirname, stream.filepath), `${stream.stream_url}/${stream.stream_key}`, stream.title, stream.video_id, stream.id);
        });
    });
    db.all(`SELECT * FROM streams WHERE status = 'live' AND datetime(end_time) <= datetime('now', 'localtime')`, [], (err, rows) => {
        rows.forEach(stream => {
            if (activeStreams.has(stream.video_id)) { activeStreams.get(stream.video_id).kill('SIGKILL'); activeStreams.delete(stream.video_id); }
            if (stream.is_daily === 1) {
                db.run(`UPDATE streams SET status = 'pending', scheduled_time = datetime(scheduled_time, '+1 day'), end_time = datetime(end_time, '+1 day') WHERE id = ?`, [stream.id]);
            } else { db.run(`UPDATE streams SET status = 'finished' WHERE id = ?`, [stream.id]); }
        });
    });
});

app.listen(PORT, () => console.log(`Server Studio berjalan di http://localhost:${PORT}`));