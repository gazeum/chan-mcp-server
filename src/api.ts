interface Board {
	board: string;
	title: string;
	bump_limit?: number;
	pages?: number;
	per_page?: number;
}

interface Post {
	no: number;
	resto?: number;
	time: number;
	now?: string;
	name?: string;
	trip?: string;
	id?: string;
	capcode?: string;
	sub?: string;
	com?: string;
	tim?: number;
	filename?: string;
	ext?: string;
	fsize?: number;
	w?: number;
	h?: number;
	filedeleted?: number;
	replies?: number;
	images?: number;
	bumplimit?: number;
	closed?: number;
	archived?: number;
	archived_on?: number;
	sticky?: number;
	last_modified?: number;
}

// Catalog entries are OP posts plus a few catalog-only fields.
type Thread = Post;

interface CatalogPage {
	page: number;
	threads: Thread[];
}

interface ThreadIndexEntry {
	no: number;
	last_modified: number;
	replies: number;
	page: number;
}

async function fetchBoards() {
	const response = await fetch("https://a.4cdn.org/boards.json");
	if (!response.ok) {
		throw new Error(
			`Failed to fetch boards: ${response.status} ${response.statusText}`,
		);
	}

	const data = await response.json();
	return data.boards as Board[];
}

async function fetchThreads(board: string) {
	const response = await fetch(`https://a.4cdn.org/${board}/catalog.json`);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch threads for board ${board}: ${response.status} ${response.statusText}`,
		);
	}
	const data: CatalogPage[] = await response.json();
	const threads = data.flatMap((page) => page.threads);
	return threads;
}

async function fetchPosts(board: string, threadNo: number) {
	const response = await fetch(
		`https://a.4cdn.org/${board}/thread/${threadNo}.json`,
	);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch posts for thread No.${threadNo} on board ${board}: ${response.status} ${response.statusText}`,
		);
	}
	const data = await response.json();
	return data.posts as Post[];
}

// Like fetchPosts, but a deleted/pruned thread (404) returns null instead of throwing, so callers can report it plainly.
async function fetchThreadOrNull(board: string, threadNo: number) {
	const response = await fetch(
		`https://a.4cdn.org/${board}/thread/${threadNo}.json`,
	);
	if (response.status === 404) {
		return null;
	}
	if (!response.ok) {
		throw new Error(
			`Failed to fetch posts for thread No.${threadNo} on board ${board}: ${response.status} ${response.statusText}`,
		);
	}
	const data = await response.json();
	return data.posts as Post[];
}

// Lightweight board index: every thread's page, reply count and last_modified, without post bodies.
async function fetchThreadIndex(board: string) {
	const response = await fetch(`https://a.4cdn.org/${board}/threads.json`);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch thread index for board ${board}: ${response.status} ${response.statusText}`,
		);
	}
	const pages: { page: number; threads: Omit<ThreadIndexEntry, "page">[] }[] =
		await response.json();
	return pages.flatMap((page) =>
		page.threads.map(
			(thread): ThreadIndexEntry => ({ ...thread, page: page.page }),
		),
	);
}

async function fetchMedia(url: string) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch media ${url}: ${response.status} ${response.statusText}`,
		);
	}
	return Buffer.from(await response.arrayBuffer());
}

export {
	fetchBoards,
	fetchMedia,
	fetchPosts,
	fetchThreadIndex,
	fetchThreadOrNull,
	fetchThreads,
};
export type { Board, Post, Thread, ThreadIndexEntry };
