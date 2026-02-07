import path from 'path';
import { rm } from 'fs/promises';
import { randomBytes } from 'crypto';
import { respondWithJSON } from "./json";
import { BadRequestError, NotFoundError, UserForbiddenError } from './errors';
import { getBearerToken, validateJWT } from '../auth';
import { getVideo, updateVideo } from '../db/videos';
import { mediaTypeToExt } from './assets';
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

  const ext = mediaTypeToExt(mediaType);
  const filename = `${randomBytes(32).toString("base64url")}${ext}`;

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  await Bun.write(tempFilePath, videoFile);

  await uploadVideoToS3(cfg, filename, tempFilePath, mediaType);

  const videoUrl = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${filename}`;
  video.videoURL = videoUrl;
  updateVideo(cfg.db, video);

  await Promise.all([rm(tempFilePath, { force: true })]);

  return respondWithJSON(200, video);
}
