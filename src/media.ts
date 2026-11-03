import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToText } from "html-to-text";
import { fetchMedia, type Post } from "./api.js";

// Type aliases (not interfaces) so they satisfy the MCP SDK's index-signature content types.
type ImageBlock = {
	type: "image";
	data: string;
	mimeType: string;
};

type TextBlock = {
	type: "text";
	text: string;
};

// A post known to carry a file (see hasFile).
type FilePost = Post & {
	tim: number;
	ext: string;
	filename: string;
	fsize: number;
	w: number;
	h: number;
};

// Claude rejects images over ~5MB and downsamples anything past ~1568px anyway.
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_IMAGE_DIM = 1568;
const VIDEO_FRAME_WIDTH = 768;

const MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

const VIDEO_EXTS = new Set([".webm", ".mp4"]);

function hasFile(post: Post): post is FilePost {
	return post.tim !== undefined && post.ext !== undefined && !post.filedeleted;
}

function thumbnailUrl(board: string, post: FilePost) {
	return `https://i.4cdn.org/${board}/${post.tim}s.jpg`;
}

function fileUrl(board: string, post: FilePost) {
	return `https://i.4cdn.org/${board}/${post.tim}${post.ext}`;
}

function formatBytes(bytes: number) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.round(bytes / 1024)} KB`;
}

function describeFile(post: Post) {
	if (post.filedeleted) return "[file deleted]";
	if (!hasFile(post)) return null;
	const kind = VIDEO_EXTS.has(post.ext) ? "video" : "file";
	return `[${kind}: ${htmlToText(post.filename)}${post.ext}, ${post.w}x${post.h}, ${formatBytes(post.fsize)}]`;
}

function run(cmd: string, args: string[]) {
	return new Promise<Buffer>((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error)
					reject(new Error(`${cmd} failed: ${stderr.toString().slice(-500)}`));
				else resolve(stdout);
			},
		);
	});
}

async function withTempFile<T>(
	buffer: Buffer,
	ext: string,
	fn: (path: string) => Promise<T>,
) {
	const dir = await mkdtemp(join(tmpdir(), "chan-mcp-"));
	const path = join(dir, `media${ext}`);
	try {
		await writeFile(path, buffer);
		return await fn(path);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function jpegArgs(input: string, vf: string, seek?: string) {
	return [
		"-hide_banner",
		"-loglevel",
		"error",
		...(seek === undefined ? [] : ["-ss", seek]),
		"-i",
		input,
		"-frames:v",
		"1",
		"-vf",
		vf,
		"-pix_fmt",
		"yuvj420p",
		"-q:v",
		"3",
		"-f",
		"image2",
		"-c:v",
		"mjpeg",
		"pipe:1",
	];
}

function imageBlock(buffer: Buffer, mimeType: string): ImageBlock {
	return { type: "image", data: buffer.toString("base64"), mimeType };
}

async function thumbnailBlock(board: string, post: FilePost) {
	return imageBlock(await fetchMedia(thumbnailUrl(board, post)), "image/jpeg");
}

async function fullImageBlock(board: string, post: FilePost) {
	const buffer = await fetchMedia(fileUrl(board, post));
	const mimeType = MIME_TYPES[post.ext];
	const fits =
		buffer.length <= MAX_IMAGE_BYTES &&
		post.w <= MAX_IMAGE_DIM &&
		post.h <= MAX_IMAGE_DIM;
	if (mimeType && fits) return imageBlock(buffer, mimeType);

	// Too big (or an unsupported format): re-encode as a downscaled JPEG.
	const scale = `scale=w='min(${MAX_IMAGE_DIM},iw)':h='min(${MAX_IMAGE_DIM},ih)':force_original_aspect_ratio=decrease`;
	const jpeg = await withTempFile(buffer, post.ext, (path) =>
		run("ffmpeg", jpegArgs(path, scale)),
	);
	return imageBlock(jpeg, "image/jpeg");
}

async function videoFrameBlocks(
	board: string,
	post: FilePost,
	frameCount: number,
) {
	const buffer = await fetchMedia(fileUrl(board, post));
	return withTempFile(buffer, post.ext, async (path) => {
		const probe = await run("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=noprint_wrappers=1:nokey=1",
			path,
		]);
		const duration = Number.parseFloat(probe.toString()) || 0;
		const scale = `scale='min(${VIDEO_FRAME_WIDTH},iw)':-2`;

		const blocks: (TextBlock | ImageBlock)[] = [];
		for (let i = 0; i < frameCount; i++) {
			// Sample the midpoints of equal slices so we skip black first/last frames.
			const at = duration > 0 ? (duration * (i + 0.5)) / frameCount : 0;
			const frame = await run("ffmpeg", jpegArgs(path, scale, at.toFixed(2)));
			if (frame.length === 0) continue;
			blocks.push({
				type: "text",
				text: `Frame ${i + 1}/${frameCount} at ${at.toFixed(1)}s`,
			});
			blocks.push(imageBlock(frame, "image/jpeg"));
		}
		if (blocks.length === 0) {
			// Music webms are often a single still image over audio, so seeking finds nothing.
			const frame = await run("ffmpeg", jpegArgs(path, scale));
			blocks.push({
				type: "text",
				text: "No frames at the sampled times (likely a still image over audio); showing the first frame:",
			});
			blocks.push(imageBlock(frame, "image/jpeg"));
		}
		return { duration, blocks };
	});
}

export {
	describeFile,
	fileUrl,
	fullImageBlock,
	hasFile,
	thumbnailBlock,
	VIDEO_EXTS,
	videoFrameBlocks,
};
export type { FilePost, ImageBlock, TextBlock };
