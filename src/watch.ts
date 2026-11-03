import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { htmlToText } from "html-to-text";
import type { Post } from "./api.js";

interface WatchFilter {
	keywords?: string[];
	tripcodes?: string[];
	names?: string[];
	posterIds?: string[];
	repliesTo?: number[];
}

interface Watch {
	board: string;
	threadNo: number;
	subject: string;
	status: string;
	lastReadNo: number;
	filter?: WatchFilter;
	autoFollow?: boolean;
	myPosts?: number[];
	followedBy?: number;
	addedAt: string;
}

type Watches = Record<string, Watch>;

const STATE_DIR =
	process.env.CHAN_MCP_STATE_DIR ?? join(homedir(), ".chan-mcp-server");
const WATCHES_FILE = join(STATE_DIR, "watches.json");

function watchKey(board: string, threadNo: number) {
	return `${board}/${threadNo}`;
}

async function loadWatches(): Promise<Watches> {
	try {
		return JSON.parse(await readFile(WATCHES_FILE, "utf8"));
	} catch {
		return {};
	}
}

// Re-read right before writing: Claude Desktop and Claude Code each run their own server process on the same file.
// Within this process, updates run one at a time so concurrent tool calls can't interleave their read-modify-write.
let updateChain: Promise<unknown> = Promise.resolve();
let tmpCounter = 0;

function updateWatches<T>(mutate: (watches: Watches) => T): Promise<T> {
	const run = updateChain.then(async () => {
		const watches = await loadWatches();
		const result = mutate(watches);
		await mkdir(STATE_DIR, { recursive: true });
		const tmp = `${WATCHES_FILE}.${process.pid}.${tmpCounter++}.tmp`;
		await writeFile(tmp, JSON.stringify(watches, null, 2));
		await rename(tmp, WATCHES_FILE);
		return result;
	});
	updateChain = run.catch(() => {});
	return run;
}

function threadSubject(op: Post) {
	const text = htmlToText(op.sub || op.com || "(no subject)", {
		wordwrap: false,
	})
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export { loadWatches, threadSubject, updateWatches, WATCHES_FILE, watchKey };
export type { Watch, WatchFilter, Watches };
