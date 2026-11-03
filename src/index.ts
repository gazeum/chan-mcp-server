#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { htmlToText } from "html-to-text";
import { z } from "zod";
import {
	type Board,
	fetchBoards,
	fetchThreadIndex,
	fetchThreadOrNull,
	fetchThreads,
	type Post,
	type Thread,
} from "./api.js";
import {
	describeFile,
	type FilePost,
	fileUrl,
	fullImageBlock,
	hasFile,
	type ImageBlock,
	type TextBlock,
	thumbnailBlock,
	VIDEO_EXTS,
	videoFrameBlocks,
} from "./media.js";
import {
	loadWatches,
	threadSubject,
	updateWatches,
	WATCHES_FILE,
	type Watch,
	type WatchFilter,
	watchKey,
} from "./watch.js";

type Block = TextBlock | ImageBlock;
type Format = "full" | "compact";

function formatPoster(post: Post) {
	let poster = post.name ? htmlToText(post.name) : "Anonymous";
	if (post.trip) poster += ` ${post.trip}`;
	if (post.id) poster += ` (ID: ${post.id})`;
	if (post.capcode) poster += ` ## ${post.capcode}`;
	return poster;
}

function paginate<T>(items: T[], offset?: number, limit?: number) {
	const start = Math.max(0, offset ?? 0);
	const end = limit === undefined ? items.length : start + limit;
	return items.slice(start, end);
}

function rangeLabel(page: unknown[], offset: number, total: number) {
	if (page.length === 0)
		return `none of ${total} (offset ${offset} is past the end)`;
	return `${offset}-${offset + page.length - 1} of ${total}`;
}

// 4chan HTML: drop link targets (quote links like >>123 already carry the post number) and keep original line breaks.
function toText(html: string) {
	return htmlToText(html, {
		wordwrap: false,
		selectors: [{ selector: "a", options: { ignoreHref: true } }],
	});
}

// Post numbers a post quotes, from its raw HTML quote links (same-thread "#p123" and cross-thread "/thread/1#p123").
function quotedNos(post: Post) {
	return [
		...new Set(
			[...(post.com ?? "").matchAll(/#p(\d+)/g)].map((m) => Number(m[1])),
		),
	];
}

interface ReplyContext {
	threadNo: number | undefined;
	byNo: Map<number, Post>;
	batch: Set<number>;
	replyCounts: Map<number, number>;
	myPosts: Set<number>;
}

// Reply structure for a set of posts being shown: how often each post in the thread is quoted (backlinks), which posts
// are in this batch, and the user's own posts. Lets formatters mark (You)s, show reply counts, and give a short excerpt
// for quoted posts the reader can't see in this batch.
function replyContext(
	threadPosts: Post[],
	batch: Post[],
	myPosts?: number[],
): ReplyContext {
	const replyCounts = new Map<number, number>();
	for (const post of threadPosts) {
		for (const no of quotedNos(post))
			replyCounts.set(no, (replyCounts.get(no) ?? 0) + 1);
	}
	return {
		threadNo: threadPosts[0]?.no,
		byNo: new Map(threadPosts.map((p) => [p.no, p])),
		batch: new Set(batch.map((p) => p.no)),
		replyCounts,
		myPosts: new Set(myPosts ?? []),
	};
}

function excerpt(post: Post, maxLength: number) {
	const text =
		toText(post.com ?? "")
			.replace(/>>>?\S+/g, "")
			.replace(/\s+/g, " ")
			.trim() ||
		fileTag(post) ||
		"(empty)";
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// Rewrites ">>123" in post text: (You) for the user's posts, (OP), and an excerpt the first time a post outside this
// batch is quoted. Compact mode shortens the number to its last 4 digits.
function annotateQuotes(
	text: string,
	ctx: ReplyContext | undefined,
	compact: boolean,
) {
	const seen = new Set<number>();
	return text.replace(/>>(\d{5,})/g, (_, digits: string) => {
		const no = Number(digits);
		const ref = compact ? `>>…${digits.slice(-4)}` : `>>${digits}`;
		if (ctx?.myPosts.has(no)) return `${ref} (You)`;
		if (!ctx || no === ctx.threadNo) return ctx ? `${ref} (OP)` : ref;
		const quoted = ctx.byNo.get(no);
		if (!quoted || ctx.batch.has(no) || seen.has(no)) return ref;
		seen.add(no);
		return `${ref} ("${excerpt(quoted, 60)}")`;
	});
}

function replyBadge(post: Post, ctx?: ReplyContext) {
	const count = ctx?.replyCounts.get(post.no);
	return count ? `↩${count}` : "";
}

function formatPost(post: Post, ctx?: ReplyContext) {
	const file = describeFile(post);
	const badge = replyBadge(post, ctx);
	const mine = ctx?.myPosts.has(post.no) ? " (You)" : "";
	return `No.${post.no}${mine} | ${formatPoster(post)} | ${post.now ?? ""}${badge ? ` | ${badge}` : ""}${file ? `\n${file}` : ""}\n${annotateQuotes(toText(post.com ?? "(no comment)"), ctx, false)}`;
}

function formatThread(thread: Thread) {
	const file = describeFile(thread);
	return `No.${thread.no} - ${thread.sub ? toText(thread.sub) : "(no subject)"}\n${formatPoster(thread)} | ${thread.now ?? ""} | ${thread.replies ?? 0} replies${file ? `\n${file}` : ""}\n${toText(thread.com ?? "(no comment)")}`;
}

function shortTime(post: Post) {
	const d = new Date(post.time * 1000);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fileTag(post: Post) {
	if (post.filedeleted) return "[file deleted]";
	if (!hasFile(post)) return "";
	return VIDEO_EXTS.has(post.ext) ? "[vid]" : "[img]";
}

// Terse post format for polling: local HH:MM, poster only when not plain Anonymous, [img]/[vid] instead of file
// details, and quote links shortened to their last 4 digits (>>…6324). The post's own number stays in full.
function compactPost(post: Post, ctx?: ReplyContext) {
	const name =
		post.name && post.name !== "Anonymous" ? htmlToText(post.name) : "";
	const who = `${name}${post.trip ?? ""}${post.id ? `(${post.id})` : ""}${post.capcode ? `##${post.capcode}` : ""}`;
	const text = annotateQuotes(toText(post.com ?? ""), ctx, true);
	const head = [
		`${post.no}${ctx?.myPosts.has(post.no) ? " (You)" : ""}`,
		shortTime(post),
		who,
		replyBadge(post, ctx),
		fileTag(post),
	]
		.filter(Boolean)
		.join(" ");
	return [head, text].filter(Boolean).join("\n");
}

function postFormatter(format: Format, ctx: ReplyContext) {
	return format === "compact"
		? (post: Post) => compactPost(post, ctx)
		: (post: Post) => formatPost(post, ctx);
}

function compactThread(thread: Thread) {
	const text = toText(thread.com ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return `${thread.no} ${thread.sub ? toText(thread.sub) : "(no subject)"} · ${thread.replies ?? 0}r${fileTag(thread) ? ` ${fileTag(thread)}` : ""}\n${text.length > 200 ? `${text.slice(0, 199)}…` : text}`;
}

// Matches a link to postNo in raw 4chan HTML: ">>123", ">>>/board/123", or an <a href=".../thread/123#p123">.
function linksTo(html: string | undefined, postNo: number) {
	return new RegExp(
		`(?:&gt;|>){2}(?:(?:&gt;|>)/\\w+/)?${postNo}(?!\\d)|#p${postNo}(?!\\d)|/thread/${postNo}(?!\\d)`,
	).test(html ?? "");
}

function threadState(op: Post) {
	if (op.archived) return "archived";
	if (op.closed) return "closed";
	return "alive";
}

const GONE_HINT =
	"Use findLatestInChain to look for the thread that replaced it.";

function goneText(board: string, threadNo: number) {
	return `Thread No.${threadNo} on /${board}/ is gone (404: deleted, or pruned from the archive). ${GONE_HINT}`;
}

function stateNote(op: Post) {
	const state = threadState(op);
	return state === "alive"
		? ""
		: `\n[Thread is ${state.toUpperCase()}: no new replies are possible. ${GONE_HINT}]`;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

// Claude Code counts each image as a flat 1600 tokens and text as ~4 chars/token against a 25k-token limit per tool
// result (MAX_MCP_OUTPUT_TOKENS). Stay under it so nothing gets silently cut.
const IMAGE_TOKENS = 1600;
const DEFAULT_OUTPUT_BUDGET = 20000;
const DEFAULT_MAX_THUMBNAILS = 10;
const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const thumbnailSchema = {
	format: z
		.enum(["full", "compact"])
		.optional()
		.describe(
			"full (default): post number, poster, full date, file name/size. compact: HH:MM, name only if set, [img]/[vid], quote links shortened to >>…1234. Roughly a third smaller; good for polling.",
		),
	includeThumbnails: z
		.boolean()
		.optional()
		.describe(
			"Attach small thumbnails of each item's image/video right after its text. Default true. Use fetchMedia for the full-size image or video frames.",
		),
	maxThumbnails: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			`Thumbnails per page. Default ${DEFAULT_MAX_THUMBNAILS}. The page ends before a post that would need one more, so every post shown keeps its thumbnail. Each costs ~${IMAGE_TOKENS} tokens of tool output.`,
		),
	maxOutputTokens: z
		.number()
		.int()
		.min(2000)
		.optional()
		.describe(
			`Approximate token budget for this result (text ~4 chars/token, ${IMAGE_TOKENS} per image). Default ${DEFAULT_OUTPUT_BUDGET}, under the client's 25k limit. The page ends before an item that would exceed it and says how to continue; nothing is silently cut.`,
		),
};

interface BudgetOptions {
	board: string;
	header: string | ((count: number) => string);
	items: Post[];
	format: (item: Post) => string;
	includeThumbnails: boolean;
	maxThumbnails: number;
	budget: number;
	continueHint?: (
		lastShown: Post,
		omitted: Post[],
		shownCount: number,
	) => string;
}

// Builds one page of interleaved text+thumbnails within a token budget. Each item is costed together with its
// thumbnail, and the page ends before an item that would go over the budget or over maxThumbnails, so every post shown
// has its image and the rest can be paged with continueHint.
async function budgetedContent({
	board,
	header,
	items,
	format,
	includeThumbnails,
	maxThumbnails,
	budget,
	continueHint = (lastShown) => `continue with afterPostNo=${lastShown.no}`,
}: BudgetOptions) {
	const withImages = includeThumbnails && maxThumbnails > 0;
	// header may be a function of how many items fit, so its range matches what is actually shown.
	const headerText = (count: number) =>
		typeof header === "function" ? header(count) : header;
	let used = estimateTokens(headerText(items.length)) + 200;
	const shown: { item: Post; text: string; needsImage: boolean }[] = [];
	let planned = 0;
	let stopReason = "output budget";
	for (const item of items) {
		const text = format(item);
		const needsImage = withImages && hasFile(item);
		if (shown.length > 0 && needsImage && planned >= maxThumbnails) {
			stopReason = `${maxThumbnails} thumbnails per page`;
			break;
		}
		const cost = estimateTokens(text) + (needsImage ? IMAGE_TOKENS : 0);
		if (shown.length > 0 && used + cost > budget) break;
		shown.push({ item, text, needsImage });
		used += cost;
		if (needsImage) planned++;
	}

	const thumbnails = new Map<number, Block>(
		await Promise.all(
			shown
				.filter((s) => s.needsImage)
				.map(async ({ item }): Promise<[number, Block]> => {
					try {
						return [item.no, await thumbnailBlock(board, item as FilePost)];
					} catch (error) {
						return [
							item.no,
							{
								type: "text",
								text: `(thumbnail unavailable: ${(error as Error).message})`,
							},
						];
					}
				}),
		),
	);

	const content: Block[] = [{ type: "text", text: headerText(shown.length) }];
	for (const { item, text } of shown) {
		content.push({ type: "text", text });
		const thumbnail = thumbnails.get(item.no);
		if (thumbnail) content.push(thumbnail);
	}
	const omitted = items.slice(shown.length);
	if (omitted.length > 0) {
		content.push({
			type: "text",
			text: `Page ends here (${stopReason}): showing ${shown.length} of ${items.length}. Next is No.${omitted[0].no}; ${continueHint(shown[shown.length - 1].item, omitted, shown.length)}.`,
		});
	}
	return { content, used, shownCount: shown.length };
}

const INSTRUCTIONS = `Read-only access to 4chan via its public JSON API.

Browsing:
- fetchThreads returns a board's catalog (often 150+ threads). Filter with subject (regex), sort by "newest", and page with offset/limit.
- fetchPosts reads a thread. afterPostNo returns only replies newer than the last post you read; offset/limit read in chunks (negative offset = latest posts). Filters: name, tripcode, posterId, repliesTo.
- Each post header shows the post number, poster (name, tripcode, per-thread ID on boards that have them, capcode), time, and ↩N = how many posts in the thread reply to it (a rough importance signal).
- ">>123" is a reply to post No.123. When the quoted post isn't in the same result, a short excerpt follows it: >>123 ("excerpt…"). (OP) marks quotes of the thread's first post, and (You) marks quotes of the user's own posts (set with watchThread myPosts or addMyPosts).
- Archived and deleted threads are reported explicitly, never as an empty result. A deleted thread (404) is not an error.

Generals (recurring threads):
- When a general rolls over, the new OP links the old one (">>12345"). findLatestInChain follows those links forward from any thread number to the current one, and falls back to subject matches if no link is found.

Polling for new posts (nothing pushes updates; each check is a model turn, so keep quiet checks cheap):
- Preferred: watchThread once, then checkWatched on each check. It returns only unread posts and keeps the read position server-side. Useful options: format "compact" (about a third smaller), includeThumbnails false, minNew (below it you get a one-line count and nothing is marked read), waitSeconds (holds the call up to 300s until minNew posts arrive; keep it under the client's tool timeout).
- checkWatched's per-thread header lists "Earlier posts drawing replies": already-read posts that several new posts reply to.
- watchThread can take a filter (keywords, tripcodes, names, posterIds, repliesTo; any match) so only relevant posts surface; replies to the user's own posts (myPosts) always surface, and autoFollow (default true): when the thread hits the bump limit or dies, checkWatched starts watching the next general (whose OP links the old one) and says so.
- threadStatus(board, threadNo, afterPostNo) is one line without post bodies, e.g. "alive · 226r · +4 · p1/11 · 84 to bump · 122/h · next 7m · last No.123". "next Nm" is a suggested interval aiming for ~15 new posts per check (tune with targetNewPosts; clamped 2-120 min). detail: true gives the full activity breakdown as JSON.
- If a thread is archived or deleted and isn't auto-followed, use findLatestInChain.
- When nothing new happened, end the turn after the tool call without narrating.

Media and output size:
- Posts with attachments show a line like [file: name.jpg, WxH, size] or [video: name.webm, ...]; thumbnails (125-250px) follow by default.
- Results are paged to stay under an output budget (default ${DEFAULT_OUTPUT_BUDGET} tokens; each image counts ${IMAGE_TOKENS}) and ${DEFAULT_MAX_THUMBNAILS} thumbnails per page. Every post shown keeps its thumbnail; when a page ends early, the last line says how to continue (afterPostNo for posts, offset for threads). fetchThumbnails(postNos) gets thumbnails for specific posts, e.g. after reading with includeThumbnails false.
- fetchMedia gets one post's full image (downscaled to 1568px if larger) or still frames from a video (no audio). Animated GIFs come through as a single frame.
- Boards may contain NSFW media, including boards marked work-safe.`;

const server = new McpServer(
	{
		name: "4chan MCP Server",
		version: "0.8.0",
	},
	{
		capabilities: {
			resources: {},
			tools: {},
		},
		instructions: INSTRUCTIONS,
	},
);

server.tool("fetchBoards", "Fetch list of 4chan boards", async () => {
	const boards = await fetchBoards();

	const formattedBoards = boards
		.map((board) => `/${board.board}/ - ${board.title}`)
		.join("\n");

	return {
		content: [
			{
				type: "text",
				text: `Fetched ${boards.length} boards:\n${formattedBoards}`,
			},
		],
	};
});

server.tool(
	"fetchThreads",
	"Fetch threads from a 4chan board's catalog. Filter by subject regex, sort, and page with offset/limit.",
	{
		board: z
			.string()
			.describe("The board to fetch threads from, e.g., 'g' for /g/"),
		subject: z
			.string()
			.optional()
			.describe(
				"Case-insensitive regex matched against the subject (or the OP text when there is no subject), e.g. 'gaygen|cisgaygen'.",
			),
		sort: z
			.enum(["bump", "newest", "replies"])
			.optional()
			.describe(
				"bump = catalog order (default), newest = most recently created first, replies = most replies first.",
			),
		offset: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe("Index of the first thread to return (0-based). Default 0."),
		limit: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				"Maximum number of threads to return. Default: all (within the output budget).",
			),
		...thumbnailSchema,
	},
	async ({
		board,
		subject,
		sort = "bump",
		offset = 0,
		limit,
		format = "full",
		includeThumbnails = true,
		maxThumbnails = DEFAULT_MAX_THUMBNAILS,
		maxOutputTokens = DEFAULT_OUTPUT_BUDGET,
	}) => {
		let threads = await fetchThreads(board);
		if (subject) {
			const pattern = new RegExp(subject, "i");
			threads = threads.filter((t) =>
				pattern.test(toText(t.sub || t.com || "")),
			);
		}
		if (sort === "newest") threads = [...threads].sort((a, b) => b.no - a.no);
		if (sort === "replies")
			threads = [...threads].sort(
				(a, b) => (b.replies ?? 0) - (a.replies ?? 0),
			);

		const page = paginate(threads, offset, limit);
		const filterLabel = subject ? ` matching /${subject}/i` : "";
		const header = (count: number) =>
			`Fetched threads ${rangeLabel(page.slice(0, count), offset, threads.length)}${filterLabel} from /${board}/ (sort: ${sort}):`;
		const { content } = await budgetedContent({
			board,
			header,
			items: page,
			format: format === "compact" ? compactThread : formatThread,
			includeThumbnails,
			maxThumbnails,
			budget: maxOutputTokens,
			continueHint: (_last, _omitted, shownCount) =>
				`continue with offset=${offset + shownCount}`,
		});
		return { content };
	},
);

server.tool(
	"fetchPosts",
	"Fetch posts from a 4chan thread. Use afterPostNo for new replies only, offset/limit to read part of a thread, and the filters to narrow by poster or by replies to a post. Archived/deleted threads are reported explicitly.",
	{
		board: z.string().describe("The board the thread is on, e.g., 'g' for /g/"),
		threadNo: z.number().describe("The thread number to fetch posts from"),
		offset: z
			.number()
			.int()
			.optional()
			.describe(
				"Index of the first post to return (0 = OP). Negative values count from the end, e.g. -20 for the last 20 posts. Default 0.",
			),
		limit: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				"Maximum number of posts to return. Default: all remaining (within the output budget).",
			),
		afterPostNo: z
			.number()
			.optional()
			.describe(
				"Only return posts with a post number greater than this (useful for fetching new replies since the last read). Applied before filters and offset/limit.",
			),
		name: z
			.string()
			.optional()
			.describe("Only posts whose name contains this (case-insensitive)."),
		tripcode: z
			.string()
			.optional()
			.describe("Only posts with exactly this tripcode, e.g. '!Ep8pui8Vw2'."),
		posterId: z
			.string()
			.optional()
			.describe("Only posts with this per-thread poster ID (boards with IDs)."),
		repliesTo: z
			.number()
			.optional()
			.describe("Only posts that quote/reply to this post number."),
		...thumbnailSchema,
	},
	async ({
		board,
		threadNo,
		offset = 0,
		limit,
		afterPostNo,
		name,
		tripcode,
		posterId,
		repliesTo,
		format = "full",
		includeThumbnails = true,
		maxThumbnails = DEFAULT_MAX_THUMBNAILS,
		maxOutputTokens = DEFAULT_OUTPUT_BUDGET,
	}) => {
		const allPosts = await fetchThreadOrNull(board, threadNo);
		if (!allPosts) return textResult(goneText(board, threadNo));
		const op = allPosts[0];
		const lastNo = allPosts[allPosts.length - 1].no;

		let posts =
			afterPostNo === undefined
				? allPosts
				: allPosts.filter((post) => post.no > afterPostNo);

		const filters: string[] = [];
		if (name) {
			const needle = name.toLowerCase();
			posts = posts.filter((p) =>
				htmlToText(p.name ?? "")
					.toLowerCase()
					.includes(needle),
			);
			filters.push(`name~"${name}"`);
		}
		if (tripcode) {
			posts = posts.filter((p) => p.trip === tripcode);
			filters.push(`trip=${tripcode}`);
		}
		if (posterId) {
			posts = posts.filter((p) => p.id === posterId);
			filters.push(`id=${posterId}`);
		}
		if (repliesTo !== undefined) {
			posts = posts.filter((p) => linksTo(p.com, repliesTo));
			filters.push(`replies to No.${repliesTo}`);
		}

		if (
			afterPostNo !== undefined &&
			posts.length === 0 &&
			filters.length === 0
		) {
			return textResult(
				`No new posts after No.${afterPostNo}. Thread No.${threadNo} on /${board}/ is ${threadState(op)}, ${allPosts.length} posts, last No.${lastNo}.${stateNote(op)}`,
			);
		}

		const start = offset < 0 ? Math.max(0, posts.length + offset) : offset;
		const page = paginate(posts, start, limit);
		const scope = [
			afterPostNo === undefined ? null : `after No.${afterPostNo}`,
			filters.length ? `filtered: ${filters.join(", ")}` : null,
		]
			.filter(Boolean)
			.join("; ");
		const header = (count: number) =>
			`Fetched posts ${rangeLabel(page.slice(0, count), start, posts.length)}${scope ? ` (${scope}; thread has ${allPosts.length} total)` : ""} from thread No.${threadNo} on /${board}/. Thread is ${threadState(op)}, last post No.${lastNo}.${stateNote(op)}`;

		const myPosts = (await loadWatches())[watchKey(board, threadNo)]?.myPosts;
		const ctx = replyContext(allPosts, page, myPosts);
		const { content } = await budgetedContent({
			board,
			header,
			items: page,
			format: postFormatter(format, ctx),
			includeThumbnails,
			maxThumbnails,
			budget: maxOutputTokens,
		});
		return { content };
	},
);

server.tool(
	"fetchThumbnails",
	"Fetch thumbnails for specific posts in a thread, e.g. after reading text-only with includeThumbnails false.",
	{
		board: z.string().describe("The board the thread is on"),
		threadNo: z.number().describe("The thread the posts are in"),
		postNos: z
			.array(z.number())
			.min(1)
			.describe("Post numbers whose thumbnails to fetch"),
		maxOutputTokens: thumbnailSchema.maxOutputTokens,
	},
	async ({
		board,
		threadNo,
		postNos,
		maxOutputTokens = DEFAULT_OUTPUT_BUDGET,
	}) => {
		const allPosts = await fetchThreadOrNull(board, threadNo);
		if (!allPosts) return textResult(goneText(board, threadNo));
		const wanted = new Set(postNos);
		const posts = allPosts.filter((p) => wanted.has(p.no));
		const missing = postNos.filter((no) => !posts.some((p) => p.no === no));
		const noFile = posts.filter((p) => !hasFile(p)).map((p) => p.no);
		const items = posts.filter(hasFile);
		const notes = [
			missing.length ? `not found in thread: ${missing.join(", ")}` : null,
			noFile.length ? `no file: ${noFile.join(", ")}` : null,
		]
			.filter(Boolean)
			.join("; ");
		const header = `Thumbnails for ${items.length} post(s) in thread No.${threadNo} on /${board}/${notes ? ` (${notes})` : ""}:`;
		const { content } = await budgetedContent({
			board,
			header,
			items,
			format: (p) => `No.${p.no} ${describeFile(p)}`,
			includeThumbnails: true,
			maxThumbnails: items.length,
			budget: maxOutputTokens,
			continueHint: (_last, omitted) =>
				`call fetchThumbnails again with postNos [${omitted.map((p) => p.no).join(", ")}]`,
		});
		return { content };
	},
);

let boardsCache: Promise<Board[]> | undefined;
async function boardInfo(board: string) {
	boardsCache ??= fetchBoards().catch((error) => {
		boardsCache = undefined;
		throw error;
	});
	return (await boardsCache).find((b) => b.board === board);
}

const MIN_CHECK_MINUTES = 2;
const MAX_CHECK_MINUTES = 120;
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Activity {
	postsLast15m: number;
	postsLastHour: number;
	postsLast6h: number;
	postsPerHour: number;
	medianGapMinutes: number | null;
	minutesSinceLastPost: number;
	threadAgeHours: number;
	postsUntilBumpLimit?: number;
	hoursUntilBumpLimit?: number;
	page?: string;
	estHoursUntilArchived?: number;
	suggestedCheckMinutes?: number;
	suggestionBasis?: string;
	advice?: string;
}

// Posting statistics from post timestamps, plus where the thread sits on the board, to pick a polling interval.
async function threadActivity(
	board: string,
	posts: Post[],
	targetNewPosts: number,
) {
	const now = Date.now() / 1000;
	const op = posts[0];
	const times = posts.map((p) => p.time);
	const countSince = (seconds: number) =>
		times.filter((t) => t > now - seconds).length;
	const last15m = countSince(15 * 60);
	const lastHour = countSince(3600);
	const last6h = countSince(6 * 3600);
	const minutesSinceLast = (now - times[times.length - 1]) / 60;
	// A slow last hour says little on its own, so fall back to the 6h average when it has few posts, unless the
	// thread has gone quiet (nothing for an hour): then the 6h average reflects a busy spell that's over.
	const postsPerHour =
		lastHour >= 5 || minutesSinceLast > 60 ? lastHour : last6h / 6;
	const recent = times.slice(-21);
	const gaps = recent
		.slice(1)
		.map((t, i) => t - recent[i])
		.sort((a, b) => a - b);
	const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

	const activity: Activity = {
		postsLast15m: last15m,
		postsLastHour: lastHour,
		postsLast6h: last6h,
		postsPerHour: round1(postsPerHour),
		medianGapMinutes: medianGap === null ? null : round1(medianGap / 60),
		minutesSinceLastPost: round1(minutesSinceLast),
		threadAgeHours: round1((now - op.time) / 3600),
	};

	const [info, index] = await Promise.all([
		boardInfo(board).catch(() => undefined),
		fetchThreadIndex(board).catch(() => undefined),
	]);
	const advice: string[] = [];
	let etaArchiveHours: number | undefined;

	if (info?.bump_limit !== undefined) {
		const remaining = info.bump_limit - (op.replies ?? posts.length - 1);
		if (remaining > 0) {
			activity.postsUntilBumpLimit = remaining;
			if (postsPerHour > 0)
				activity.hoursUntilBumpLimit = round1(remaining / postsPerHour);
		}
	}
	if (index) {
		const position = index.findIndex((t) => t.no === op.no);
		if (position >= 0) {
			// The index can run a page past boards.json "pages" while threads wait to be archived, so measure it directly.
			activity.page = `${index[position].page} of ${index[index.length - 1].page}`;
			// Threads bumped in the last hour overtake a thread that can't be bumped; when it's pushed past the last
			// slot it gets archived. Rough, since board activity varies through the day.
			if (op.bumplimit) {
				const capacity = index.length;
				const bumpsPerHour = index.filter(
					(t) => t.last_modified > now - 3600 && t.no !== op.no,
				).length;
				if (bumpsPerHour > 0) {
					etaArchiveHours = Math.max(
						0,
						(capacity - position - 1) / bumpsPerHour,
					);
					activity.estHoursUntilArchived = round1(etaArchiveHours);
				}
			}
		}
	}

	let minutes =
		postsPerHour > 0 ? (targetNewPosts / postsPerHour) * 60 : MAX_CHECK_MINUTES;
	if (op.bumplimit) {
		advice.push(
			"Bump limit reached: a successor general usually appears soon; check findLatestInChain.",
		);
		if (etaArchiveHours !== undefined)
			minutes = Math.min(
				minutes,
				Math.max(MIN_CHECK_MINUTES, (etaArchiveHours * 60) / 2),
			);
	} else if (
		activity.hoursUntilBumpLimit !== undefined &&
		activity.hoursUntilBumpLimit * 60 < minutes
	) {
		advice.push("Will hit the bump limit before the next check at this rate.");
	}
	if (postsPerHour === 0) {
		advice.push(
			last6h === 0
				? "No posts in 6h; the thread is dormant."
				: `Quiet for ${Math.round(minutesSinceLast)} min after ${last6h} posts in 6h; activity may have moved elsewhere.`,
		);
	}
	activity.suggestedCheckMinutes = Math.round(
		Math.min(MAX_CHECK_MINUTES, Math.max(MIN_CHECK_MINUTES, minutes)),
	);
	activity.suggestionBasis = `~${targetNewPosts} new posts per check`;
	if (advice.length) activity.advice = advice.join(" ");
	return activity;
}

interface ThreadStatus {
	board: string;
	threadNo: number;
	status: string;
	replyCount: number;
	lastPostNo: number;
	newPostCount?: number;
	bumpLimit?: boolean;
	hint?: string;
	activity?: Activity;
}

// One line for routine polls, e.g. "alive · 226r · +4 · p1/11 · 84 to bump · 122/h · next 7m".
function statusLine(status: ThreadStatus) {
	const a: Partial<Activity> = status.activity ?? {};
	const parts = [status.status, `${status.replyCount}r`];
	if (status.newPostCount !== undefined) parts.push(`+${status.newPostCount}`);
	if (a.page) parts.push(`p${a.page.replace(" of ", "/")}`);
	if (status.bumpLimit)
		parts.push(
			a.estHoursUntilArchived !== undefined
				? `bump limit, ~${Math.round(a.estHoursUntilArchived * 60)}m to archive`
				: "bump limit",
		);
	else if (a.postsUntilBumpLimit !== undefined)
		parts.push(`${a.postsUntilBumpLimit} to bump`);
	if (a.postsPerHour !== undefined) parts.push(`${a.postsPerHour}/h`);
	if (a.suggestedCheckMinutes !== undefined)
		parts.push(`next ${a.suggestedCheckMinutes}m`);
	parts.push(`last No.${status.lastPostNo}`);
	return `${parts.join(" · ")}${a.advice ? `\n${a.advice}` : ""}${status.hint ? `\n${status.hint}` : ""}`;
}

server.tool(
	"threadStatus",
	"Cheap check for new posts, no post bodies. By default one line: state, reply count, +new posts after afterPostNo, page, posts until bump limit, posts/hour, suggested minutes until the next check, last post number. detail: true returns the full activity breakdown as JSON.",
	{
		board: z.string().describe("The board the thread is on"),
		threadNo: z.number().describe("The thread to check"),
		afterPostNo: z
			.number()
			.optional()
			.describe("Count posts newer than this post number"),
		targetNewPosts: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				"How many new posts you'd like waiting per check; the suggested interval is based on it. Default 15 (about one page of text).",
			),
		detail: z
			.boolean()
			.optional()
			.describe(
				"Return the full activity breakdown as JSON (posts in last 15m/1h/6h, median gap, minutes since last post, thread age, hours until bump limit/archive). Default false.",
			),
	},
	async ({
		board,
		threadNo,
		afterPostNo,
		targetNewPosts = 15,
		detail = false,
	}) => {
		const posts = await fetchThreadOrNull(board, threadNo);
		if (!posts) {
			const gone = { board, threadNo, status: "deleted", hint: GONE_HINT };
			return textResult(
				detail ? JSON.stringify(gone) : `deleted\n${GONE_HINT}`,
			);
		}
		const op = posts[0];
		const status: ThreadStatus = {
			board,
			threadNo,
			status: threadState(op),
			replyCount: op.replies ?? posts.length - 1,
			lastPostNo: posts[posts.length - 1].no,
		};
		if (afterPostNo !== undefined)
			status.newPostCount = posts.filter((p) => p.no > afterPostNo).length;
		if (op.bumplimit) status.bumpLimit = true;
		if (status.status !== "alive") {
			status.hint = GONE_HINT;
		} else {
			status.activity = await threadActivity(board, posts, targetNewPosts);
		}
		return textResult(detail ? JSON.stringify(status) : statusLine(status));
	},
);

// Follows OP links forward through the catalog: each new general's OP links the previous one.
function followChain(catalog: Thread[], threadNo: number) {
	const chain: Thread[] = [];
	const alternatives: Thread[] = [];
	let current = threadNo;
	for (let hop = 0; hop < 20; hop++) {
		const successors = catalog.filter(
			(t) => t.no > current && linksTo(t.com, current),
		);
		if (successors.length === 0) break;
		// Rival splits happen; follow the busiest one and report the others.
		successors.sort((a, b) => (b.replies ?? 0) - (a.replies ?? 0));
		chain.push(successors[0]);
		alternatives.push(...successors.slice(1));
		current = successors[0].no;
	}
	return { chain, alternatives };
}

server.tool(
	"findLatestInChain",
	"Find the current thread of a recurring general. Follows OP links forward from the given thread (a new general's OP links the old one with >>12345), across subject changes. If no linking thread exists yet, lists recent threads with a similar subject.",
	{
		board: z.string().describe("The board the general is on"),
		threadNo: z
			.number()
			.describe("Any known thread of the general, e.g. the last one you read"),
		subjectHint: z
			.string()
			.optional()
			.describe(
				"Fallback case-insensitive regex for the subject, used if no linking thread is found, e.g. 'gaygen'. Defaults to the /tags/ in the starting thread's subject.",
			),
	},
	async ({ board, threadNo, subjectHint }) => {
		const [catalog, startPosts] = await Promise.all([
			fetchThreads(board),
			fetchThreadOrNull(board, threadNo),
		]);
		const startOp = startPosts?.[0];
		const startLabel = startOp
			? `No.${threadNo} "${threadSubject(startOp)}" (${threadState(startOp)})`
			: `No.${threadNo} (deleted/pruned)`;

		const { chain, alternatives } = followChain(catalog, threadNo);
		const line = (t: Thread) =>
			`No.${t.no} "${threadSubject(t)}" | ${t.replies ?? 0} replies | created ${t.now}`;
		const lines = [`Start: ${startLabel}`];

		if (chain.length > 0) {
			lines.push(
				"Followed OP links forward:",
				...chain.map((t, i) => `  ${i + 1}. ${line(t)}`),
			);
			lines.push(`Latest: No.${chain[chain.length - 1].no}`);
			if (alternatives.length > 0)
				lines.push(
					"Other threads linking into the chain (possible split):",
					...alternatives.map((t) => `  - ${line(t)}`),
				);
		} else {
			lines.push(
				startOp && threadState(startOp) === "alive"
					? "No newer thread links to it; it is still the latest."
					: "No live thread links to it.",
			);
			const tags = startOp
				? (toText(startOp.sub ?? "").match(/\/[\w-]+\//g) ?? []).map((t) =>
						t.slice(1, -1),
					)
				: [];
			const hint = subjectHint ?? (tags.length ? tags.join("|") : null);
			if (hint) {
				const pattern = new RegExp(hint, "i");
				const candidates = catalog
					.filter(
						(t) =>
							t.no !== threadNo && pattern.test(toText(t.sub || t.com || "")),
					)
					.sort((a, b) => b.no - a.no)
					.slice(0, 5);
				lines.push(
					candidates.length
						? `Newest threads with subject matching /${hint}/i:\n${candidates.map((t) => `  - ${line(t)}`).join("\n")}`
						: `No live threads match /${hint}/i.`,
				);
			} else if (!startOp) {
				lines.push("Pass subjectHint (e.g. 'gaygen') to search by subject.");
			}
		}

		return textResult(lines.join("\n"));
	},
);

server.tool(
	"fetchMedia",
	"Fetch the full-size image attached to a 4chan post, or evenly spaced still frames from an attached video (webm/mp4). Large images are downscaled to fit.",
	{
		board: z.string().describe("The board the thread is on, e.g., 'g' for /g/"),
		threadNo: z.number().describe("The thread the post is in"),
		postNo: z
			.number()
			.describe("The post whose attachment to fetch (use threadNo for the OP)"),
		frames: z
			.number()
			.int()
			.min(1)
			.max(12)
			.optional()
			.describe("For videos: number of frames to extract. Default 4."),
	},
	async ({ board, threadNo, postNo, frames = 4 }) => {
		const posts = await fetchThreadOrNull(board, threadNo);
		if (!posts) return textResult(goneText(board, threadNo));
		const post = posts.find((p) => p.no === postNo);
		if (!post) {
			throw new Error(
				`Post No.${postNo} not found in thread No.${threadNo} on /${board}/`,
			);
		}
		if (!hasFile(post)) {
			throw new Error(`Post No.${postNo} has no attached file`);
		}

		const header = `No.${post.no} | ${formatPoster(post)} | ${describeFile(post)}\n${fileUrl(board, post)}`;

		if (VIDEO_EXTS.has(post.ext)) {
			const { duration, blocks } = await videoFrameBlocks(board, post, frames);
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}\nVideo, ${duration.toFixed(1)}s long. ${frames} frames sampled (audio not included):`,
					},
					...blocks,
				],
			};
		}

		if (post.ext === ".pdf" || post.ext === ".swf") {
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}\n${post.ext} files can't be shown as images.`,
					},
					await thumbnailBlock(board, post),
				],
			};
		}

		return {
			content: [
				{ type: "text" as const, text: header },
				await fullImageBlock(board, post),
			],
		};
	},
);

const filterSchema = z
	.object({
		keywords: z
			.array(z.string())
			.optional()
			.describe("Post text contains any of these (case-insensitive)"),
		tripcodes: z
			.array(z.string())
			.optional()
			.describe("Poster has one of these tripcodes"),
		names: z
			.array(z.string())
			.optional()
			.describe("Poster name contains one of these (case-insensitive)"),
		posterIds: z.array(z.string()).optional().describe("Per-thread poster IDs"),
		repliesTo: z
			.array(z.number())
			.optional()
			.describe("Post replies to one of these post numbers"),
	})
	.optional()
	.describe(
		"Only surface posts matching ANY of these criteria; other new posts are skipped and marked read. Carried over when following to the next thread.",
	);

function matchesFilter(post: Post, filter?: WatchFilter, myPosts?: number[]) {
	if (myPosts?.length && quotedNos(post).some((no) => myPosts.includes(no)))
		return true;
	if (!filter) return true;
	const text = toText(post.com ?? "").toLowerCase();
	const name = htmlToText(post.name ?? "").toLowerCase();
	return Boolean(
		filter.keywords?.some((k) => text.includes(k.toLowerCase())) ||
			(post.trip && filter.tripcodes?.includes(post.trip)) ||
			filter.names?.some((n) => name.includes(n.toLowerCase())) ||
			(post.id && filter.posterIds?.includes(post.id)) ||
			filter.repliesTo?.some((no) => linksTo(post.com, no)),
	);
}

function describeFilter(filter?: WatchFilter) {
	if (!filter) return "";
	const parts = Object.entries(filter)
		.filter(([, v]) => v?.length)
		.map(([k, v]) => `${k}: ${v.join(", ")}`);
	return parts.length ? ` [filter ${parts.join("; ")}]` : "";
}

server.tool(
	"watchThread",
	"Subscribe to a 4chan thread so checkWatched returns its new posts. Optionally filter which posts surface, and (by default) follow the general to its next thread automatically.",
	{
		board: z.string().describe("The board the thread is on, e.g., 'g' for /g/"),
		threadNo: z.number().describe("The thread number to watch"),
		filter: filterSchema,
		autoFollow: z
			.boolean()
			.optional()
			.describe(
				"When the thread hits the bump limit or is archived/deleted, start watching the thread whose OP links to it. Default true.",
			),
		myPosts: z
			.array(z.number())
			.optional()
			.describe(
				"Post numbers that are the user's own. Replies to them are marked (You) and always surface, even past a filter. Add more later with addMyPosts.",
			),
	},
	async ({ board, threadNo, filter, autoFollow = true, myPosts }) => {
		const posts = await fetchThreadOrNull(board, threadNo);
		if (!posts) return textResult(goneText(board, threadNo));
		const op = posts[0];
		const lastNo = posts[posts.length - 1].no;
		const key = watchKey(board, threadNo);
		const existed = await updateWatches((watches) => {
			const had = Boolean(watches[key]);
			watches[key] = {
				board,
				threadNo,
				subject: threadSubject(op),
				status: threadState(op),
				// Only posts after subscribing count as new.
				lastReadNo: lastNo,
				filter,
				autoFollow,
				myPosts,
				addedAt: new Date().toISOString(),
			};
			return had;
		});
		return textResult(
			`${existed ? "Re-watching" : "Now watching"} /${board}/ No.${threadNo} "${threadSubject(op)}" (${posts.length} posts so far)${describeFilter(filter)}. checkWatched will return posts after No.${lastNo}${autoFollow ? " and follow the general to its next thread" : ""}.${stateNote(op)}`,
		);
	},
);

server.tool(
	"addMyPosts",
	"Record post numbers as the user's own on a watched thread, so replies to them are marked (You) and always surface in checkWatched.",
	{
		board: z.string().describe("The board the thread is on"),
		threadNo: z.number().describe("The watched thread"),
		postNos: z.array(z.number()).min(1).describe("The user's post numbers"),
	},
	async ({ board, threadNo, postNos }) => {
		const key = watchKey(board, threadNo);
		const mine = await updateWatches((watches) => {
			const watch = watches[key];
			if (!watch) return null;
			watch.myPosts = [...new Set([...(watch.myPosts ?? []), ...postNos])];
			return watch.myPosts;
		});
		return textResult(
			mine
				? `/${board}/ No.${threadNo}: your posts are now ${mine.join(", ")}.`
				: `/${board}/ No.${threadNo} isn't being watched; watchThread it first.`,
		);
	},
);

server.tool(
	"unwatchThread",
	"Stop watching a 4chan thread.",
	{
		board: z.string().describe("The board the thread is on"),
		threadNo: z.number().describe("The thread number to stop watching"),
	},
	async ({ board, threadNo }) => {
		const key = watchKey(board, threadNo);
		const removed = await updateWatches((watches) => {
			const had = Boolean(watches[key]);
			delete watches[key];
			return had;
		});
		return textResult(
			removed
				? `Stopped watching /${board}/ No.${threadNo}.`
				: `/${board}/ No.${threadNo} wasn't being watched.`,
		);
	},
);

server.tool(
	"listWatches",
	"List watched 4chan threads, their status and filters.",
	async () => {
		const watches = Object.values(await loadWatches());
		if (watches.length === 0) {
			return textResult(
				"No threads are being watched. Use watchThread to add one.",
			);
		}
		const lines = watches.map(
			(w) =>
				`/${w.board}/ No.${w.threadNo} - ${w.subject} | ${w.status} | read up to No.${w.lastReadNo}${w.followedBy ? ` | followed by No.${w.followedBy}` : ""}${w.autoFollow === false ? " | no auto-follow" : ""}${w.myPosts?.length ? ` | your posts: ${w.myPosts.join(", ")}` : ""}${describeFilter(w.filter)}`,
		);
		return textResult(
			`Watching ${watches.length} thread(s) (state in ${WATCHES_FILE}):\n${lines.join("\n")}`,
		);
	},
);

interface ScanResult {
	watch: Watch;
	posts: Post[] | null;
	state: string;
	fresh: Post[];
	matched: Post[];
	notes: string[];
}

// Already-read posts that several of the new posts reply to: where the conversation is going, which a batch of
// replies alone doesn't show. Returns "" or a line to append to the thread header.
function drawingReplies(r: ScanResult, ctx: ReplyContext) {
	const counts = new Map<number, number>();
	for (const post of r.fresh) {
		for (const no of quotedNos(post)) {
			if (no <= r.watch.lastReadNo && no !== ctx.threadNo && ctx.byNo.has(no))
				counts.set(no, (counts.get(no) ?? 0) + 1);
		}
	}
	const hot = [...counts]
		.filter(([, n]) => n >= 2)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3);
	if (hot.length === 0) return "";
	return `\nEarlier posts drawing replies: ${hot
		.map(([no, n]) => {
			const post = ctx.byNo.get(no) as Post;
			return `No.${no} +${n} (↩${ctx.replyCounts.get(no)} total) "${excerpt(post, 50)}"`;
		})
		.join("; ")}`;
}

const WAIT_POLL_SECONDS = 15;
const MAX_WAIT_SECONDS = 300;

// One pass over the watched threads: fetch each, work out what's new and what matches its filter, and follow
// generals that have hit the bump limit or died to their successor (adding it as a new watch).
async function scanWatches(targets: Watch[]) {
	const catalogs = new Map<string, Thread[]>();
	const catalogFor = async (board: string) => {
		let catalog = catalogs.get(board);
		if (!catalog) {
			catalog = await fetchThreads(board);
			catalogs.set(board, catalog);
		}
		return catalog;
	};

	const results: ScanResult[] = [];
	const queue = [...targets];
	for (let watch = queue.shift(); watch; watch = queue.shift()) {
		const posts =
			watch.status === "deleted"
				? null
				: await fetchThreadOrNull(watch.board, watch.threadNo);
		const state = posts ? threadState(posts[0]) : "deleted";
		const lastReadNo = watch.lastReadNo;
		const fresh = posts ? posts.filter((p) => p.no > lastReadNo) : [];
		const result: ScanResult = {
			watch,
			posts,
			state,
			fresh,
			matched: fresh.filter((p) =>
				matchesFilter(p, watch.filter, watch.myPosts),
			),
			notes: [],
		};
		results.push(result);

		const ending = state !== "alive" || posts?.[0].bumplimit;
		if (!ending || watch.autoFollow === false || watch.followedBy) continue;

		const { chain } = followChain(
			await catalogFor(watch.board),
			watch.threadNo,
		);
		if (chain.length === 0) {
			result.notes.push(
				state === "alive"
					? "at bump limit; no successor yet"
					: `${state}; no successor found yet`,
			);
			continue;
		}
		const next = chain[chain.length - 1];
		const nextWatch: Watch = {
			board: watch.board,
			threadNo: next.no,
			subject: threadSubject(next),
			status: "alive",
			// Everything in the new thread is unread, OP included.
			lastReadNo: next.no - 1,
			filter: watch.filter,
			autoFollow: true,
			// Replies in the new thread can still quote the user's posts in the old one.
			myPosts: watch.myPosts,
			addedAt: new Date().toISOString(),
		};
		watch.followedBy = next.no;
		const oldKey = watchKey(watch.board, watch.threadNo);
		const added = await updateWatches((w) => {
			const old = w[oldKey];
			if (old) old.followedBy = next.no;
			const nextKey = watchKey(nextWatch.board, next.no);
			if (w[nextKey]) return false;
			w[nextKey] = nextWatch;
			return true;
		});
		result.notes.push(`now following No.${next.no} "${nextWatch.subject}"`);
		if (added) queue.push(nextWatch);
	}
	return results;
}

server.tool(
	"checkWatched",
	"Return posts that are new since the last check in watched threads (all of them, or one), and mark the returned posts read. Supports a minimum batch size, waiting briefly for posts, compact output, and follows generals to their next thread.",
	{
		board: z
			.string()
			.optional()
			.describe("Only check this board's watched thread (requires threadNo)"),
		threadNo: z.number().optional().describe("Only check this watched thread"),
		minNew: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				"Only return posts once at least this many new (filter-matching) posts are waiting in total; below that, return a one-line count and mark nothing read. Default 1.",
			),
		waitSeconds: z
			.number()
			.int()
			.min(0)
			.max(MAX_WAIT_SECONDS)
			.optional()
			.describe(
				`Hold the call for up to this many seconds (rechecking every ${WAIT_POLL_SECONDS}s) until minNew posts are waiting. Default 0. Keep it under your client's tool timeout.`,
			),
		...thumbnailSchema,
	},
	async ({
		board,
		threadNo,
		minNew = 1,
		waitSeconds = 0,
		format = "full",
		includeThumbnails = true,
		maxThumbnails = DEFAULT_MAX_THUMBNAILS,
		maxOutputTokens = DEFAULT_OUTPUT_BUDGET,
	}) => {
		const all = Object.values(await loadWatches());
		const targets =
			threadNo === undefined
				? all
				: all.filter(
						(w) =>
							w.threadNo === threadNo &&
							(board === undefined || w.board === board),
					);
		if (targets.length === 0) {
			return textResult(
				threadNo === undefined
					? "No threads are being watched."
					: `No.${threadNo} isn't being watched.`,
			);
		}

		const deadline = Date.now() + waitSeconds * 1000;
		let results = await scanWatches(targets);
		const countMatched = () =>
			results.reduce((n, r) => n + r.matched.length, 0);
		while (
			countMatched() < minNew &&
			Date.now() + WAIT_POLL_SECONDS * 1000 <= deadline
		) {
			await new Promise((resolve) =>
				setTimeout(resolve, WAIT_POLL_SECONDS * 1000),
			);
			const scanned = new Set(
				results.map((r) => watchKey(r.watch.board, r.watch.threadNo)),
			);
			const fresh = Object.values(await loadWatches()).filter((w) =>
				scanned.has(watchKey(w.board, w.threadNo)),
			);
			results = await scanWatches(fresh);
		}

		const label = (w: Watch) => `/${w.board}/ No.${w.threadNo}`;
		const noteLines = results.flatMap((r) =>
			r.notes.map((n) => `${label(r.watch)}: ${n}`),
		);
		const deadNotes = results
			.filter(
				(r) =>
					r.state !== "alive" && !r.watch.followedBy && r.notes.length === 0,
			)
			.map((r) => `${label(r.watch)}: ${r.state}. ${GONE_HINT}`);

		const persistState = async (r: ScanResult, readUpTo?: number) => {
			const key = watchKey(r.watch.board, r.watch.threadNo);
			await updateWatches((w) => {
				const entry = w[key];
				if (!entry) return;
				entry.status = r.state;
				if (readUpTo !== undefined) entry.lastReadNo = readUpTo;
				// A followed thread that's finished and fully read has nothing more to give.
				if (
					entry.followedBy &&
					r.state !== "alive" &&
					(readUpTo ?? entry.lastReadNo) >=
						(r.posts?.[r.posts.length - 1].no ?? 0)
				)
					delete w[key];
			});
		};

		const total = countMatched();
		if (total < minNew) {
			await Promise.all(results.map((r) => persistState(r)));
			const counts = results
				.filter((r) => r.fresh.length > 0)
				.map(
					(r) =>
						`${label(r.watch)} +${r.matched.length}${r.watch.filter ? `/${r.fresh.length}` : ""}`,
				);
			const head =
				total === 0 && counts.length === 0
					? `No new posts (${results.length} thread${results.length === 1 ? "" : "s"}).`
					: `Only ${total} new (min ${minNew}); nothing marked read. ${counts.join(", ")}`;
			return textResult([head, ...noteLines, ...deadNotes].join("\n"));
		}

		const content: Block[] = [];
		const summary: string[] = [];
		let budget = maxOutputTokens - 200;
		let thumbnailsLeft = maxThumbnails;
		for (const r of results) {
			const filtered = r.watch.filter
				? ` (${r.matched.length} match filter)`
				: "";
			if (r.matched.length === 0) {
				if (r.fresh.length > 0)
					summary.push(`${label(r.watch)}: ${r.fresh.length} new${filtered}`);
				await persistState(
					r,
					r.fresh.length ? r.fresh[r.fresh.length - 1].no : undefined,
				);
				continue;
			}
			if (budget < 1000 || (includeThumbnails && thumbnailsLeft <= 0)) {
				summary.push(
					`${label(r.watch)}: ${r.fresh.length} new${filtered}, not shown yet (page full); call checkWatched again`,
				);
				await persistState(r);
				continue;
			}
			// matched is non-empty, so the thread was fetched.
			const posts = r.posts as Post[];
			const ctx = replyContext(posts, r.matched, r.watch.myPosts);
			const header = `== ${label(r.watch)} "${r.watch.subject}": ${r.fresh.length} new${filtered}${drawingReplies(r, ctx)}`;
			const result = await budgetedContent({
				board: r.watch.board,
				header,
				items: r.matched,
				format: postFormatter(format, ctx),
				includeThumbnails,
				maxThumbnails: thumbnailsLeft,
				budget,
			});
			content.push(...result.content);
			budget -= result.used;
			thumbnailsLeft -= result.content.filter((c) => c.type === "image").length;
			// Mark read up to the last shown post; if everything matching was shown, also skip past trailing non-matches.
			const allShown = result.shownCount === r.matched.length;
			const readUpTo = allShown
				? r.fresh[r.fresh.length - 1].no
				: r.matched[result.shownCount - 1].no;
			summary.push(
				`${label(r.watch)}: ${r.fresh.length} new${filtered}${allShown ? "" : `, showing ${result.shownCount} (rest on the next check)`}`,
			);
			await persistState(r, readUpTo);
		}

		return {
			content: [
				{
					type: "text" as const,
					text: [...summary, ...noteLines, ...deadNotes].join("\n"),
				},
				...content,
			],
		};
	},
);

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error("4chan MCP Server running on stdio");
}

main().catch((error) => {
	console.error("Fatal error in main():", error);
	process.exit(1);
});
