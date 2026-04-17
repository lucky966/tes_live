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

// --- RUTE HALAMAN ---
app.get('/', (req, res) => {
    db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('live', 'pending') ORDER BY streams.scheduled_time ASC`, [], (err, rows) => {
        res.render('dashboard', { pageTitle: 'Dashboard Ringkasan', schedules: rows || [], currentPath: req.path });
    });
});
app.get('/lives', (req, res) => res.render('lives', { pageTitle: 'Manajemen Konten Live', currentPath: req.path }));
app.get('/videos', (req, res) => res.render('videos', { pageTitle: 'Koleksi Berkas Video', currentPath: req.path }));
app.get('/archives', (req, res) => res.render('archives', { pageTitle: 'Arsip & Riwayat Live', currentPath: req.path }));
app.get('/accounts', (req, res) => res.render('accounts', { pageTitle: 'Akun YouTube Tertaut', currentPath: req.path }));

// --- API AKUN ---
app.get('/auth/google', (req, res) => {
    const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube.readonly'] });
    res.redirect(url);
});
app.get('/oauth2callback', async (req, res) => {
    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);
        
        const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
        const channelRes = await youtube.channels.list({ part: 'snippet', mine: true });
        
        // Tangkap Nama dan FOTO PROFIL
        const channelName = channelRes.data.items[0].snippet.title;
        const profileImg = channelRes.data.items[0].snippet.thumbnails.default.url;

        // Simpan ke database beserta link fotonya
        db.run(`INSERT INTO accounts (channel_name, access_token, refresh_token, expiry_date, profile_image_url) VALUES (?, ?, ?, ?, ?)`, 
        [channelName, tokens.access_token, tokens.refresh_token, tokens.expiry_date, profileImg], function(err) {
            res.send('<h3>Berhasil Terhubung!</h3><script>setTimeout(()=>window.location.href="/accounts", 2000)</script>');
        });
    } catch (error) { res.status(500).send('Gagal login: ' + error.message); }
});
app.get('/api/accounts', (req, res) => db.all('SELECT * FROM accounts ORDER BY id DESC', [], (err, rows) => res.json({ accounts: rows || [] })));
app.post('/api/accounts/update/:id', (req, res) => {
    const { niche, default_title, default_desc, default_tags } = req.body;
    db.run(`UPDATE accounts SET niche=?, default_title=?, default_desc=?, default_tags=? WHERE id=?`, [niche, default_title, default_desc, default_tags, req.params.id], (err) => res.json({ message: 'Tersimpan' }));
});
app.post('/api/accounts/delete/:id', (req, res) => db.run(`DELETE FROM accounts WHERE id = ?`, [req.params.id], () => res.json({ message: 'Terhapus' })));

// --- API KATEGORI ---
app.get('/api/categories', (req, res) => db.all('SELECT * FROM categories ORDER BY name ASC', [], (err, rows) => res.json({ categories: rows || [] })));
app.post('/api/categories', (req, res) => db.run('INSERT INTO categories (name) VALUES (?)', [req.body.name], (err) => res.json({ message: 'Ditambahkan' })));

// --- API VIDEO ---
app.post('/api/upload', upload.single('videoFile'), (req, res) => {
    const accountId = req.body.accountId || null;
    db.run(`INSERT INTO videos (title, filename, filepath, account_id) VALUES (?, ?, ?, ?)`, [req.body.title, req.file.filename, req.file.path, accountId], () => res.redirect('/videos'));
});

app.get('/api/videos', (req, res) => {
    db.all(`SELECT videos.*, accounts.channel_name FROM videos LEFT JOIN accounts ON videos.account_id = accounts.id ORDER BY videos.created_at DESC`, [], (err, rows) => res.json({ videos: rows || [] }));
});

// TAMBAHKAN RUTE INI UNTUK MENGHAPUS VIDEO YANG SALAH
app.post('/api/videos/delete/:id', (req, res) => {
    db.get('SELECT filepath FROM videos WHERE id = ?', [req.params.id], (err, row) => {
        if (row) {
            // 1. Hapus file fisiknya dari folder uploads
            fs.unlink(path.resolve(__dirname, row.filepath), (err) => {
                if (err) console.error("Gagal menghapus file fisik:", err);
            });
            // 2. Hapus datanya dari tabel database
            db.run('DELETE FROM videos WHERE id = ?', [req.params.id], () => res.json({ message: 'Video terhapus' }));
        } else {
            res.status(404).json({ message: 'Video tidak ditemukan' });
        }
    });
});

// --- API STREAM ---
app.get('/api/active-and-pending', (req, res) => {
    const sql = `SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id ORDER BY CASE streams.status WHEN 'live' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, streams.scheduled_time DESC`;
    db.all(sql, [], (err, rows) => res.json({ schedules: rows || [] }));
});
app.get('/api/archives', (req, res) => db.all(`SELECT streams.*, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status IN ('finished', 'stopped', 'error') ORDER BY streams.created_at DESC`, [], (err, rows) => res.json({ archives: rows })));
app.post('/api/delete/:id', (req, res) => db.run(`DELETE FROM streams WHERE id = ?`, [req.params.id], () => res.json({ message: 'Dihapus' })));
app.post('/api/stop/:streamId', (req, res) => {
    db.get('SELECT video_id FROM streams WHERE id = ?', [req.params.streamId], (err, row) => {
        if (row && activeStreams.has(row.video_id)) { activeStreams.get(row.video_id).kill('SIGKILL'); activeStreams.delete(row.video_id); }
        db.run(`UPDATE streams SET status = 'stopped' WHERE id = ?`, [req.params.streamId], () => res.json({ message: 'Dihentikan' }));
    });
});

// --- API BUAT JADWAL & YOUTUBE ---
app.post('/api/schedule', upload.single('thumbnail'), async (req, res) => {
    try {
        const { editId, accountId, videoId, title, description, tags, streamKeyName, scheduledTime, endTime } = req.body;
        const isAI = req.body.isAI === 'true';
        const isDaily = req.body.isDaily === 'true';

        if (!accountId || !videoId || !title || !scheduledTime || !streamKeyName) return res.status(400).json({ message: 'Data wajib diisi!' });

        db.get('SELECT * FROM accounts WHERE id = ?', [accountId], async (err, account) => {
            if (err || !account) return res.status(400).json({ message: 'Akun YouTube tidak ditemukan.' });
            try {
                oauth2Client.setCredentials({ access_token: account.access_token, refresh_token: account.refresh_token, expiry_date: account.expiry_date });
                const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
                const finalDesc = isAI ? `${description}\n\n[Disclaimer: Konten ini dimodifikasi menggunakan AI]` : description;

                const broadcastRes = await youtube.liveBroadcasts.insert({
                    part: 'snippet,status,contentDetails',
                    requestBody: {
                        snippet: { title: title, description: finalDesc, scheduledStartTime: new Date(scheduledTime).toISOString(), scheduledEndTime: new Date(endTime).toISOString() },
                        status: { privacyStatus: 'public' }, contentDetails: { enableAutoStart: true, enableAutoStop: true }
                    }
                });
                const broadcastId = broadcastRes.data.id;

                const streamRes = await youtube.liveStreams.insert({
                    part: 'snippet,cdn', requestBody: { snippet: { title: streamKeyName }, cdn: { frameRate: '30fps', ingestionType: 'rtmp', resolution: '720p' } }
                });
                const streamId = streamRes.data.id;
                const streamKey = streamRes.data.cdn.ingestionInfo.streamName;
                const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';

                await youtube.liveBroadcasts.bind({ part: 'id', id: broadcastId, streamId: streamId });

                if (req.file) await youtube.thumbnails.set({ videoId: broadcastId, media: { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) } });

                // DETEKTOR ERROR DATABASE (Jika gagal, tidak akan memunculkan 'Sukses')
                if (editId && editId !== 'null' && editId !== '') {
                    db.run(`UPDATE streams SET video_id=?, account_id=?, yt_title=?, yt_desc=?, platform_name='YouTube', stream_url=?, stream_key=?, scheduled_time=?, end_time=?, is_daily=?, status='pending' WHERE id=?`,
                        [videoId, accountId, title, finalDesc, rtmpUrl, streamKey, scheduledTime, endTime, isDaily ? 1 : 0, editId], function (err) {
                            if (err) return res.status(500).json({ message: 'Gagal update database lokal: ' + err.message });
                            res.json({ message: 'Jadwal diperbarui!' });
                        });
                } else {
                    db.run(`INSERT INTO streams (video_id, account_id, yt_title, yt_desc, platform_name, stream_url, stream_key, scheduled_time, end_time, is_daily, status) VALUES (?, ?, ?, ?, 'YouTube', ?, ?, ?, ?, ?, 'pending')`,
                        [videoId, accountId, title, finalDesc, rtmpUrl, streamKey, scheduledTime, endTime, isDaily ? 1 : 0], function (err) {
                            if (err) return res.status(500).json({ message: 'Gagal simpan ke database lokal: ' + err.message });
                            res.json({ message: 'Live dibuat!' });
                        });
                }
            } catch (error) { res.status(500).json({ message: 'Error API YouTube: ' + (error.message || 'Cek console') }); }
        });
    } catch (error) { res.status(500).json({ message: 'Internal Server Error' }); }
});
// --- API RESET TOTAL ---
app.post('/api/reset', (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM streams'); db.run('DELETE FROM videos'); db.run('DELETE FROM accounts'); db.run('DELETE FROM categories');
        db.run('DELETE FROM sqlite_sequence');
        const uploadDir = path.join(__dirname, 'uploads');
        fs.readdir(uploadDir, (err, files) => {
            if (!err) files.forEach(file => fs.unlink(path.join(uploadDir, file), () => { }));
        });
        const defaults = [''];
        defaults.forEach(cat => db.run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [cat]));
        res.json({ message: 'Pembersihan Total Selesai!' });
    });
});

/// --- CRON FFMPEG MESIN STREAMING (DENGAN RADAR PELACAK ERROR) ---
function jalankanStreaming(videoPath, streamDestination, videoTitle, videoId, streamId) {
    console.log(`\n🚀 [MENCOBA STREAMING] Memulai tugas video: ${videoTitle}`);
    console.log(`📂 [PATH VIDEO] : ${videoPath}`);
    console.log(`🌐 [TUJUAN]   : ${streamDestination}`);

    const command = ffmpeg(videoPath).inputOptions(['-re', '-stream_loop', '-1']).videoCodec('libx264').audioCodec('aac').format('flv')
        .outputOptions(['-preset veryfast', '-maxrate 2500k', '-bufsize 5000k', '-pix_fmt yuv420p', '-g 50'])
        .on('start', (cmd) => {
            console.log(`✅ [FFMPEG JALAN] Mesin berhasil menyala!`);
        })
        .on('error', (err, stdout, stderr) => {
            console.error('\n❌ [FFMPEG GAGAL CRASH]:', err.message);
            console.error('🔍 [ALASAN ASLI FFMPEG]:\n', stderr); // Ini akan membongkar rahasianya
            activeStreams.delete(videoId);
            db.run(`UPDATE streams SET status = 'error' WHERE id = ?`, [streamId]);
        })
        .on('end', () => {
            console.log(`🛑 [FFMPEG SELESAI] Video ${videoTitle} berakhir alami.`);
            activeStreams.delete(videoId);
        });
    command.save(streamDestination);
    activeStreams.set(videoId, command);
}

cron.schedule('* * * * *', () => {
    // 1. KITA AMBIL WAKTU ASLI DARI SISTEM KOMPUTER (Sangat Akurat)
    const waktuSekarang = new Date();
    console.log(`\n⏳ [CRON DETAK] Waktu Server: ${waktuSekarang.toLocaleString('id-ID')}`);

    // 2. KITA TARIK SEMUA JADWAL PENDING (Tanpa peduli waktu di SQLite)
    db.all(`SELECT streams.*, videos.filepath, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status = 'pending'`, [], (err, rows) => {
        if (err) return console.error('❌ Error DB Cron:', err.message);

        rows.forEach(stream => {
            // Kita ubah teks waktu di database menjadi format Jam JavaScript
            const waktuJadwal = new Date(stream.scheduled_time);

            // LOG PELACAK: Menampilkan perbandingan jam di terminalmu!
            console.log(`   👉 Cek [${stream.title}]: Jadwal= ${waktuJadwal.toLocaleString('id-ID')} | Status= ${waktuSekarang >= waktuJadwal ? 'SIAP LIVE!' : 'Menunggu...'}`);

            // JIKA WAKTU SEKARANG SUDAH MELEWATI (ATAU SAMA DENGAN) WAKTU JADWAL
            if (waktuSekarang >= waktuJadwal) {
                console.log(`🎯 [DITEMUKAN] Waktunya tiba untuk: ${stream.title}! Menyiapkan mesin...`);

                db.run(`UPDATE streams SET status = 'live' WHERE id = ?`, [stream.id]);
                jalankanStreaming(path.resolve(__dirname, stream.filepath), `${stream.stream_url}/${stream.stream_key}`, stream.title, stream.video_id, stream.id);
            }
        });
    });

    // 3. KITA TARIK SEMUA JADWAL LIVE UNTUK DICEK KAPAN HARUS MATI
    db.all(`SELECT * FROM streams WHERE status = 'live'`, [], (err, rows) => {
        rows.forEach(stream => {
            const waktuSelesai = new Date(stream.end_time);

            // JIKA WAKTU SEKARANG SUDAH MELEWATI WAKTU SELESAI
            if (waktuSekarang >= waktuSelesai) {
                console.log(`⏹️ [WAKTU HABIS] Mematikan paksa stream ${stream.id}`);

                if (activeStreams.has(stream.video_id)) {
                    activeStreams.get(stream.video_id).kill('SIGKILL');
                    activeStreams.delete(stream.video_id);
                }

                if (stream.is_daily === 1) {
                    db.run(`UPDATE streams SET status = 'pending', scheduled_time = datetime(scheduled_time, '+1 day'), end_time = datetime(end_time, '+1 day') WHERE id = ?`, [stream.id]);
                } else {
                    db.run(`UPDATE streams SET status = 'finished' WHERE id = ?`, [stream.id]);
                }
            }
        });
    });
});

app.listen(PORT, () => console.log(`Server berjalan di http://localhost:${PORT}`));