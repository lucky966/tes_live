require('dotenv').config();
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const db = require('./config/database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const ffmpeg = require('fluent-ffmpeg');

// Paksa gunakan FFmpeg resmi dari Ubuntu
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg'); const os = require('os');
const ffmpegPath = require('ffmpeg-static');

// Deteksi OS otomatis
if (os.platform() === 'win32') {
    // Jika jalan di Laptop Windows, pakai ffmpeg-static bawaan
    ffmpeg.setFfmpegPath(ffmpegPath);
    console.log("🖥️ [SISTEM] Menjalankan FFmpeg versi Windows");
} else {
    // Jika jalan di VPS Linux, paksa pakai FFmpeg Ubuntu agar tidak Crash (SIGSEGV)
    ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
    console.log("🐧 [SISTEM] Menjalankan FFmpeg versi Server Linux");
}

const { google } = require('googleapis');

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
app.get('/settings', (req, res) => res.render('settings', { pageTitle: 'Pengaturan API Google', currentPath: req.path }));

// --- CRUD GOOGLE PROJECTS ---
app.get('/api/projects', (req, res) => db.all('SELECT * FROM google_projects ORDER BY id DESC', [], (err, rows) => res.json({ projects: rows || [] })));
app.post('/api/projects/add', (req, res) => db.run(`INSERT INTO google_projects (name, client_id, client_secret, redirect_uri) VALUES (?, ?, ?, ?)`, [req.body.name, req.body.client_id, req.body.client_secret, req.body.redirect_uri], () => res.json({ message: 'Tersimpan' })));
app.post('/api/projects/delete/:id', (req, res) => db.run('DELETE FROM google_projects WHERE id = ?', [req.params.id], () => res.json({ message: 'Terhapus' })));

// --- API AKUN (MULTI-KEY OAUTH) ---
app.get('/auth/google', (req, res) => {
    const projectId = req.query.projectId;
    if (!projectId) return res.send('Project ID tidak ditemukan.');

    db.get('SELECT * FROM google_projects WHERE id = ?', [projectId], (err, project) => {
        if (!project) return res.send('Kunci API tidak ada di database.');
        const dynamicOauth = new google.auth.OAuth2(project.client_id, project.client_secret, project.redirect_uri);
        const url = dynamicOauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtube.readonly'], state: projectId.toString() });
        res.redirect(url);
    });
});

app.get('/oauth2callback', (req, res) => {
    const projectId = req.query.state;
    db.get('SELECT * FROM google_projects WHERE id = ?', [projectId], async (err, project) => {
        if (!project) return res.send('Kunci API Hilang.');
        const dynamicOauth = new google.auth.OAuth2(project.client_id, project.client_secret, project.redirect_uri);

        try {
            const { tokens } = await dynamicOauth.getToken(req.query.code);
            dynamicOauth.setCredentials(tokens);
            const youtube = google.youtube({ version: 'v3', auth: dynamicOauth });
            const channelRes = await youtube.channels.list({ part: 'snippet', mine: true });
            const channelName = channelRes.data.items[0].snippet.title;
            const profileImg = channelRes.data.items[0].snippet.thumbnails.default.url;

            db.run(`INSERT INTO accounts (channel_name, access_token, refresh_token, expiry_date, profile_image_url, project_id) VALUES (?, ?, ?, ?, ?, ?)`,
                [channelName, tokens.access_token, tokens.refresh_token, tokens.expiry_date, profileImg, projectId], function (err) {
                    res.send('<h3>Berhasil Terhubung dengan API Khusus!</h3><script>setTimeout(()=>window.location.href="/accounts", 2000)</script>');
                });
        } catch (error) { res.status(500).send('Gagal login: ' + error.message); }
    });
});
// --- API BUAT JADWAL YOUTUBE (DINAMIS DENGAN KATEGORI & AI) ---
app.post('/api/schedule', upload.single('thumbnail'), async (req, res) => {
    try {
        const { editId, accountId, videoId, title, description, tags, streamKeyName, scheduledTime, endTime } = req.body;
        const isDaily = req.body.isDaily === 'true';

        // Tangkap Kategori & AI dari form Frontend
        const categoryId = req.body.categoryId || '22';
        const isAlteredContent = req.body.isAlteredContent === 'true';

        // PERBAIKAN HASHTAG: Ubah teks "a, b, c" menjadi format Array ["a", "b", "c"] khusus untuk YouTube
        let tagsArray = [];
        if (tags && tags.trim() !== '') {
            tagsArray = tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '');
        }

        if (!accountId || !videoId || !title || !scheduledTime || !streamKeyName) return res.status(400).json({ message: 'Data wajib diisi!' });

        db.get('SELECT accounts.*, google_projects.client_id, google_projects.client_secret, google_projects.redirect_uri FROM accounts JOIN google_projects ON accounts.project_id = google_projects.id WHERE accounts.id = ?', [accountId], async (err, account) => {
            if (err || !account) return res.status(400).json({ message: 'Akun atau Kunci API sudah terhapus.' });

            try {
                const dynamicOauth = new google.auth.OAuth2(account.client_id, account.client_secret, account.redirect_uri);
                dynamicOauth.setCredentials({ access_token: account.access_token, refresh_token: account.refresh_token, expiry_date: account.expiry_date });
                const youtube = google.youtube({ version: 'v3', auth: dynamicOauth });

                // 1. BUAT BROADCAST (Tanpa teks Disclaimer AI di deskripsi)
                const broadcastRes = await youtube.liveBroadcasts.insert({
                    part: 'snippet,status,contentDetails',
                    requestBody: {
                        snippet: {
                            title: title,
                            description: description, // Menggunakan deskripsi asli tanpa tambahan teks
                            scheduledStartTime: new Date(scheduledTime).toISOString(),
                            scheduledEndTime: new Date(endTime).toISOString()
                        },
                        status: { privacyStatus: 'public' },
                        contentDetails: { enableAutoStart: true, enableAutoStop: true }
                    }
                });

                const broadcastId = broadcastRes.data.id;

                // 2. UPDATE VIDEO UNTUK MENYUNTIKKAN KATEGORI, TAGS, DAN KONTEN AI
                const videoUpdateBody = {
                    id: broadcastId,
                    snippet: {
                        title: title,
                        description: description,
                        categoryId: categoryId
                    },
                    status: {
                        privacyStatus: 'public',
                        containsSyntheticMedia: isAlteredContent // Centang AI otomatis di sistem YouTube
                    }
                };

                // Masukkan Tag hanya jika ada isinya
                if (tagsArray.length > 0) {
                    videoUpdateBody.snippet.tags = tagsArray;
                }

                await youtube.videos.update({
                    part: 'snippet,status',
                    requestBody: videoUpdateBody
                });

                // 3. BUAT STREAM KEY
                const streamRes = await youtube.liveStreams.insert({
                    part: 'snippet,cdn', requestBody: { snippet: { title: streamKeyName }, cdn: { frameRate: '30fps', ingestionType: 'rtmp', resolution: '720p' } }
                });

                // 4. IKAT STREAM KE BROADCAST
                await youtube.liveBroadcasts.bind({ part: 'id', id: broadcastId, streamId: streamRes.data.id });

                // 5. UPLOAD THUMBNAIL JIKA ADA
                if (req.file) await youtube.thumbnails.set({ videoId: broadcastId, media: { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) } });

                const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2';
                const streamKey = streamRes.data.cdn.ingestionInfo.streamName;

                // Simpan ke database lokal
                if (editId && editId !== 'null' && editId !== '') {
                    db.run(`UPDATE streams SET video_id=?, account_id=?, yt_title=?, yt_desc=?, platform_name='YouTube', stream_url=?, stream_key=?, scheduled_time=?, end_time=?, is_daily=?, status='pending' WHERE id=?`,
                        [videoId, accountId, title, description, rtmpUrl, streamKey, scheduledTime, endTime, isDaily ? 1 : 0, editId], () => res.json({ message: 'Jadwal diperbarui!' }));
                } else {
                    db.run(`INSERT INTO streams (video_id, account_id, yt_title, yt_desc, platform_name, stream_url, stream_key, scheduled_time, end_time, is_daily, status) VALUES (?, ?, ?, ?, 'YouTube', ?, ?, ?, ?, ?, 'pending')`,
                        [videoId, accountId, title, description, rtmpUrl, streamKey, scheduledTime, endTime, isDaily ? 1 : 0], () => res.json({ message: 'Live dibuat!' }));
                }
            } catch (error) { res.status(500).json({ message: 'Error API YouTube: ' + error.message }); }
        });
    } catch (error) { res.status(500).json({ message: 'Internal Server Error' }); }
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
app.post('/api/videos/delete/:id', (req, res) => {
    db.get('SELECT filepath FROM videos WHERE id = ?', [req.params.id], (err, row) => {
        if (row) {
            fs.unlink(path.resolve(__dirname, row.filepath), (err) => { if (err) console.error("Gagal menghapus file fisik:", err); });
            db.run('DELETE FROM videos WHERE id = ?', [req.params.id], () => res.json({ message: 'Video terhapus' }));
        } else { res.status(404).json({ message: 'Video tidak ditemukan' }); }
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

// --- API RESET TOTAL ---
app.post('/api/reset', (req, res) => {
    db.serialize(() => {
        db.run('DELETE FROM streams'); db.run('DELETE FROM videos'); db.run('DELETE FROM accounts'); db.run('DELETE FROM categories');
        db.run('DELETE FROM sqlite_sequence');
        const uploadDir = path.join(__dirname, 'uploads');
        fs.readdir(uploadDir, (err, files) => { if (!err) files.forEach(file => fs.unlink(path.join(uploadDir, file), () => { })); });
        const defaults = [''];
        defaults.forEach(cat => db.run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [cat]));
        res.json({ message: 'Pembersihan Total Selesai!' });
    });
});

// --- CRON FFMPEG MESIN STREAMING ---
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
            console.error('🔍 [ALASAN ASLI FFMPEG]:\n', stderr);
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
    const waktuSekarang = new Date();
    console.log(`\n⏳ [CRON DETAK] Waktu Server: ${waktuSekarang.toLocaleString('id-ID')}`);

    db.all(`SELECT streams.*, videos.filepath, videos.title FROM streams JOIN videos ON streams.video_id = videos.id WHERE streams.status = 'pending'`, [], (err, rows) => {
        if (err) return console.error('❌ Error DB Cron:', err.message);

        rows.forEach(stream => {
            const waktuJadwal = new Date(stream.scheduled_time);
            console.log(`   👉 Cek [${stream.title}]: Jadwal= ${waktuJadwal.toLocaleString('id-ID')} | Status= ${waktuSekarang >= waktuJadwal ? 'SIAP LIVE!' : 'Menunggu...'}`);

            if (waktuSekarang >= waktuJadwal) {
                console.log(`🎯 [DITEMUKAN] Waktunya tiba untuk: ${stream.title}! Menyiapkan mesin...`);
                db.run(`UPDATE streams SET status = 'live' WHERE id = ?`, [stream.id]);
                jalankanStreaming(path.resolve(__dirname, stream.filepath), `${stream.stream_url}/${stream.stream_key}`, stream.title, stream.video_id, stream.id);
            }
        });
    });

    db.all(`SELECT * FROM streams WHERE status = 'live'`, [], (err, rows) => {
        rows.forEach(stream => {
            const waktuSelesai = new Date(stream.end_time);
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
