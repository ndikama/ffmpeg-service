const express = require('express');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'wf9b-secret-key';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FFmpeg Assembly Service WF9b/WF10 v7 — Documentary style dynamic images' });
});

async function downloadFile(url, dest) {
  let downloadUrl = url;
  if (url.includes('drive.google.com')) {
    const idMatch = url.match(/id=([^&]+)/);
    if (idMatch) {
      downloadUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${idMatch[1]}`;
    }
  }
  const response = await axios({
    url: downloadUrl,
    responseType: 'stream',
    timeout: 60000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*'
    },
    maxRedirects: 15
  });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function getAudioDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString().trim();
    const dur = parseFloat(output);
    if (isNaN(dur) || dur <= 0) {
      console.log('ffprobe invalid duration, fallback 90s');
      return 90;
    }
    return Math.ceil(dur);
  } catch(e) {
    console.log('ffprobe failed, fallback 90s:', e.message);
    return 90;
  }
}

async function uploadToDrive(filePath, fileName) {
  const stat = fs.statSync(filePath);
  console.log(`[Drive] File to upload: ${filePath} — size: ${stat.size} bytes`);
  if (stat.size < 10000) throw new Error(`Output file too small (${stat.size} bytes) — render likely failed`);

  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
    fields: 'id,name,size'
  });

  const fileId = response.data.id;
  console.log(`[Drive] Upload OK — id: "${fileId}" (len:${fileId ? fileId.length : 'null'}) size: ${response.data.size}`);
  if (!fileId) throw new Error('Google Drive returned no fileId');

  try {
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    console.log(`[Drive] Permissions OK — public`);
  } catch(permErr) {
    console.error(`[Drive] Permission error (non-fatal): ${permErr.message}`);
  }

  const url = `https://drive.google.com/file/d/${fileId}/view`;
  console.log(`[Drive] URL: ${url}`);
  return url;
}

function cleanText(text, maxLength = 200) {
  if (!text) return '';
  return text
    .substring(0, maxLength)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[''`]/g, ' ')
    .replace(/[""]/g, ' ')
    .replace(/\\/g, ' ')
    .replace(/[<>|&;${}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── CORE BUILDER: documentary-style N-image video ──────────────────────────
// Shared by /assemble (WF9b) and /assemble-actu (WF10).
// Downloads audio first, measures real duration, picks N images from the
// provided pool (~1 image per 5s, min 12, max pool size), normalises each to
// a clip (fixes mixed colorspace/SAR), concatenates, overlays drawtext.
async function buildDocumentaryVideo({
  jobId, tmpDir, imageUrls, audioUrl,
  titleLine, verseLine, declarationLine, secondaryLines = [],
  secondsPerImage = 5
}) {
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. Download audio first — its real duration drives everything else
  console.log(`[${jobId}] Downloading audio...`);
  await downloadFile(audioUrl, `${tmpDir}/audio.mp3`);
  const audioDuration = getAudioDuration(`${tmpDir}/audio.mp3`);
  const totalDuration = (!audioDuration || isNaN(audioDuration) || audioDuration <= 0) ? 90 : audioDuration;

  // 2. Determine how many images to actually use
  let nImages = Math.round(totalDuration / secondsPerImage);
  nImages = Math.max(12, Math.min(nImages, imageUrls.length));
  const selectedUrls = imageUrls.slice(0, nImages);
  const imgDuration = totalDuration / nImages;
  console.log(`[${jobId}] Audio: ${totalDuration}s | Using ${nImages}/${imageUrls.length} images | ${imgDuration.toFixed(2)}s each`);

  // 3. Download selected images with fallback chain
  console.log(`[${jobId}] Downloading ${nImages} images (sequential, with delay)...`);
  for (let i = 0; i < selectedUrls.length; i++) {
    try {
      console.log(`[${jobId}] → downloading image ${i + 1}/${nImages}: ${selectedUrls[i].substring(0, 80)}`);
      await downloadFile(selectedUrls[i], `${tmpDir}/image_${i + 1}.jpg`);
      console.log(`[${jobId}] ✓ image ${i + 1} OK`);
    } catch(e) {
      console.log(`[${jobId}] ✗ image ${i + 1} failed: ${e.message}`);
      if (i > 0 && fs.existsSync(`${tmpDir}/image_${i}.jpg`)) {
        fs.copyFileSync(`${tmpDir}/image_${i}.jpg`, `${tmpDir}/image_${i + 1}.jpg`);
      } else {
        execSync(`ffmpeg -y -f lavfi -i color=black:size=1080x1920:duration=1 -vframes 1 "${tmpDir}/image_${i + 1}.jpg"`, { maxBuffer: 1024 * 1024 * 10, stdio: ['ignore', 'ignore', 'pipe'] });
      }
    }
  }
  console.log(`[${jobId}] All ${nImages} images downloaded/fallback complete`);

  // 4. PASS 1 — normalise each image to a uniform MP4 clip
  // (fixes mixed colorspace gray/yuvj420p/yuvj444p and mixed SAR that break
  // concat/xfade with heterogeneous web image sources)
  console.log(`[${jobId}] Pass 1: normalising ${nImages} clips...`);
  for (let i = 1; i <= nImages; i++) {
    console.log(`[${jobId}] → normalising clip ${i}/${nImages}`);
    const cmd1 = `ffmpeg -y \
      -loop 1 -t ${imgDuration.toFixed(2)} -i "${tmpDir}/image_${i}.jpg" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,setsar=1" \
      -r 25 -c:v libx264 -preset ultrafast -crf 28 -an \
      "${tmpDir}/clip_${i}.mp4"`;
    const scriptPath1 = `${tmpDir}/run_pass1_${i}.sh`;
    fs.writeFileSync(scriptPath1, `#!/bin/sh\nset -e\n${cmd1}\n`);
    execSync(`sh "${scriptPath1}"`, { timeout: 60000, maxBuffer: 1024 * 1024 * 50, stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`[${jobId}] ✓ clip ${i} done`);
  }
  console.log(`[${jobId}] Pass 1 complete — ${nImages} clips ready`);
  console.log(`[${jobId}] Pass 1 complete`);

  // 5. Build text overlay filters
  const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  fs.writeFileSync(`${tmpDir}/title.txt`, cleanText(titleLine, 70));
  fs.writeFileSync(`${tmpDir}/verse.txt`, cleanText(verseLine, 90));
  fs.writeFileSync(`${tmpDir}/declaration.txt`, cleanText(declarationLine, 100));
  fs.writeFileSync(`${tmpDir}/cta.txt`, 'Like  Abonne-toi  Partage  Nouvel episode demain');

  const ctaStart = Math.floor(Math.max(totalDuration - 12, totalDuration * 0.85));
  const declStart = Math.floor(Math.max(totalDuration - 22, totalDuration * 0.70));

  const drawtextFilters = [
    verseLine ? `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/verse.txt':fontcolor=white:fontsize=32:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-220:enable='between(t,0,9)'` : '',
    declarationLine ? `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/declaration.txt':fontcolor=gold:fontsize=30:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-280:enable='between(t,${declStart},${totalDuration})'` : '',
    `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/cta.txt':fontcolor=white:fontsize=42:box=1:boxcolor=black@0.8:boxborderw=14:x=(w-text_w)/2:y=h-130:enable='between(t,${ctaStart},${totalDuration})'`
  ].filter(f => f !== '');

  // optional bilingual secondary lines (WF10): array of {text, startSec, endSec}
  secondaryLines.forEach((line, idx) => {
    if (!line.text) return;
    const fname = `secondary_${idx}.txt`;
    fs.writeFileSync(`${tmpDir}/${fname}`, cleanText(line.text, 90));
    drawtextFilters.push(
      `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/${fname}':fontcolor=yellow:fontsize=24:box=1:boxcolor=black@0.55:boxborderw=8:x=(w-text_w)/2:y=h-180:enable='between(t,${line.startSec},${line.endSec})'`
    );
  });

  const textChain = drawtextFilters.join(',');

  // 6. PASS 2 — concat normalised clips + audio + drawtext
  const clipInputs = Array.from({length: nImages}, (_, i) => `-i "${tmpDir}/clip_${i+1}.mp4"`).join(' ');
  const concatFilter = Array.from({length: nImages}, (_, i) => `[${i}:v]`).join('') +
    `concat=n=${nImages}:v=1:a=0[vconcat];[vconcat]${textChain}[outv]`;
  const outputPath = `${tmpDir}/output.mp4`;

  console.log(`[${jobId}] Pass 2: assembling final video (${nImages} clips, ${totalDuration}s)...`);
  // Write filter_complex to its own file too — with 25 images the filter string
  // itself can be several KB, which some shells/Docker images choke on even
  // inside a script. -filter_complex_script reads it directly from disk.
  const filterScriptPath = `${tmpDir}/filter_complex.txt`;
  fs.writeFileSync(filterScriptPath, concatFilter);

  const ffmpegCmd2 = `ffmpeg -y \
    ${clipInputs} \
    -i "${tmpDir}/audio.mp3" \
    -filter_complex_script "${filterScriptPath}" \
    -map "[outv]" \
    -map ${nImages}:a \
    -c:v libx264 -preset fast -crf 22 \
    -c:a aac -b:a 192k \
    -t ${totalDuration} \
    -movflags +faststart \
    -pix_fmt yuv420p \
    "${outputPath}"`;
  const scriptPath2 = `${tmpDir}/run_pass2.sh`;
  fs.writeFileSync(scriptPath2, `#!/bin/sh\nset -e\n${ffmpegCmd2}\n`);
  execSync(`sh "${scriptPath2}"`, { timeout: 900000, maxBuffer: 1024 * 1024 * 100, stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`[${jobId}] Pass 2 ffmpeg command finished`);
  console.log(`[${jobId}] Render complete`);

  return { outputPath, totalDuration, nImages };
}

// ─── ROUTE: WF9b — Héros de la Foi ───────────────────────────────────────────
app.post('/assemble', async (req, res) => {
  const jobId = Date.now().toString();
  const tmpDir = `/tmp/wf9b_${jobId}`;

  try {
    const { images_urls, audio_url, titre, verset, reference, declaration } = req.body;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length < 12) {
      return res.status(400).json({ error: 'images_urls must be an array of at least 12 URLs' });
    }
    if (!audio_url) return res.status(400).json({ error: 'Missing audio_url' });

    const { outputPath, totalDuration, nImages } = await buildDocumentaryVideo({
      jobId, tmpDir,
      imageUrls: images_urls,
      audioUrl: audio_url,
      titleLine: titre,
      verseLine: `${reference || ''} - ${verset || ''}`,
      declarationLine: declaration,
      secondsPerImage: 5
    });

    console.log(`[${jobId}] Uploading to Drive...`);
    const fileName = `heros_foi_${jobId}.mp4`;
    const videoUrl = await uploadToDrive(outputPath, fileName);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({ success: true, video_url: videoUrl, job_id: jobId, duration: totalDuration, images_used: nImages });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

// ─── ROUTE: WF10 — Actu & Prière (bilingue FR+EN) ────────────────────────────
app.post('/assemble-actu', async (req, res) => {
  const jobId = Date.now().toString();
  const tmpDir = `/tmp/wf10_${jobId}`;

  try {
    const {
      images_urls, audio_url,
      titre_fr, verset_fr, reference, declaration_fr,
      segments // optional: [{texte_fr, texte_en}] aligned with images for EN subtitles
    } = req.body;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length < 12) {
      return res.status(400).json({ error: 'images_urls must be an array of at least 12 URLs' });
    }
    if (!audio_url) return res.status(400).json({ error: 'Missing audio_url' });

    // Build secondary (English) lines spread across the timeline if segments provided
    let secondaryLines = [];
    if (segments && Array.isArray(segments) && segments.length > 0) {
      const segDuration = 90 / segments.length; // rough estimate, refined after duration known — kept simple here
      secondaryLines = segments.map((seg, i) => ({
        text: seg.texte_en || '',
        startSec: Math.floor(i * segDuration),
        endSec: Math.floor((i + 1) * segDuration)
      })).filter(l => l.text);
    }

    const { outputPath, totalDuration, nImages } = await buildDocumentaryVideo({
      jobId, tmpDir,
      imageUrls: images_urls,
      audioUrl: audio_url,
      titleLine: titre_fr,
      verseLine: `${reference || ''} - ${verset_fr || ''}`,
      declarationLine: declaration_fr,
      secondaryLines,
      secondsPerImage: 5
    });

    console.log(`[${jobId}] Uploading to Drive...`);
    const fileName = `actu_priere_${jobId}.mp4`;
    const videoUrl = await uploadToDrive(outputPath, fileName);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({ success: true, video_url: videoUrl, job_id: jobId, duration: totalDuration, images_used: nImages });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg Assembly Service WF9b/WF10 v7 on port ${PORT}`);
  try {
    const v = execSync('ffmpeg -version').toString().split('\n')[0];
    console.log(`FFmpeg: ${v}`);
  } catch(e) { console.error('FFmpeg not found!'); }
});
