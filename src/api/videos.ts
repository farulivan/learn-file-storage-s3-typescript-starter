import path from 'path';
import { rm } from 'fs/promises';
import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import { getBearerToken, validateJWT } from '../auth';
import { getVideo, updateVideo } from '../db/videos';
import { uploadVideoToS3 } from '../s3';

import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video not found");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden access to the video");
  }
  
  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video file missing");
  }
  
  const MAX_UPLOAD_SIZE = 1 << 30;

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    console.log("Video file size:", videoFile.size);
    throw new BadRequestError("Video file exceeds the maximum allowed size of 1GB")
  }

  const mediaType = videoFile.type;
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Invalid file type. Only MP4 allowed.");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, videoFile);

  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  const processedFilePath = await processVideoForFastStart(tempFilePath);

  const key = `${aspectRatio}/${videoId}.mp4`;
  await uploadVideoToS3(cfg, key, processedFilePath, "video/mp4");

  const videoUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoUrl;
  updateVideo(cfg.db, video);

  await Promise.all([
    rm(tempFilePath, { force: true }), 
    rm(`${tempFilePath}.processed.mp4`, { force: true }),
  ]);

  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(inputFilePath: string): Promise<'landscape' | 'portrait' | 'other'> {
  const proc = Bun.spawn([
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      inputFilePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exited = await proc.exited;

  if (exited !== 0) throw new Error(`ffprobe error: ${stderrText}`);

  const output = JSON.parse(stdoutText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }
  
  const { width, height } = output.streams[0];

  const ratio = width / height;
  
  if (Math.abs(ratio - 16/9) < 0.1) return 'landscape';
  if (Math.abs(ratio - 9/16) < 0.1) return 'portrait';
  return 'other';
}

async function processVideoForFastStart(inputFilePath: string) {
  const [ key ] = inputFilePath.split(".")
  const outputFilePath = `${key}.processed.mp4`
  const proc = Bun.spawn([
      'ffmpeg',
      '-i',
      inputFilePath,
      '-movflags',
      'faststart',
      '-map_metadata',
      '0',
      '-codec',
      'copy',
      '-f',
      'mp4',
      outputFilePath,
    ],
    {
      stderr: "pipe",
    }
  );

  const stderrText = await new Response(proc.stderr).text();
  const exited = await proc.exited;

  if (exited !== 0) throw new Error(`FFmpeg error: ${stderrText}`);

  return outputFilePath;
}