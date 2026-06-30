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
  res.json({ status: 'ok', service: 'FFmpeg Assembly Service WF9b/WF10 v8 — Fixed ENOBUFS' });
});

async function downloadFile(url, dest) {
  let downloadUrl = url;
  if (url.includes('drive.google.com')) {
    const idMatch = url.match(/id=([^&]+)/);
    if (idMatch) downloadUrl = `https://drive.google.com/uc?export=download&confirm=t&id=${idMatch[1]}`;
  }
  const response = await axios({ url: downloadUrl, responseType: 'stream', timeout: 60000 });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

function getAudioDuration(filePath) {
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const dur = parseFloat(output);
    return isNaN(dur) || dur <= 0 ? 90 : Math.ceil(dur);
  } catch(e) {
    return 90;
  }
}

async function uploadToDrive(filePath, fileName) {
  const stat = fs.statSync(filePath);
  if (stat.size < 10000) throw new Error(`Output file too small (${stat.size} bytes)`);

  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  const response = await drive.files.create({
    requestBody: { name: fileName, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) },
    fields: 'id,name,size'
  });

  const fileId = response.data.id;
  await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } }).catch(() => {});

  return `https://drive.google.com/file/d/${fileId}/view`;
}

function cleanText(text, maxLength = 200) {
  if (!text) return '';
  return text.substring(0, maxLength)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[''`]/g, ' ')
    .replace(/[""]/g, ' ')
    .replace(/\\/g, ' ')
    .replace(/[<>|&;${}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function buildDocumentaryVideo({
  jobId, tmpDir, imageUrls, audioUrl,
  titleLine, verseLine, declarationLine, secondaryLines = [],
  secondsPerImage = 5
}) {
  fs.mkdirSync(tmpDir, { recursive: true });

  await downloadFile(audioUrl, `${tmpDir}/audio.mp3`);
  const audioDuration = getAudioDuration(`${tmpDir}/audio.mp3`);
  const totalDuration = audioDuration || 90;

  let nImages = Math.round(totalDuration / secondsPerImage);
  nImages = Math.max(12, Math.min(nImages, imageUrls.length));
  const selectedUrls = imageUrls.slice(0, nImages);
  const imgDuration = totalDuration / nImages;

  // Download images
  for (let i = 0; i < selectedUrls.length; i++) {
    try {
      await downloadFile(selectedUrls[i], `${tmpDir}/image_${i+1}.jpg`);
    } catch(e) {
      execSync(`ffmpeg -y -f lavfi -i color=black:size=1080x1920:duration=1 -vframes 1 "${tmpDir}/image_${i+1}.jpg"`);
    }
  }

  // Pass 1: Normalise each image
  for (let i = 1; i <= nImages; i++) {
    const cmd = `ffmpeg -y -loop 1 -t ${imgDuration.toFixed(2)} -i "${tmpDir}/image_${i}.jpg" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p,setsar=1" -r 25 -c:v libx264 -preset ultrafast -crf 28 -an "${tmpDir}/clip_${i}.mp4"`;
    execSync(cmd, { timeout: 60000 });
  }

  // Pass 2: Use concat list (FIX ENOBUFS)
  const concatListPath = `${tmpDir}/concat_list.txt`;
  let concatContent = '';
  for (let i = 1; i <= nImages; i++) {
    concatContent += `file '${tmpDir}/clip_${i}.mp4'\n`;
  }
  fs.writeFileSync(concatListPath, concatContent);

  const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  fs.writeFileSync(`${tmpDir}/title.txt`, cleanText(titleLine, 70));
  fs.writeFileSync(`${tmpDir}/verse.txt`, cleanText(verseLine, 90));
  fs.writeFileSync(`${tmpDir}/declaration.txt`, cleanText(declarationLine, 100));

  const ctaStart = Math.floor(Math.max(totalDuration - 12, totalDuration * 0.85));
  const declStart = Math.floor(Math.max(totalDuration - 22, totalDuration * 0.70));

  const textChain = [
    `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/verse.txt':fontcolor=white:fontsize=32:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-220:enable='between(t,0,9)'`,
    `drawtext=fontfile=${fontFile}:textfile='${tmpDir}/declaration.txt':fontcolor=gold:fontsize=30:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-280:enable='between(t,${declStart},${totalDuration})'`,
    `drawtext=fontfile=${fontFile}:text='Like • Abonne-toi • Partage':fontcolor=white:fontsize=42:box=1:boxcolor=black@0.8:boxborderw=14:x=(w-text_w)/2:y=h-130:enable='between(t,${ctaStart},${totalDuration})'`
  ].join(',');

  const outputPath = `${tmpDir}/output.mp4`;

  const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -i "${tmpDir}/audio.mp3" -filter_complex "${textChain}" -map "[outv]" -map ${nImages}:a -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 192k -t ${totalDuration} -movflags +faststart -pix_fmt yuv420p "${outputPath}"`;

  execSync(ffmpegCmd, { timeout: 900000, maxBuffer: 1024 * 1024 * 100 });

  return { outputPath, totalDuration, nImages };
}

// Routes (identiques)
app.post('/assemble', async (req, res) => { /* ... identique ... */ });
app.post('/assemble-actu', async (req, res) => { /* ... identique ... */ });

app.listen(PORT, () => {
  console.log(`FFmpeg Assembly Service v8 (ENOBUFS fixed) on port ${PORT}`);
});
