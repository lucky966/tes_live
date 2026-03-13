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
const { google } = require('googleapis');

ffmpeg.setFfmpegPath(ffmpegInstaller);
const activeStreams = new Map();

const app = express();
const PORT = process.env.PORT || 7575;

// --- GOOGLE OAUTH SETUP ---
const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

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

// --- RUTE HALAMAN FRONTEND ---
app.get('/', (req, res) => {
    db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('live', 'pending') ORDER BY streams.scheduled_time ASC`, [], (err, rows) => {
        res.render('dashboard', { pageTitle: 'Dashboard Ringkasan', schedules: rows || [], currentPath: req.path });
    });
});
app.get('/lives', (req, res) => res.render('lives', { pageTitle: 'Manajemen Konten Live', currentPath: req.path }));
app.get('/videos', (req, res) => res.render('videos', { pageTitle: 'Koleksi Berkas Video', currentPath: req.path }));
app.get('/archives', (req, res) => res.render('archives', { pageTitle: 'Arsip & Riwayat Live', currentPath: req.path }));
app.get('/accounts', (req, res) => res.render('accounts', { pageTitle: 'Akun YouTube Tertaut', currentPath: req.path }));

// --- SISTEM LOGIN YOUTUBE ---
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline', prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube.readonly']
    });
    res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);

        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelRes = await youtube.channels.list({ part: 'snippet', mine: true });
        const channelName = channelRes.data.items[0].snippet.title;

        db.run(`INSERT INTO accounts (channel_name, access_token, refresh_token, expiry_date) VALUES (?, ?, ?, ?)`,
            [channelName, tokens.access_token, tokens.refresh_token, tokens.expiry_date], function (err) {
                res.send('<h3>Berhasil Terhubung!</h3><script>setTimeout(()=>window.location.href="/accounts", 2000)</script>');
            });
    } catch (error) { res.status(500).send('Gagal login: ' + error.message); }
});

app.get('/api/accounts', (req, res) => db.all('SELECT id, channel_name FROM accounts ORDER BY id DESC', [], (err, rows) => res.json({ accounts: rows || [] })));
app.post('/api/accounts/delete/:id', (req, res) => db.run(`DELETE FROM accounts WHERE id = ?`, [req.params.id], () => res.json({ message: 'Terhapus' })));


// --- API YOUTUBE: BUAT JADWAL & STREAM KEY OTOMATIS + THUMBNAIL ---
app.post('/api/schedule', upload.single('thumbnail'), async (req, res) => {
    try {
        const { accountId, videoId, title, description, tags, streamKeyName, scheduledTime, endTime } = req.body;
        const isAI = req.body.isAI === 'true';
        const isDaily = req.body.isDaily === 'true';

        if (!accountId || !videoId || !title || !scheduledTime || !streamKeyName) {
            return res.status(400).json({ message: 'Akun, Video, Judul, Waktu, dan Nama Key wajib diisi!' });
        }

        db.get('SELECT * FROM accounts WHERE id = ?', [accountId], async (err, account) => {
            if (err || !account) return res.status(400).json({ message: 'Akun YouTube tidak ditemukan.' });

            try {
                oauth2Client.setCredentials({ access_token: account.access_token, refresh_token: account.refresh_token, expiry_date: account.expiry_date });
                const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

                const finalDesc = isAI ? `${description}\n\n[Disclaimer: Konten ini dimodifikasi menggunakan AI]` : description;

                // 1. Buat Broadcast di YouTube
                const broadcastRes = await youtube.liveBroadcasts.insert({
                    part: 'snippet,status,contentDetails',
                    requestBody: {
                        snippet: { title: title, description: finalDesc, scheduledStartTime: new Date(scheduledTime).toISOString(), scheduledEndTime: new Date(endTime).toISOString() },
                        status: { privacyStatus: 'public' },
                        contentDetails: { enableAutoStart: true, enableAutoStop: true }
                    }
                });
                const broadcastId = broadcastRes.data.id;

                // 2. Buat Stream Key Otomatis dengan NAMA KUSTOM
                const streamRes = await youtube.liveStreams.insert({
                    part: 'snippet,cdn',
                    requestBody: {
                        snippet: { title: streamKeyName }, // <--- NAMA STREAM KEY
                        cdn: { frameRate: '30fps', ingestionType: 'rtmp', resolution: '720p' }
                    }
                });
                const streamId = streamRes.data.id;
                const streamKey = streamRes.data.cdn.ingestionInfo.streamName;
                // KITA PAKSA GUNAKAN RTMP STANDAR AGAR FFMPEG TIDAK BINGUNG
                const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';

                // 3. Gabungkan Broadcast dengan Stream Key
                await youtube.liveBroadcasts.bind({ part: 'id', id: broadcastId, streamId: streamId });

                // 4. Upload Thumbnail (Jika ada)
                if (req.file) {
                    await youtube.thumbnails.set({
                        videoId: broadcastId,
                        media: { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) }
                    });
                }

                // 5. Simpan ke database lokal
                const sql = `INSERT INTO streams (video_id, platform_name, stream_url, stream_key, scheduled_time, end_time, is_daily, status) VALUES (?, 'YouTube', ?, ?, ?, ?, ?, 'pending')`;
                db.run(sql, [videoId, rtmpUrl, streamKey, scheduledTime, endTime, isDaily ? 1 : 0], function (err) {
                    if (err) throw err;
                    res.json({ message: 'Sukses! Live & Stream Key berhasil dibuat di YouTube.' });
                });

            } catch (error) {
                console.error('API Error Detail:', error.errors || error.message);
                res.status(500).json({ message: 'Gagal menghubungi YouTube API: ' + (error.message || 'Cek konsol server') });
            }
        });
    } catch (error) { res.status(500).json({ message: 'Kesalahan Server Internal.' }); }
});


// --- SISA CRUD LOKAL & MESIN FFMPEG ---
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    db.run(`INSERT INTO videos (title, filename, filepath) VALUES (?, ?, ?)`, [req.body.title, req.file.filename, req.file.path], () => res.redirect('/videos'));
});
app.get('/api/videos', (req, res) => db.all('SELECT * FROM videos ORDER BY created_at DESC', [], (err, rows) => res.json({ videos: rows })));
app.get('/api/active-and-pending', (req, res) => db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('live', 'pending') ORDER BY streams.scheduled_time ASC`, [], (err, rows) => res.json({ schedules: rows })));
app.get('/api/archives', (req, res) => db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('finished', 'stopped', 'error') ORDER BY streams.created_at DESC`, [], (err, rows) => res.json({ archives: rows })));
app.post('/api/delete/:id', (req, res) => db.run(`DELETE FROM streams WHERE id = ?`, [req.params.id], () => res.json({ message: 'Dihapus' })));
app.post('/api/stop/:streamId', (req, res) => {
    db.get('SELECT video_id FROM streams WHERE id = ?', [req.params.streamId], (err, row) => {
        if (row && activeStreams.has(row.video_id)) { activeStreams.get(row.video_id).kill('SIGKILL'); activeStreams.delete(row.video_id); }
        db.run(`UPDATE streams SET status = 'stopped' WHERE id = ?`, [req.params.streamId], () => res.json({ message: 'Dihentikan' }));
    });
});

function jalankanStreaming(videoPath, streamDestination, videoTitle, videoId, streamId) {
    const command = ffmpeg(videoPath).inputOptions(['-re', '-stream_loop', '-1']).videoCodec('libx264').audioCodec('aac').format('flv')
        .outputOptions(['-preset veryfast', '-maxrate 2500k', '-bufsize 5000k', '-pix_fmt yuv420p', '-g 50'])
        .on('error', () => { activeStreams.delete(videoId); db.run(`UPDATE streams SET status = 'error' WHERE id = ?`, [streamId]); })
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