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
  res.json({ status: 'ok', service: 'FFmpeg Assembly Service WF9b v3' });
});

async function downloadFile(url, dest) {
  // Handle Google Drive URLs specially
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
    timeout: 120000,
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
      { timeout: 10000 }
    ).toString().trim();
    const dur = parseFloat(output);
    if (isNaN(dur) || dur <= 0) {
      console.log('ffprobe returned invalid duration, using 90s fallback');
      return 90;
    }
    return Math.ceil(dur);
  } catch(e) {
    console.log('ffprobe failed, using 90s fallback:', e.message);
    return 90;
  }
}

async function uploadToDrive(filePath, fileName) {
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) }
  });

  const fileId = response.data.id;
  await drive.permissions.create({
    fileId, requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}

function cleanText(text, maxLength = 60) {
  if (!text) return '';
  return text.substring(0, maxLength).replace(/[\r\n]+/g, ' ').trim();
}

app.post('/assemble', async (req, res) => {
  const jobId = Date.now().toString();
  const tmpDir = `/tmp/wf9b_${jobId}`;

  try {
    const {
      image_1_url, image_2_url, image_3_url,
      image_4_url, image_5_url, image_6_url,
      audio_url, verset, reference, declaration,
      duration_per_image = 10
    } = req.body;

    const images = [image_1_url, image_2_url, image_3_url,
                    image_4_url, image_5_url, image_6_url];
    if (images.some(u => !u)) return res.status(400).json({ error: 'Missing image URLs' });
    if (!audio_url) return res.status(400).json({ error: 'Missing audio_url' });

    fs.mkdirSync(tmpDir, { recursive: true });

    // Download images
    console.log(`[${jobId}] Downloading images...`);
    for (let i = 0; i < images.length; i++) {
      try {
        await downloadFile(images[i], `${tmpDir}/image_${i + 1}.jpg`);
        console.log(`[${jobId}] Image ${i + 1} OK`);
      } catch(e) {
        console.log(`[${jobId}] Image ${i + 1} failed, using fallback`);
        if (i > 0 && fs.existsSync(`${tmpDir}/image_${i}.jpg`)) {
          fs.copyFileSync(`${tmpDir}/image_${i}.jpg`, `${tmpDir}/image_${i + 1}.jpg`);
        } else {
          // Create a black placeholder image
          execSync(`ffmpeg -y -f lavfi -i color=black:size=1080x1920:duration=1 -vframes 1 "${tmpDir}/image_${i + 1}.jpg"`);
        }
      }
    }

    // Download audio
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(audio_url, `${tmpDir}/audio.mp3`);

    // Get real audio duration with safe fallback
    const audioDuration = getAudioDuration(`${tmpDir}/audio.mp3`);
    const totalDuration = (!audioDuration || isNaN(audioDuration) || audioDuration <= 0) ? 90 : audioDuration;
    const imgDuration = Math.max(1, Math.ceil(totalDuration / 6));
    console.log(`[${jobId}] Audio: ${audioDuration}s → total: ${totalDuration}s, img: ${imgDuration}s each`);

    // Write concat file
    let concatContent = '';
    for (let i = 1; i <= 6; i++) {
      concatContent += `file '${tmpDir}/image_${i}.jpg'\nduration ${imgDuration}\n`;
    }
    concatContent += `file '${tmpDir}/image_6.jpg'\n`;
    fs.writeFileSync(`${tmpDir}/images.txt`, concatContent);

    // Write text files
    const versetLine = cleanText(`${reference || ''} - ${verset || ''}`, 65);
    const declarationLine = cleanText(declaration || '', 75);
    const ctaLine = 'Like  Abonne-toi  Partage  Nouvel episode demain';

    fs.writeFileSync(`${tmpDir}/verset.txt`, versetLine);
    fs.writeFileSync(`${tmpDir}/declaration.txt`, declarationLine);
    fs.writeFileSync(`${tmpDir}/cta.txt`, ctaLine);

    const outputPath = `${tmpDir}/output.mp4`;
    const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

    // Safe time calculations
    const ctaStart = Math.floor(Math.max(totalDuration - 15, totalDuration * 0.75));
    const declarationStart = Math.floor(Math.max(totalDuration - 20, totalDuration * 0.65));

    const filters = [
      // Verset (0-10s)
      versetLine ? `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/verset.txt':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-160:enable='between(t,0,10)'` : '',
      // Declaration
      declarationLine ? `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/declaration.txt':fontcolor=gold:fontsize=32:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-200:enable='between(t,${declarationStart},${totalDuration})'` : '',
      // CTA grand et visible
      `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/cta.txt':fontcolor=white:fontsize=46:box=1:boxcolor=black@0.8:boxborderw=14:x=(w-text_w)/2:y=h-110:enable='between(t,${ctaStart},${totalDuration})'`
    ].filter(f => f !== '').join(',');

    const ffmpegCmd = `ffmpeg -y \
      -f concat -safe 0 -i "${tmpDir}/images.txt" \
      -i "${tmpDir}/audio.mp3" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=25,${filters}" \
      -c:v libx264 -preset fast -crf 22 \
      -c:a aac -b:a 192k \
      -t ${totalDuration} \
      -movflags +faststart \
      -pix_fmt yuv420p \
      "${outputPath}"`;

    console.log(`[${jobId}] Running FFmpeg (${totalDuration}s)...`);
    execSync(ffmpegCmd, { timeout: 600000 });
    console.log(`[${jobId}] FFmpeg done`);

    // Upload to Drive
    console.log(`[${jobId}] Uploading to Drive...`);
    const fileName = `heros_foi_${jobId}.mp4`;
    const videoUrl = await uploadToDrive(outputPath, fileName);
    console.log(`[${jobId}] Done: ${videoUrl}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({
      success: true,
      video_url: videoUrl,
      job_id: jobId,
      duration: totalDuration
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg Service running on port ${PORT}`);
  try {
    const v = execSync('ffmpeg -version').toString().split('\n')[0];
    console.log(`FFmpeg: ${v}`);
  } catch(e) { console.error('FFmpeg not found!'); }
});
