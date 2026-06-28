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

// Authentication guardrail
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'FFmpeg Assembly Service WF9b v4 (Premium Cinematic Slideshow)' });
});

// Robust download function handling redirects and Google Drive sources
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

// Inspects audio length to dynamically calculate slideshow durations
function getAudioDuration(filePath) {
  try {
    const output = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 10000 }
    ).toString().trim();
    const dur = parseFloat(output);
    if (isNaN(dur) || dur <= 0) {
      console.log('ffprobe returned invalid duration, using 60s fallback');
      return 60;
    }
    return Math.ceil(dur);
  } catch(e) {
    console.log('ffprobe failed, using 60s fallback:', e.message);
    return 60;
  }
}

// Upload final video file back to shared Google Drive
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

// Text formatting utility for subtitles
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

    // 1. Downloading images locally
    console.log(`[${jobId}] Downloading 6 images...`);
    for (let i = 0; i < images.length; i++) {
      try {
        await downloadFile(images[i], `${tmpDir}/image_${i + 1}.jpg`);
        console.log(`[${jobId}] Image ${i + 1} OK`);
      } catch(e) {
        console.log(`[${jobId}] Image ${i + 1} failed, creating fallback`);
        if (i > 0 && fs.existsSync(`${tmpDir}/image_${i}.jpg`)) {
          fs.copyFileSync(`${tmpDir}/image_${i}.jpg`, `${tmpDir}/image_${i + 1}.jpg`);
        } else {
          execSync(`ffmpeg -y -f lavfi -i color=black:size=1080x1920:duration=1 -vframes 1 "${tmpDir}/image_${i + 1}.jpg"`);
        }
      }
    }

    // 2. Downloading audio
    console.log(`[${jobId}] Downloading audio...`);
    await downloadFile(audio_url, `${tmpDir}/audio.mp3`);

    // Calculate real audio duration and dynamic segment timing
    const audioDuration = getAudioDuration(`${tmpDir}/audio.mp3`);
    const totalDuration = (!audioDuration || isNaN(audioDuration) || audioDuration <= 0) ? 60 : audioDuration;
    
    // Duration for each image segment (we add +1.5 seconds for clean transition overlaps)
    const stepDuration = totalDuration / 6;
    const segmentDuration = Math.ceil(stepDuration + 2); 
    console.log(`[${jobId}] Audio: ${audioDuration}s | Step: ${stepDuration}s | Loop Duration: ${segmentDuration}s`);

    // Prepare text overlays
    const versetLine = cleanText(`${reference || ''} - ${verset || ''}`, 65);
    const declarationLine = cleanText(declaration || '', 75);
    const ctaLine = 'Like  Abonne-toi  Partage  Nouvel episode demain';

    fs.writeFileSync(`${tmpDir}/verset.txt`, versetLine);
    fs.writeFileSync(`${tmpDir}/declaration.txt`, declarationLine);
    fs.writeFileSync(`${tmpDir}/cta.txt`, ctaLine);

    const outputPath = `${tmpDir}/output.mp4`;
    const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

    const ctaStart = Math.floor(Math.max(totalDuration - 12, totalDuration * 0.8));
    const declarationStart = Math.floor(Math.max(totalDuration - 22, totalDuration * 0.65));

    // Dynamic FFMPEG input args looping each individual image
    let inputArgs = [];
    for (let i = 1; i <= 6; i++) {
      inputArgs.push(`-loop 1 -t ${segmentDuration} -i "${tmpDir}/image_${i}.jpg"`);
    }
    inputArgs.push(`-i "${tmpDir}/audio.mp3"`);

    // Build drawtext filters
    const filterArray = [];
    if (versetLine) {
      filterArray.push(`drawtext=fontfile=${fontFile}:textfile='${tmpDir}/verset.txt':fontcolor=white:fontsize=34:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-240:enable='between(t,0,10)'`);
    }
    if (declarationLine) {
      filterArray.push(`drawtext=fontfile=${fontFile}:textfile='${tmpDir}/declaration.txt':fontcolor=gold:fontsize=32:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y=h-300:enable='between(t,${declarationStart},${totalDuration})'`);
    }
    filterArray.push(`drawtext=fontfile=${fontFile}:textfile='${tmpDir}/cta.txt':fontcolor=white:fontsize=44:box=1:boxcolor=black@0.8:boxborderw=14:x=(w-text_w)/2:y=h-140:enable='between(t,${ctaStart},${totalDuration})'`);
    const textFilters = filterArray.map(f => `,${f}`).join('');

    // Constructing the complex cinematic filter graph
    let filterComplex = '';
    
    // Part A: Image processing (Blurred Background + Centered Foregound + Smooth Zoompan per clip)
    for (let i = 0; i < 6; i++) {
      filterComplex += 
        // 1. Create vertical blurred background out of original landscape image
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:10[bg${i}];` +
        // 2. Scale original image to fit screen dimensions without crop/zoom
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg${i}];` +
        // 3. Overlay the centered original on top of blurred canvas
        `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,` +
        // 4. Ken Burns smooth zoom filter
        `zoompan=z='min(zoom+0.0008,1.15)':d=${Math.ceil(25 * segmentDuration)}:s=1080x1920,fps=25[v${i}];\n`;
    }

    // Part B: Fluid Crossfade transition chain (using xfade filter)
    const transitionDuration = 1.0; // 1s smooth blend transition
    let currentStream = '[v0]';
    for (let i = 1; i < 6; i++) {
      const offset = (i * stepDuration) - transitionDuration;
      const nextStream = `[v_blend_${i}]`;
      filterComplex += `${currentStream}[v${i}]xfade=transition=fade:duration=${transitionDuration}:offset=${offset.toFixed(2)}${nextStream};\n`;
      currentStream = nextStream;
    }

    // Part C: Overlay subtitles on the unified, transitioned stream
    filterComplex += `${currentStream}${textFilters}[outv]`;

    // 3. Assemble and compile video with FFmpeg
    const ffmpegCmd = `ffmpeg -y \
      ${inputArgs.join(' ')} \
      -filter_complex "${filterComplex}" \
      -map "[outv]" \
      -map 6:a \
      -c:v libx264 -preset fast -crf 22 \
      -c:a aac -b:a 192k \
      -t ${totalDuration} \
      -movflags +faststart \
      -pix_fmt yuv420p \
      "${outputPath}"`;

    console.log(`[${jobId}] Executing Premium Slideshow FFmpeg rendering...`);
    execSync(ffmpegCmd, { timeout: 600000 });
    console.log(`[${jobId}] Slideshow generation complete`);

    // 4. Send video to public Google Drive storage
    console.log(`[${jobId}] Transferring final file to Drive...`);
    const fileName = `heros_foi_${jobId}.mp4`;
    const videoUrl = await uploadToDrive(outputPath, fileName);
    console.log(`[${jobId}] Process succeeded: ${videoUrl}`);

    // Cleanup workspace
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({
      success: true,
      video_url: videoUrl,
      job_id: jobId,
      duration: totalDuration
    });

  } catch (error) {
    console.error(`[${jobId}] Render Error:`, error.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`FFmpeg Assembly Service listening on port ${PORT}`);
  try {
    const v = execSync('ffmpeg -version').toString().split('\n')[0];
    console.log(`FFmpeg binary validated: ${v}`);
  } catch(e) { 
    console.error('Critical warning: FFmpeg binary not found on this system!'); 
  }
});
