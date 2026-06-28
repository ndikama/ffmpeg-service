const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.API_KEY || 'wf9b-secret-key-change-this';
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const TMP = '/tmp/wf10';

// ─────────────────────────────────────────────
// Auth Google Drive
// ─────────────────────────────────────────────
function getDriveClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

async function uploadToDrive(filePath, fileName) {
  const drive = getDriveClient();
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
    fields: 'id'
  });
  await drive.permissions.create({
    fileId: res.data.id,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  return `https://drive.google.com/uc?export=download&id=${res.data.id}`;
}

// ─────────────────────────────────────────────
// Authentification API
// ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─────────────────────────────────────────────
// Healthcheck
// ─────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0' }));

// ─────────────────────────────────────────────
// GET Audio Duration
// ─────────────────────────────────────────────
app.post('/get-duration', async (req, res) => {
  const { audio_url } = req.body;
  const jobId = Date.now().toString();
  const dir = path.join(TMP, jobId);
  ensureDir(dir);
  const audioFile = path.join(dir, 'audio.mp3');

  try {
    await downloadFile(audio_url, audioFile);
    const duration = await new Promise((resolve, reject) => {
      exec(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`,
        (err, stdout) => {
          if (err) return reject(err);
          resolve(parseFloat(stdout.trim()));
        }
      );
    });
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ success: true, duration_seconds: Math.round(duration) });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE PRINCIPALE — Assemble Documentary
// ─────────────────────────────────────────────
// Reçoit :
// {
//   personnage, audio_url, duree_totale,
//   watermark_text, cta_texte, cta_debut,
//   scenes: [{ scene, duree, image_url, texte_affiche, effet, transition }]
// }
// ─────────────────────────────────────────────
app.post('/assemble-documentary', async (req, res) => {
  const {
    personnage,
    audio_url,
    duree_totale,
    watermark_text = 'Kingdom Fire',
    cta_texte = '👍 Like  🔔 Abonne-toi  📖 Partage',
    cta_debut,
    scenes
  } = req.body;

  if (!audio_url || !scenes || scenes.length === 0) {
    return res.status(400).json({ error: 'audio_url et scenes sont requis' });
  }

  const jobId = Date.now().toString();
  const dir = path.join(TMP, jobId);
  ensureDir(dir);

  console.log(`[${jobId}] Démarrage — ${personnage} — ${scenes.length} scènes`);

  try {
    // ── 1. Télécharger audio ──────────────────
    const audioFile = path.join(dir, 'audio.mp3');
    console.log(`[${jobId}] Téléchargement audio...`);
    await downloadFile(audio_url, audioFile);

    // ── 2. Télécharger toutes les images ──────
    console.log(`[${jobId}] Téléchargement ${scenes.length} images...`);
    const imageFiles = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const imgPath = path.join(dir, `img_${String(i).padStart(3, '0')}.jpg`);

      if (scene.image_url) {
        try {
          await downloadFile(scene.image_url, imgPath);
          // Vérifier que le fichier est valide
          const stats = fs.statSync(imgPath);
          if (stats.size < 1000) throw new Error('Image trop petite');
          imageFiles.push({ path: imgPath, scene });
        } catch (e) {
          console.warn(`[${jobId}] Image ${i} échouée — utilisation placeholder`);
          // Créer un placeholder coloré avec FFmpeg
          const color = getEmotionColor(scene.emotion || 'neutral');
          await runFFmpeg(
            `ffmpeg -f lavfi -i color=${color}:size=1080x1920:duration=1 -vframes 1 "${imgPath}" -y`
          );
          imageFiles.push({ path: imgPath, scene });
        }
      } else {
        const color = getEmotionColor(scene.emotion || 'neutral');
        await runFFmpeg(
          `ffmpeg -f lavfi -i color=${color}:size=1080x1920:duration=1 -vframes 1 "${imgPath}" -y`
        );
        imageFiles.push({ path: imgPath, scene });
      }
    }

    // ── 3. Générer un clip vidéo par scène ────
    console.log(`[${jobId}] Génération des clips...`);
    const clipFiles = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const { path: imgPath, scene } = imageFiles[i];
      const clipPath = path.join(dir, `clip_${String(i).padStart(3, '0')}.mp4`);
      const duree = scene.duree || 5;
      const effet = scene.effet || 'zoom_in';

      // Texte sous-titre pour cette scène
      const texte = (scene.texte_affiche || '').replace(/'/g, "\\'").replace(/:/g, '\\:');

      // Filtre Ken Burns selon l'effet
      const kenBurns = getKenBurnsFilter(effet, duree);

      // Filtre sous-titre
      const subtitleFilter = texte
        ? `,drawtext=text='${texte}':fontsize=42:fontcolor=white:` +
          `shadowcolor=black:shadowx=2:shadowy=2:` +
          `x=(w-text_w)/2:y=h-200:` +
          `font='DejaVu-Sans-Bold':` +
          `box=1:boxcolor=black@0.5:boxborderw=12`
        : '';

      const cmd =
        `ffmpeg -loop 1 -i "${imgPath}" ` +
        `-t ${duree} ` +
        `-vf "scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,${kenBurns}${subtitleFilter},format=yuv420p" ` +
        `-r 30 -c:v libx264 -preset fast -crf 23 ` +
        `"${clipPath}" -y`;

      await runFFmpeg(cmd);
      clipFiles.push(clipPath);
    }

    // ── 4. Ajouter clip CTA final ─────────────
    const ctaPath = path.join(dir, 'clip_cta.mp4');
    const ctaTexte = cta_texte.replace(/'/g, "\\'").replace(/:/g, '\\:');
    await runFFmpeg(
      `ffmpeg -f lavfi -i color=0x1a1a2e:size=1080x1920:duration=8 ` +
      `-vf "drawtext=text='${ctaTexte}':fontsize=52:fontcolor=white:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:font='DejaVu-Sans-Bold':` +
      `shadowcolor=black:shadowx=3:shadowy=3,` +
      `drawtext=text='${watermark_text}':fontsize=36:fontcolor=gold:` +
      `x=(w-text_w)/2:y=h-120:font='DejaVu-Sans-Bold',` +
      `format=yuv420p" ` +
      `-r 30 -c:v libx264 -preset fast -crf 23 "${ctaPath}" -y`
    );
    clipFiles.push(ctaPath);

    // ── 5. Concaténer tous les clips ──────────
    console.log(`[${jobId}] Concaténation ${clipFiles.length} clips...`);
    const listFile = path.join(dir, 'clips.txt');
    fs.writeFileSync(
      listFile,
      clipFiles.map(f => `file '${f}'`).join('\n')
    );

    const videoNoAudio = path.join(dir, 'video_no_audio.mp4');
    await runFFmpeg(
      `ffmpeg -f concat -safe 0 -i "${listFile}" ` +
      `-c:v libx264 -preset fast -crf 22 ` +
      `"${videoNoAudio}" -y`
    );

    // ── 6. Mixer avec l'audio ─────────────────
    console.log(`[${jobId}] Mixage audio...`);
    const finalVideo = path.join(dir, `${personnage.replace(/\s+/g, '_')}_${jobId}.mp4`);
    await runFFmpeg(
      `ffmpeg -i "${videoNoAudio}" -i "${audioFile}" ` +
      `-c:v copy -c:a aac -b:a 192k ` +
      `-shortest -map 0:v:0 -map 1:a:0 ` +
      `"${finalVideo}" -y`
    );

    // ── 7. Upload Google Drive ────────────────
    console.log(`[${jobId}] Upload Drive...`);
    const fileName = `${personnage}_${new Date().toISOString().split('T')[0]}.mp4`;
    const driveUrl = await uploadToDrive(finalVideo, fileName);

    // ── 8. Nettoyage ──────────────────────────
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`[${jobId}] ✅ Terminé — ${driveUrl}`);
    res.json({
      success: true,
      video_url: driveUrl,
      job_id: jobId,
      personnage,
      nombre_scenes: scenes.length,
      duree_totale
    });

  } catch (err) {
    console.error(`[${jobId}] ❌ Erreur:`, err.message);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    res.status(500).json({ error: err.message, job_id: jobId });
  }
});

// ─────────────────────────────────────────────
// Helpers effets Ken Burns
// ─────────────────────────────────────────────
function getKenBurnsFilter(effet, duree) {
  const frames = duree * 30;
  switch (effet) {
    case 'zoom_in':
      return `zoompan=z='min(zoom+0.0015,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
    case 'zoom_out':
      return `zoompan=z='if(lte(zoom,1.0),1.3,max(zoom-0.0015,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
    case 'pan_left':
      return `zoompan=z='1.2':x='iw/2-(iw/zoom/2)+t*8':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
    case 'pan_right':
      return `zoompan=z='1.2':x='max(iw/2-(iw/zoom/2)-t*8,0)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
    case 'tilt_up':
      return `zoompan=z='1.2':x='iw/2-(iw/zoom/2)':y='max(ih/2-(ih/zoom/2)-t*8,0)':d=${frames}:s=1080x1920:fps=30`;
    case 'still':
    default:
      return `zoompan=z='1.0':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1080x1920:fps=30`;
  }
}

// ─────────────────────────────────────────────
// Couleur placeholder selon émotion
// ─────────────────────────────────────────────
function getEmotionColor(emotion) {
  const colors = {
    hope: '0x1a3a5c',
    fire: '0x3d1a00',
    peace: '0x1a3d2e',
    power: '0x2d1a4a',
    discovery: '0x1a2d4a',
    neutral: '0x1a1a2e'
  };
  return colors[emotion] || colors.neutral;
}

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
ensureDir(TMP);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WF10 FFmpeg Server démarré sur port ${PORT}`));
