const express = require('express');
const axios = require('axios');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'wf9b-secret-key';

// Google Drive auth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Auth middleware
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FFmpeg Assembly Service WF9b' });
});

// Download file helper
async function downloadFile(url, dest) {
  const response = await axios({ url, responseType: 'stream', timeout: 30000 });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Upload to Google Drive
async function uploadToDrive(filePath, fileName) {
  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  // Upload file
  const response = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [GOOGLE_DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(filePath)
    }
  });

  const fileId = response.data.id;

  // Make public
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });

  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Main assembly endpoint
app.post('/assemble', async (req, res) => {
  const jobId = Date.now().toString();
  const tmpDir = `/tmp/wf9b_${jobId}`;
  
  try {
    const {
      image_1_url, image_2_url, image_3_url,
      image_4_url, image_5_url, image_6_url,
      audio_url,
      titre, verset, reference, declaration,
      duration_per_image = 10
    } = req.body;

    // Validate
    const images = [image_1_url, image_2_url, image_3_url, image_4_url, image_5_url, image_6_url];
    if (images.some(u => !u)) return res.status(400).json({ error: 'Missing image URLs' });
    if (!audio_url) return res.status(400).json({ error: 'Missing audio_url' });

    // Create temp directory
    fs.mkdirSync(tmpDir, { recursive: true });

    console.log(`[${jobId}] Downloading files...`);

    // Download all images
    for (let i = 0; i < images.length; i++) {
      await downloadFile(images[i], `${tmpDir}/image_${i + 1}.jpg`);
      console.log(`[${jobId}] Image ${i + 1} downloaded`);
    }

    // Download audio
    await downloadFile(audio_url, `${tmpDir}/audio.mp3`);
    console.log(`[${jobId}] Audio downloaded`);

    // Create image list for FFmpeg concat
    let concatContent = '';
    for (let i = 1; i <= 6; i++) {
      concatContent += `file '${tmpDir}/image_${i}.jpg'\nduration ${duration_per_image}\n`;
    }
    // Add last image again (FFmpeg concat requirement)
    concatContent += `file '${tmpDir}/image_6.jpg'\n`;
    fs.writeFileSync(`${tmpDir}/images.txt`, concatContent);

    const outputPath = `${tmpDir}/output.mp4`;

    // FFmpeg command — slideshow + audio + text overlays
    const totalDuration = duration_per_image * 6; // 60s

    // Build drawtext filters
    const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
    
    // Verset text (0s to 8s) — bottom of screen
    const versetText = (verset || '').replace(/'/g, "\\'").replace(/:/g, "\\:").substring(0, 80);
    const referenceText = (reference || '').replace(/'/g, "\\'");
    
    // Declaration text (52s to 60s) — bottom of screen  
    const declarationText = (declaration || '').replace(/'/g, "\\'").substring(0, 100);
    
    // CTA text (50s to 60s)
    const ctaText = "Like   Abonne-toi   Partage   Nouvel episode demain";

    const drawtextVerset = versetText ? 
      `drawtext=fontfile=${fontFile}:text='${referenceText} - ${versetText}':fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h-150:enable='between(t,0,8)'` : '';

    const drawtextDeclaration = declarationText ?
      `drawtext=fontfile=${fontFile}:text='${declarationText}':fontcolor=gold:fontsize=32:box=1:boxcolor=black@0.6:boxborderw=8:x=(w-text_w)/2:y=h-180:enable='between(t,52,60)'` : '';

    const drawtextCTA = 
      `drawtext=fontfile=${fontFile}:text='${ctaText}':fontcolor=white:fontsize=30:box=1:boxcolor=black@0.7:boxborderw=10:x=(w-text_w)/2:y=h-80:enable='between(t,50,${totalDuration})'`;

    // Combine filters
    const filters = [drawtextVerset, drawtextDeclaration, drawtextCTA]
      .filter(f => f !== '')
      .join(',');

    const ffmpegCmd = `ffmpeg -y \
      -f concat -safe 0 -i "${tmpDir}/images.txt" \
      -i "${tmpDir}/audio.mp3" \
      -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,${filters}" \
      -c:v libx264 -preset fast -crf 23 \
      -c:a aac -b:a 192k \
      -t ${totalDuration} \
      -movflags +faststart \
      -pix_fmt yuv420p \
      "${outputPath}"`;

    console.log(`[${jobId}] Running FFmpeg...`);
    execSync(ffmpegCmd, { timeout: 300000, stdio: 'pipe' });
    console.log(`[${jobId}] FFmpeg done`);

    // Upload to Google Drive
    console.log(`[${jobId}] Uploading to Drive...`);
    const fileName = `heros_foi_${jobId}.mp4`;
    const videoUrl = await uploadToDrive(outputPath, fileName);
    console.log(`[${jobId}] Upload done: ${videoUrl}`);

    // Cleanup
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
  
  // Check FFmpeg
  try {
    const version = execSync('ffmpeg -version').toString().split('\n')[0];
    console.log(`FFmpeg: ${version}`);
  } catch(e) {
    console.error('FFmpeg not found!');
  }
});
