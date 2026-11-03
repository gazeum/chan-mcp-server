# chan-mcp-server

An unofficial MCP Server for 4chan.

## Tools

Reading:

- `fetchBoards`: List 4chan boards
- `fetchThreads`: A board's catalog, with subject regex filter, sorting, and offset/limit paging
- `fetchPosts`: Posts from a thread, with `afterPostNo` for new replies, offset/limit (negative offset = latest posts), and name/tripcode/poster ID/reply filters. Shows posters, reply counts, (You)/(OP) marks and excerpts of quoted posts
- `fetchThumbnails`: Thumbnails for specific posts
- `fetchMedia`: A post's full image (downscaled if needed) or still frames from a video
- `findLatestInChain`: Follow a recurring general to its current thread via OP links

Polling:

- `threadStatus`: One-line status (state, page, posts until bump limit, posts/hour, suggested next check)
- `watchThread` / `unwatchThread` / `listWatches`: Subscribe to threads, with optional filters and auto-follow to the next general
- `addMyPosts`: Mark the user's own posts so replies to them are flagged (You) and always surface
- `checkWatched`: Unread posts across watched threads, with `minNew`, `waitSeconds` and compact output

Results are paged to stay under the client's tool-output limit, and thumbnails are attached by default. The server also sends usage instructions to the client.

Watch state is stored in `~/.chan-mcp-server/watches.json` (override with `CHAN_MCP_STATE_DIR`). `fetchMedia` needs `ffmpeg` and `ffprobe` on `PATH` for videos and oversized images.

## Usage

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chan-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "chan-mcp-server"
      ]
    }
  }
}
```

## Development

### Prerequisites

Use [mise](https://github.com/jdx/mise) to install Node.js and pnpm (recommended):

```bash
mise install
```

### Debug

Use [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to debug the server:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```
